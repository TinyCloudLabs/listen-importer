import { basename } from "node:path";
import type { AppConfig } from "./config";
import { remoteKey } from "./config";
import type { ImporterStore, RecordingRow } from "./db";
import { audioSourceFor, type AudioSource } from "./downsample";
import type { ListenSource } from "./listen-source";
import type { TranscriptSegment } from "./transcription";
import { putKvFile, putKvString, sqlExecute, type TcOptions } from "./tc";

const IMPORTER_TABLE_SQL = `CREATE TABLE IF NOT EXISTS listen_importer_recording (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  recorder TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  recorded_at TEXT,
  local_source_path TEXT,
  media_kv_key TEXT NOT NULL,
  metadata_kv_key TEXT NOT NULL,
  transcript_kv_key TEXT,
  source_adapter TEXT,
  import_type TEXT,
  listen_source TEXT,
  source_id TEXT,
  artifact_kind TEXT,
  uploaded_at TEXT NOT NULL,
  transcribed_at TEXT,
  status TEXT NOT NULL
)`;

const CONVERSATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS conversation (
  id              TEXT PRIMARY KEY,
  title           TEXT,
  source          TEXT NOT NULL,
  source_id       TEXT,
  source_url      TEXT,
  started_at      TEXT,
  ended_at        TEXT,
  duration_secs   REAL,
  summary         TEXT,
  metadata        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
)`;

const PARTICIPANT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS participant (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  email           TEXT,
  speaker_label   TEXT
)`;

export interface UploadOptions extends TcOptions {
  publish?: boolean;
  useDownsampled?: boolean;
  transcriptsOnly?: boolean;
  listenSource?: ListenSource;
}

export interface UploadResult {
  uploaded: number;
  published: number;
  failed: number;
}

interface PublishedTranscriptSegment {
  index: number;
  speaker_id: string;
  speaker_name: string;
  text: string;
  start_time: number | null;
  end_time: number | null;
  language: string | null;
}

export async function uploadPending(
  config: AppConfig,
  store: ImporterStore,
  limit: number,
  options: UploadOptions,
): Promise<UploadResult> {
  if (options.transcriptsOnly && !options.publish) {
    throw new Error("--transcripts-only requires --publish");
  }
  if (!options.transcriptsOnly) ensureRemoteImporterSchema(config, options);
  if (options.publish)
    ensureConversationSchema(config, appSpaceOptions(config, options));

  const rows = store.pendingUpload(
    limit,
    Boolean(options.publish),
    options.listenSource,
  );
  const result: UploadResult = { uploaded: 0, published: 0, failed: 0 };

  for (const row of rows) {
    try {
      const audio =
        row.artifact_kind === "audio"
          ? audioSourceFor(row, Boolean(options.useDownsampled))
          : null;
      if (options.transcriptsOnly) {
        const conversationId = await publishConversation(
          config,
          row,
          audio,
          null,
          null,
          null,
          options,
        );
        store.markPublished(row.id, conversationId);
        result.published += 1;
        continue;
      }

      const mediaKey = audio ? mediaKeyFor(config, row, audio) : null;
      const metadataKey = metadataKeyFor(config, row);
      const transcriptImportKey = row.transcript_path
        ? transcriptImportKeyFor(config, row)
        : null;
      const metadata = metadataFor(
        row,
        audio,
        mediaKey,
        metadataKey,
        transcriptImportKey,
      );

      if (audio && mediaKey) putKvFile(mediaKey, audio.path, options);
      if (row.transcript_path && transcriptImportKey) {
        putKvFile(transcriptImportKey, row.transcript_path, options);
        store.markTranscriptUploaded(row.id, transcriptImportKey);
      }
      putKvString(metadataKey, JSON.stringify(metadata), options);
      insertRemoteImporterRow(
        config,
        row,
        audio,
        mediaKey,
        metadataKey,
        transcriptImportKey,
        options,
      );
      store.markUploaded(row.id, mediaKey, metadataKey);
      result.uploaded += 1;

      if (options.publish) {
        const conversationId = await publishConversation(
          config,
          row,
          audio,
          mediaKey,
          metadataKey,
          transcriptImportKey,
          options,
        );
        store.markPublished(row.id, conversationId);
        result.published += 1;
      }
    } catch (err) {
      result.failed += 1;
      store.markFailed(
        row.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}

function ensureRemoteImporterSchema(
  config: AppConfig,
  options: TcOptions,
): void {
  sqlExecute(config.listenSqlDb, IMPORTER_TABLE_SQL, [], options);
}

function ensureConversationSchema(config: AppConfig, options: TcOptions): void {
  sqlExecute(config.listenSqlDb, CONVERSATION_TABLE_SQL, [], options);
  sqlExecute(config.listenSqlDb, PARTICIPANT_TABLE_SQL, [], options);
}

function insertRemoteImporterRow(
  config: AppConfig,
  row: RecordingRow,
  audio: AudioSource | null,
  mediaKey: string | null,
  metadataKey: string,
  transcriptImportKey: string | null,
  options: TcOptions,
): void {
  sqlExecute(
    config.listenSqlDb,
    `INSERT OR REPLACE INTO listen_importer_recording (
      id, file_name, recorder, sha256, size_bytes, content_type, recorded_at,
      local_source_path, media_kv_key, metadata_kv_key, transcript_kv_key,
      uploaded_at, transcribed_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.file_name,
      row.recorder,
      row.sha256,
      audio?.sizeBytes ?? row.size_bytes,
      audio?.contentType ?? row.content_type,
      row.recorded_at,
      row.source_path,
      mediaKey ?? "",
      metadataKey,
      transcriptImportKey,
      new Date().toISOString(),
      row.transcribed_at,
      "uploaded",
    ],
    options,
  );
}

async function publishConversation(
  config: AppConfig,
  row: RecordingRow,
  audio: AudioSource | null,
  mediaKey: string | null,
  metadataKey: string | null,
  transcriptImportKey: string | null,
  options: TcOptions,
): Promise<string> {
  const conversationId = conversationIdFor(row);
  const now = new Date().toISOString();
  const startedAt = row.recorded_at ?? row.modified_at ?? now;
  const endedAt = row.duration_secs
    ? addSeconds(startedAt, row.duration_secs)
    : null;
  const transcript = await loadTranscript(row);
  const metadata = {
    import_type: row.import_type,
    source_adapter: row.source_adapter,
    listen_source: row.listen_source,
    importer: "listen-importer",
    importer_recording_id: row.id,
    source_id: row.source_id,
    source_uri: row.source_uri,
    artifact_kind: row.artifact_kind,
    original_file_name: row.file_name,
    original_source_path: row.source_path,
    audio_kv_key: mediaKey,
    audio_metadata_kv_key: metadataKey,
    audio_source_kind: audio?.kind ?? null,
    transcript_kv_key: transcriptImportKey,
    transcription_provider: row.transcription_provider,
    transcribed_at: row.transcribed_at,
    audio_content_type: audio?.contentType ?? null,
    audio_size_bytes: audio?.sizeBytes ?? null,
    original_audio_content_type: row.content_type,
    original_audio_size_bytes: row.size_bytes,
    downsampled_audio_path: row.downsampled_path,
    downsampled_audio_size_bytes: row.downsampled_size_bytes,
    sha256: row.sha256,
    recorder: row.recorder,
    source_metadata: parseMetadata(row.metadata_json),
  };

  const conversationTranscriptKey = remoteKey(
    config,
    `transcript/${conversationId}`,
  );
  const appOptions = appSpaceOptions(config, options);
  putKvString(
    conversationTranscriptKey,
    `${JSON.stringify(transcript, null, 2)}\n`,
    appOptions,
  );
  sqlExecute(
    config.listenSqlDb,
    `INSERT OR REPLACE INTO conversation (
      id, title, source, source_id, source_url, started_at, ended_at, duration_secs,
      summary, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      conversationId,
      titleFor(row),
      row.listen_source,
      sourceIdFor(row),
      null,
      startedAt,
      endedAt,
      row.duration_secs,
      null,
      JSON.stringify(metadata),
      now,
      now,
    ],
    appOptions,
  );
  insertParticipants(config, conversationId, transcript, appOptions);
  return conversationId;
}

function metadataFor(
  row: RecordingRow,
  audio: AudioSource | null,
  mediaKey: string | null,
  metadataKey: string,
  transcriptKey: string | null,
) {
  return {
    id: row.id,
    sourceAdapter: row.source_adapter,
    importType: row.import_type,
    listenSource: row.listen_source,
    sourceId: row.source_id,
    sourceUri: row.source_uri,
    title: row.title,
    artifactKind: row.artifact_kind,
    fileName: row.file_name,
    recorder: row.recorder,
    sha256: row.sha256,
    sizeBytes: audio?.sizeBytes ?? row.size_bytes,
    contentType: audio?.contentType ?? row.content_type,
    mediaSourceKind: audio?.kind ?? null,
    originalSizeBytes: row.size_bytes,
    originalContentType: row.content_type,
    downsampledPath: row.downsampled_path,
    downsampledSizeBytes: row.downsampled_size_bytes,
    recordedAt: row.recorded_at,
    modifiedAt: row.modified_at,
    sourcePath: row.source_path,
    localPath: row.local_path,
    mediaKvKey: mediaKey,
    metadataKvKey: metadataKey,
    transcriptKvKey: transcriptKey,
    transcriptionProvider: row.transcription_provider,
    transcribedAt: row.transcribed_at,
    durationSecs: row.duration_secs,
    sourceMetadata: parseMetadata(row.metadata_json),
    uploadedAt: new Date().toISOString(),
  };
}

function mediaKeyFor(
  config: AppConfig,
  row: RecordingRow,
  audio: AudioSource,
): string {
  return remoteKey(
    config,
    `importer/media/${row.sha256.slice(0, 2)}/${row.sha256}${audio.extension}`,
  );
}

function metadataKeyFor(config: AppConfig, row: RecordingRow): string {
  return remoteKey(config, `importer/metadata/${row.sha256}.json`);
}

function transcriptImportKeyFor(config: AppConfig, row: RecordingRow): string {
  return remoteKey(config, `importer/transcripts/${row.sha256}.json`);
}

function titleFor(row: RecordingRow): string {
  if (row.title?.trim()) return row.title.trim();
  const stem = basename(row.file_name, row.extension).replace(/[_-]+/g, " ");
  return stem.trim() || row.file_name;
}

function sourceIdFor(row: RecordingRow): string {
  return `${row.source_adapter}:${row.source_id ?? row.sha256}`;
}

function conversationIdFor(row: RecordingRow): string {
  const prefix =
    row.listen_source === "voice_memos"
      ? "vm"
      : row.listen_source === "voxterm"
        ? "vox"
        : row.listen_source === "soundcore_sync"
          ? "sc"
          : "rec";
  return `${prefix}-${row.sha256.slice(0, 24)}`;
}

function parseMetadata(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function loadTranscript(
  row: RecordingRow,
): Promise<PublishedTranscriptSegment[]> {
  if (!row.transcript_path) return [];
  const raw = await Bun.file(row.transcript_path).text();
  const parsed = JSON.parse(raw) as TranscriptSegment[];
  return Array.isArray(parsed) ? normalizeTranscriptSegments(parsed) : [];
}

function insertParticipants(
  config: AppConfig,
  conversationId: string,
  transcript: PublishedTranscriptSegment[],
  options: TcOptions,
): void {
  const speakers = Array.from(
    new Set(transcript.map((segment) => segment.speaker_name).filter(Boolean)),
  );
  sqlExecute(
    config.listenSqlDb,
    `DELETE FROM participant WHERE conversation_id = ?`,
    [conversationId],
    options,
  );
  for (let index = 0; index < speakers.length; index += 1) {
    const speaker = speakers[index]!;
    sqlExecute(
      config.listenSqlDb,
      `INSERT OR REPLACE INTO participant (id, conversation_id, name, email, speaker_label)
       VALUES (?, ?, ?, ?, ?)`,
      [
        `${conversationId}-speaker-${index + 1}`,
        conversationId,
        speaker,
        null,
        String(index + 1),
      ],
      options,
    );
  }
}

function normalizeTranscriptSegments(
  transcript: TranscriptSegment[],
): PublishedTranscriptSegment[] {
  return transcript
    .map((segment, index) => {
      const text = typeof segment.text === "string" ? segment.text.trim() : "";
      if (!text) return null;
      const speakerName =
        typeof segment.speaker_name === "string" &&
        segment.speaker_name.trim().length > 0
          ? segment.speaker_name.trim()
          : "Speaker";

      return {
        index,
        speaker_id: speakerIdFor(speakerName, index),
        speaker_name: speakerName,
        text,
        start_time: numberOrNull(segment.start_time),
        end_time: numberOrNull(segment.end_time),
        language:
          typeof segment.language === "string" && segment.language.length > 0
            ? segment.language
            : null,
      };
    })
    .filter(
      (segment): segment is PublishedTranscriptSegment => segment !== null,
    );
}

function speakerIdFor(speakerName: string, index: number): string {
  return (
    speakerName.toLowerCase().replace(/[^a-z0-9]+/g, "-") ||
    `speaker-${index + 1}`
  );
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function appSpaceOptions(
  config: Pick<AppConfig, "listenAppSpace">,
  options: TcOptions,
): TcOptions {
  return { ...options, space: config.listenAppSpace };
}

function addSeconds(iso: string, seconds: number): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + seconds * 1000).toISOString();
}
