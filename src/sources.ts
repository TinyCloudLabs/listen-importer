import Database from "better-sqlite3";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import {
  AUDIO_EXTENSIONS,
  contentTypeForExtension,
  recordedAtFromName,
  type RecorderFile,
  type TranscriptSegment,
} from "./media";

export type ImportSource = "voice-memos" | "voxterm" | "soundcore-sync";

export interface ScanSourceOptions {
  since: Date;
  path?: string;
  includeDeleted?: boolean;
}

interface FileCandidate {
  path: string;
  fileName: string;
  extension: string;
  contentType: string;
  sizeBytes: number;
  recordedAt: string | null;
  modifiedAt: string;
}

interface VoiceMemoMetadata {
  sourceId: string | null;
  title: string | null;
  recordedAt: string | null;
  durationSecs: number | null;
  filePath: string | null;
  isDeleted: boolean;
}

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const VOICE_MEMOS_DELETED_FLAG = 1024;
const VOXTERM_DEFAULT_DIR = join(homedir(), "Documents", "voxterm-transcripts");
const SOUNDCORE_SYNC_DEFAULT_DIR = join(
  homedir(),
  "Documents",
  "Soundcore-Transcripts",
);
const SOUNDCORE_EMPTY_RE = /_\(No transcript segments available\.\)_/;
const SOUNDCORE_TURN_LABEL_RE = /^\*\*([^*\n]+?)\s*:\s*\*\*\s*$/;

export async function scanImportSource(
  source: ImportSource,
  options: ScanSourceOptions,
): Promise<RecorderFile[]> {
  if (source === "voice-memos") return scanVoiceMemos(options);
  if (source === "voxterm") return scanVoxTerm(options);
  if (source === "soundcore-sync") return scanSoundcoreSync(options);
  throw new Error(`Unsupported source: ${source}`);
}

export function parseImportSource(value: string | undefined): ImportSource {
  if (
    value === "voice-memos" ||
    value === "voxterm" ||
    value === "soundcore-sync"
  )
    return value;
  if (value === "soundcore_sync") return "soundcore-sync";
  throw new Error(
    "scan-source requires voice-memos, voxterm, or soundcore-sync",
  );
}

export function parseSince(value: string | undefined, now = new Date()): Date {
  if (!value) return localMidnightDaysAgo(7, now);
  if (value === "yesterday") return localMidnightDaysAgo(1, now);

  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
      0,
      0,
      0,
      0,
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("--since must be yesterday, YYYY-MM-DD, or an ISO date");
  }
  return parsed;
}

export function formatSince(date: Date): string {
  return date.toISOString();
}

async function scanVoiceMemos(
  options: ScanSourceOptions,
): Promise<RecorderFile[]> {
  const roots = voiceMemoRoots(options.path);
  const allFiles: RecorderFile[] = [];
  let permissionError: Error | null = null;

  for (const root of roots) {
    try {
      const files = await listAudioFiles(root);
      const metadata = await voiceMemoMetadata(root);
      for (const file of files) {
        const memo = metadataForFile(metadata, file.path);
        if (!options.includeDeleted && memo?.isDeleted) continue;
        const recordedAt =
          memo?.recordedAt ??
          file.recordedAt ??
          recordedAtFromName(file.fileName);
        if (!isOnOrAfter(recordedAt, options.since)) continue;
        allFiles.push({
          sourcePath: file.path,
          fileName: file.fileName,
          extension: file.extension,
          contentType: file.contentType,
          sourceAdapter: "macos-voice-memos",
          importType: "voice-memo-audio",
          listenSource: "voice_memos",
          sourceId: memo?.sourceId ?? `voice-memos:${file.fileName}`,
          sourceUri: file.path,
          title: memo?.title ?? basename(file.fileName, file.extension),
          artifactKind: "audio",
          metadataJson: JSON.stringify({
            source_app: "Voice Memos",
            library_path: root,
            duration_secs: memo?.durationSecs ?? null,
          }),
          transcriptText: null,
          durationSecs: memo?.durationSecs ?? null,
          recorder: "voice-memos",
          sizeBytes: file.sizeBytes,
          recordedAt,
          modifiedAt: file.modifiedAt,
        });
      }
    } catch (err) {
      if (isPermissionError(err)) permissionError = err as Error;
      if (options.path) throw voiceMemosAccessError(root, err);
    }
  }

  if (allFiles.length === 0 && permissionError) {
    throw voiceMemosAccessError(
      roots[0] ?? "Voice Memos library",
      permissionError,
    );
  }

  return dedupeBySource(allFiles).sort(compareRecorded);
}

async function scanVoxTerm(
  options: ScanSourceOptions,
): Promise<RecorderFile[]> {
  const root = resolve(
    options.path ?? process.env.LISTEN_VOXTERM_DIR ?? VOXTERM_DEFAULT_DIR,
  );
  const files = await listFiles(
    root,
    (path) => extname(path).toLowerCase() === ".md",
  );
  const rows: RecorderFile[] = [];

  for (const path of files) {
    if (path.split(/[\\/]/).some((part) => part.startsWith("."))) continue;
    const stats = await stat(path);
    const raw = await readFile(path, "utf8");
    const recordedAt =
      voxTermStartedAt(path, raw) ?? stats.birthtime?.toISOString() ?? null;
    if (!isOnOrAfter(recordedAt, options.since)) continue;
    const segments = parseVoxTermSegments(raw);
    const transcriptText = segments.map((segment) => segment.text).join("\n");
    const fileName = basename(path);

    rows.push({
      sourcePath: path,
      fileName,
      extension: ".md",
      contentType: "text/markdown",
      sourceAdapter: "voxterm",
      importType: "voxterm-transcript",
      listenSource: "voxterm",
      sourceId: `voxterm:${relative(root, path)}`,
      sourceUri: path,
      title: basename(fileName, ".md").replace(/[_-]+/g, " "),
      artifactKind: "transcript",
      metadataJson: JSON.stringify({
        source_app: "VoxTerm",
        transcripts_root: root,
      }),
      transcriptSegments: segments,
      transcriptText,
      durationSecs: null,
      recorder: "voxterm",
      sizeBytes: stats.size,
      recordedAt,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  return rows.sort(compareRecorded);
}

async function scanSoundcoreSync(
  options: ScanSourceOptions,
): Promise<RecorderFile[]> {
  const root = resolve(
    options.path ??
      process.env.LISTEN_SOUNDCORE_SYNC_DIR ??
      SOUNDCORE_SYNC_DEFAULT_DIR,
  );
  const files = await listFiles(
    root,
    (path) => extname(path).toLowerCase() === ".md",
  );
  const rows: RecorderFile[] = [];

  for (const path of files) {
    if (path.split(/[\\/]/).some((part) => part.startsWith("."))) continue;
    const stats = await stat(path);
    const raw = await Bun.file(path).text();
    const parsed = parseSoundcoreSyncMarkdown(raw, path);
    const recordedAt =
      parsed.recordedAt ??
      recordedAtFromName(basename(path)) ??
      stats.birthtime?.toISOString() ??
      null;
    if (!isOnOrAfter(recordedAt, options.since)) continue;
    const fileName = basename(path);
    const relativePath = relative(root, path);

    rows.push({
      sourcePath: path,
      fileName,
      extension: ".md",
      contentType: "text/markdown",
      sourceAdapter: "soundcore-sync",
      importType: "soundcore-transcript",
      listenSource: "soundcore_sync",
      sourceId: `soundcore-sync:${relativePath}`,
      sourceUri: path,
      title: parsed.title ?? basename(fileName, ".md").replace(/[_-]+/g, " "),
      artifactKind: "transcript",
      metadataJson: JSON.stringify({
        source_app: "Soundcore",
        source_adapter: "soundcore-sync",
        transcripts_root: root,
        source_file: relativePath,
        summary: parsed.summary,
        has_transcript: parsed.segments.length > 0,
        empty_transcript: parsed.empty,
      }),
      transcriptSegments: parsed.segments,
      transcriptText: parsed.segments.map((segment) => segment.text).join("\n"),
      durationSecs: parsed.durationSecs,
      recorder: "soundcore-sync",
      sizeBytes: stats.size,
      recordedAt,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  return rows.sort(compareRecorded);
}

function voiceMemoRoots(pathOverride: string | undefined): string[] {
  if (pathOverride) return [resolve(pathOverride)];
  const envPath = process.env.LISTEN_VOICE_MEMOS_LIBRARY;
  if (envPath) return [resolve(envPath)];

  return [
    join(
      homedir(),
      "Library",
      "Group Containers",
      "group.com.apple.VoiceMemos.shared",
      "Recordings",
    ),
    join(
      homedir(),
      "Library",
      "Application Support",
      "com.apple.voicememos",
      "Recordings",
    ),
    join(
      homedir(),
      "Library",
      "Containers",
      "com.apple.VoiceMemos",
      "Data",
      "Library",
      "Application Support",
      "com.apple.voicememos",
      "Recordings",
    ),
  ];
}

async function listAudioFiles(root: string): Promise<FileCandidate[]> {
  const paths = await listFiles(root, (path) =>
    AUDIO_EXTENSIONS.has(extname(path).toLowerCase()),
  );
  const files: FileCandidate[] = [];
  for (const path of paths) {
    const stats = await stat(path);
    const extension = extname(path).toLowerCase();
    files.push({
      path,
      fileName: basename(path),
      extension,
      contentType: contentTypeForExtension(extension),
      sizeBytes: stats.size,
      recordedAt: stats.birthtime?.toISOString() ?? null,
      modifiedAt: stats.mtime.toISOString(),
    });
  }
  return files;
}

async function listFiles(
  root: string,
  predicate: (path: string) => boolean,
): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile() && predicate(path)) found.push(path);
    }
  }

  await walk(root);
  return found.sort();
}

async function voiceMemoMetadata(root: string): Promise<VoiceMemoMetadata[]> {
  const searchRoots = Array.from(
    new Set([
      root,
      ...(basename(root).toLowerCase() === "recordings" ? [dirname(root)] : []),
    ]),
  );
  const dbPaths: string[] = [];
  for (const searchRoot of searchRoots) {
    try {
      dbPaths.push(
        ...(await listFiles(searchRoot, (path) => {
          const lower = basename(path).toLowerCase();
          return lower.endsWith(".db") || lower.endsWith(".sqlite");
        })),
      );
    } catch {
      // Metadata is best-effort; the audio scan remains the source of truth.
    }
  }

  const rows: VoiceMemoMetadata[] = [];
  for (const dbPath of Array.from(new Set(dbPaths))) {
    rows.push(...readVoiceMemoDatabase(dbPath, root));
  }
  return rows;
}

function readVoiceMemoDatabase(
  dbPath: string,
  audioRoot: string,
): VoiceMemoMetadata[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string }>;
    const rows: VoiceMemoMetadata[] = [];
    for (const table of tables) {
      const columns = db
        .prepare(`PRAGMA table_info(${quoteIdent(table.name)})`)
        .all() as Array<{
        name: string;
      }>;
      if (!looksLikeVoiceMemoTable(columns)) continue;
      const records = db
        .prepare(`SELECT * FROM ${quoteIdent(table.name)}`)
        .all() as Array<Record<string, unknown>>;
      for (const record of records) {
        const metadata = metadataFromRecord(record, audioRoot);
        if (metadata) rows.push(metadata);
      }
    }
    return rows;
  } finally {
    db.close();
  }
}

function looksLikeVoiceMemoTable(columns: Array<{ name: string }>): boolean {
  const names = columns.map((column) => column.name.toLowerCase());
  const hasDate = names.some(
    (name) => name.includes("date") || name.includes("time"),
  );
  const hasAudio =
    names.some(
      (name) =>
        name.includes("path") || name.includes("file") || name.includes("url"),
    ) || names.some((name) => name.includes("duration"));
  return hasDate && hasAudio;
}

function metadataFromRecord(
  record: Record<string, unknown>,
  audioRoot: string,
): VoiceMemoMetadata | null {
  const filePath = findString(record, ["path", "file", "url", "asset"]);
  const recordedAt = findDate(record, [
    "date",
    "created",
    "creation",
    "timestamp",
    "time",
  ]);
  const sourceId = findString(record, [
    "unique",
    "uuid",
    "identifier",
    "recordingid",
    "cloudid",
  ]);
  const title = findString(record, ["title", "label", "name"]);
  const durationSecs = findNumber(record, ["duration"]);
  if (!filePath && !recordedAt && !sourceId && !title) return null;

  return {
    sourceId,
    title,
    recordedAt,
    durationSecs,
    filePath: resolveVoiceMemoPath(filePath, audioRoot),
    isDeleted: isDeletedVoiceMemoRecord(record),
  };
}

function isDeletedVoiceMemoRecord(record: Record<string, unknown>): boolean {
  const flags = findNumber(record, ["flags"]);
  if (flags !== null && (flags & VOICE_MEMOS_DELETED_FLAG) !== 0) return true;

  for (const [key, value] of Object.entries(record)) {
    const lower = key.toLowerCase();
    if (!lower.includes("delet") && !lower.includes("trash")) continue;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "boolean") return value;
  }

  return false;
}

function metadataForFile(
  metadata: VoiceMemoMetadata[],
  path: string,
): VoiceMemoMetadata | null {
  const name = basename(path);
  return (
    metadata.find((row) => row.filePath === path) ??
    metadata.find((row) => row.filePath && basename(row.filePath) === name) ??
    null
  );
}

function parseVoxTermSegments(raw: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const withSpeaker = line.match(
      /^\*\*\[(\d{2}:\d{2}:\d{2})\]\*\* \*\*([^:]+):\*\* (.+)$/,
    );
    if (withSpeaker) {
      segments.push({
        speaker_name: withSpeaker[2]!.trim(),
        text: withSpeaker[3]!.trim(),
        start_time: null,
        end_time: null,
      });
      continue;
    }
    const withoutSpeaker = line.match(/^\*\*\[(\d{2}:\d{2}:\d{2})\]\*\* (.+)$/);
    if (withoutSpeaker) {
      segments.push({
        speaker_name: "Unknown",
        text: withoutSpeaker[2]!.trim(),
        start_time: null,
        end_time: null,
      });
    }
  }

  if (segments.length > 0) return segments;
  const text = raw.trim();
  return text
    ? [{ speaker_name: "Unknown", text, start_time: null, end_time: null }]
    : [];
}

function parseSoundcoreSyncMarkdown(
  raw: string,
  path: string,
): {
  title: string | null;
  recordedAt: string | null;
  durationSecs: number | null;
  summary: string | null;
  segments: TranscriptSegment[];
  empty: boolean;
} {
  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const dateValue = raw.match(/^\*\*Date:\*\*\s*(.+)$/m)?.[1]?.trim() ?? null;
  const durationValue =
    raw.match(/^\*\*Duration:\*\*\s*(.+)$/m)?.[1]?.trim() ?? null;
  const recordedAt = dateValue ? dateOnlyToIso(dateValue) : null;
  const durationSecs = parseDurationSecs(durationValue);
  const transcriptMatch = raw.match(/^##\s+Transcript\s*$/m);
  const transcriptIndex = transcriptMatch?.index ?? -1;
  const beforeTranscript = transcriptMatch
    ? raw.slice(0, transcriptIndex)
    : raw;
  const summary = soundcoreSummary(beforeTranscript);
  const transcriptRegion = transcriptMatch
    ? raw.slice(transcriptIndex + transcriptMatch[0].length)
    : "";
  const segments = parseSoundcoreTranscriptRegion(transcriptRegion);
  const empty =
    segments.length === 0 &&
    (SOUNDCORE_EMPTY_RE.test(transcriptRegion) ||
      transcriptRegion.trim().length === 0);

  if (!title && !dateValue && !transcriptMatch) {
    return {
      title: basename(path, extname(path)).replace(/[_-]+/g, " "),
      recordedAt: null,
      durationSecs: null,
      summary: null,
      segments: [],
      empty: true,
    };
  }

  return { title, recordedAt, durationSecs, summary, segments, empty };
}

function soundcoreSummary(beforeTranscript: string): string | null {
  const lines = beforeTranscript
    .split(/\r?\n/)
    .filter((line) => !/^#\s+/.test(line))
    .filter((line) => !/^\*\*(Date|Duration):\*\*/i.test(line));
  const summary = lines.join("\n").trim();
  return summary.length > 0 ? summary : null;
}

function parseSoundcoreTranscriptRegion(region: string): TranscriptSegment[] {
  const withoutEmptySentinel = region.replace(
    new RegExp(SOUNDCORE_EMPTY_RE.source, "g"),
    "",
  );
  const turns: Array<{ speaker: string; lines: string[] }> = [];

  for (const line of withoutEmptySentinel.split(/\r?\n/)) {
    if (/^##\s+Transcript\s*$/.test(line)) continue;
    const label = SOUNDCORE_TURN_LABEL_RE.exec(line);
    if (label?.[1] !== undefined) {
      turns.push({ speaker: label[1].trim() || "Speaker", lines: [] });
      continue;
    }
    if (turns.length > 0) turns[turns.length - 1]!.lines.push(line);
  }

  return turns
    .map<TranscriptSegment | null>((turn) => {
      const text = turn.lines.join("\n").trim();
      if (!text) return null;
      return {
        speaker_name: turn.speaker,
        text,
        start_time: null,
        end_time: null,
      };
    })
    .filter((segment): segment is TranscriptSegment => segment !== null);
}

function dateOnlyToIso(value: string): string | null {
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return new Date(
      Date.UTC(
        Number(dateOnly[1]),
        Number(dateOnly[2]) - 1,
        Number(dateOnly[3]),
      ),
    ).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseDurationSecs(value: string | null): number | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  const hours = lower.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/);
  const minutes = lower.match(
    /(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/,
  );
  const seconds = lower.match(
    /(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/,
  );
  const total =
    (hours ? Number(hours[1]) * 3600 : 0) +
    (minutes ? Number(minutes[1]) * 60 : 0) +
    (seconds ? Number(seconds[1]) : 0);
  if (total > 0 && Number.isFinite(total)) return total;

  const bare = Number(lower.replace(/[^0-9.]/g, ""));
  return Number.isFinite(bare) && bare > 0 ? bare * 60 : null;
}

function voxTermStartedAt(path: string, raw: string): string | null {
  const fromName = recordedAtFromName(basename(path));
  if (fromName) return fromName;

  const dateMatch = raw.match(/- \*\*Date:\*\* (.+)$/m);
  const startedMatch = raw.match(/- \*\*Started:\*\* (.+)$/m);
  if (!dateMatch) return null;
  const parsed = new Date(`${dateMatch[1]} ${startedMatch?.[1] ?? "12:00 AM"}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isOnOrAfter(iso: string | null, since: Date): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.getTime() >= since.getTime();
}

function compareRecorded(a: RecorderFile, b: RecorderFile): number {
  return (a.recordedAt ?? a.modifiedAt).localeCompare(
    b.recordedAt ?? b.modifiedAt,
  );
}

function dedupeBySource(files: RecorderFile[]): RecorderFile[] {
  const seen = new Set<string>();
  const result: RecorderFile[] = [];
  for (const file of files) {
    const key = `${file.sourceAdapter}:${file.sourceId ?? file.sourcePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(file);
  }
  return result;
}

function localMidnightDaysAgo(days: number, now: Date): Date {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - days,
    0,
    0,
    0,
    0,
  );
}

function findString(
  record: Record<string, unknown>,
  needles: string[],
): string | null {
  for (const [key, value] of Object.entries(record)) {
    const lower = key.toLowerCase();
    if (!needles.some((needle) => lower.includes(needle))) continue;
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function findNumber(
  record: Record<string, unknown>,
  needles: string[],
): number | null {
  for (const [key, value] of Object.entries(record)) {
    const lower = key.toLowerCase();
    if (!needles.some((needle) => lower.includes(needle))) continue;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function findDate(
  record: Record<string, unknown>,
  needles: string[],
): string | null {
  for (const [key, value] of Object.entries(record)) {
    const lower = key.toLowerCase();
    if (!needles.some((needle) => lower.includes(needle))) continue;
    const iso = coerceDate(value);
    if (iso) return iso;
  }
  return null;
}

function coerceDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 10_000_000_000) return new Date(value).toISOString();
    if (value > 1_000_000_000) return new Date(value * 1000).toISOString();
    return new Date(APPLE_EPOCH_MS + value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function resolveVoiceMemoPath(
  value: string | null,
  audioRoot: string,
): string | null {
  if (!value) return null;
  const cleaned = decodeURIComponent(value.replace(/^file:\/\//, ""));
  if (cleaned.startsWith("/")) return cleaned;
  return resolve(audioRoot, cleaned.replace(/^Recordings[\\/]/, ""));
}

function isPermissionError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /EACCES|EPERM|Operation not permitted/.test(err.message)
  );
}

function voiceMemosAccessError(path: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(
    `Unable to read Voice Memos library at ${path}: ${detail}. Grant Full Disk Access or pass --path to a readable Voice Memos library copy.`,
  );
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
