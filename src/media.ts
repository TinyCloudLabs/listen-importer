import { createHash } from "node:crypto";
import { mkdir, readdir, stat, copyFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AppConfig } from "./config";

export const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".wav",
]);

const SKIP_DIRS = new Set([
  ".Spotlight-V100",
  ".Trashes",
  ".fseventsd",
  "System Volume Information",
]);

export interface RecorderFile {
  sourcePath: string;
  fileName: string;
  extension: string;
  contentType: string;
  recorder: string;
  sizeBytes: number;
  recordedAt: string | null;
  modifiedAt: string;
}

export interface ClonedRecording extends RecorderFile {
  id: string;
  sha256: string;
  localPath: string;
}

export async function scanRecorder(
  rootPath: string,
  recorder = detectRecorder(rootPath),
): Promise<RecorderFile[]> {
  const files: RecorderFile[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;
      if (entry.name.startsWith("._")) continue;
      const sourcePath = join(dir, entry.name);
      const extension = extname(entry.name).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(extension)) continue;

      const stats = await stat(sourcePath);
      files.push({
        sourcePath,
        fileName: entry.name,
        extension,
        contentType: contentTypeForExtension(extension),
        recorder,
        sizeBytes: stats.size,
        recordedAt:
          recordedAtFromName(entry.name) ??
          stats.birthtime?.toISOString() ??
          null,
        modifiedAt: stats.mtime.toISOString(),
      });
    }
  }

  await walk(rootPath);
  return files.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

export async function cloneRecording(
  config: AppConfig,
  file: RecorderFile,
): Promise<ClonedRecording> {
  const sha256 = await hashFile(file.sourcePath);
  const shard = sha256.slice(0, 2);
  const localDir = join(config.mediaDir, shard);
  const localPath = join(localDir, `${sha256}${file.extension}`);

  await mkdir(localDir, { recursive: true });
  await copyFile(file.sourcePath, localPath);

  return {
    ...file,
    id: sha256,
    sha256,
    localPath,
  };
}

export function detectRecorder(pathValue: string): string {
  const name = basename(pathValue)
    .toLowerCase()
    .replace(/[_\s-]+/g, " ");
  if (name.includes("mic mini")) return "mic-mini";
  if (name.includes("dji")) return "dji";
  if (name.includes("zoom")) return "zoom";
  if (name.includes("tascam")) return "tascam";
  return "generic";
}

export function contentTypeForExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case ".aac":
      return "audio/aac";
    case ".aif":
    case ".aiff":
      return "audio/aiff";
    case ".flac":
      return "audio/flac";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

export function recordedAtFromName(fileName: string): string | null {
  const compact = fileName.match(
    /(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/,
  );
  if (compact) {
    return toIso(
      Number(compact[1]),
      Number(compact[2]),
      Number(compact[3]),
      Number(compact[4]),
      Number(compact[5]),
      Number(compact[6]),
    );
  }

  const separated = fileName.match(
    /(20\d{2})[-_.](\d{2})[-_.](\d{2})[ T_-](\d{2})[-_.:](\d{2})(?:[-_.:](\d{2}))?/,
  );
  if (separated) {
    return toIso(
      Number(separated[1]),
      Number(separated[2]),
      Number(separated[3]),
      Number(separated[4]),
      Number(separated[5]),
      Number(separated[6] ?? 0),
    );
  }

  return null;
}

async function hashFile(pathValue: string): Promise<string> {
  const hash = createHash("sha256");
  const file = Bun.file(pathValue);
  const stream = file.stream();

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

function toIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
) {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
