import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config";
import type { ImporterStore, RecordingRow } from "./db";

export type DownsampleFormat = "mp3" | "m4a" | "wav";

export interface DownsampleOptions {
  limit?: number;
  force?: boolean;
  format?: DownsampleFormat;
  bitrate?: string;
  sampleRate?: number;
}

export interface DownsampleResult {
  downsampled: number;
  failed: number;
}

export interface AudioSource {
  path: string;
  extension: string;
  contentType: string;
  sizeBytes: number;
  kind: "original" | "downsampled";
}

const DEFAULT_FORMAT: DownsampleFormat = "mp3";
const DEFAULT_BITRATE = "64k";
const DEFAULT_SAMPLE_RATE = 16000;

export async function downsamplePending(
  config: AppConfig,
  store: ImporterStore,
  options: DownsampleOptions,
): Promise<DownsampleResult> {
  const rows = store.pendingDownsample(
    options.limit ?? 25,
    Boolean(options.force),
  );
  const result: DownsampleResult = { downsampled: 0, failed: 0 };
  if (rows.length === 0) return result;

  ensureFfmpeg();
  const format = options.format ?? DEFAULT_FORMAT;
  const bitrate = options.bitrate ?? DEFAULT_BITRATE;
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;

  for (const row of rows) {
    try {
      const targetPath = downsampledPathFor(config, row, format);
      await mkdir(join(config.downsampledDir, row.sha256.slice(0, 2)), {
        recursive: true,
      });
      runFfmpeg(row.local_path, targetPath, {
        format,
        bitrate,
        sampleRate,
        overwrite: Boolean(options.force),
      });
      const stats = await stat(targetPath);
      store.markDownsampled(row.id, {
        path: targetPath,
        contentType: contentTypeForFormat(format),
        sizeBytes: stats.size,
        format,
        bitrate,
        sampleRate,
      });
      result.downsampled += 1;
    } catch (err) {
      result.failed += 1;
      store.markDownsampleFailed(
        row.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}

export function audioSourceFor(
  row: RecordingRow,
  preferDownsampled: boolean,
): AudioSource {
  if (preferDownsampled && row.downsampled_path) {
    return {
      path: row.downsampled_path,
      extension: `.${row.downsampled_format ?? "mp3"}`,
      contentType: row.downsampled_content_type ?? contentTypeForFormat("mp3"),
      sizeBytes: row.downsampled_size_bytes ?? row.size_bytes,
      kind: "downsampled",
    };
  }

  return {
    path: row.local_path,
    extension: row.extension,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    kind: "original",
  };
}

export function parseDownsampleFormat(
  value: string | undefined,
): DownsampleFormat | undefined {
  if (!value) return undefined;
  if (value === "mp3" || value === "m4a" || value === "wav") return value;
  throw new Error("--format must be mp3, m4a, or wav");
}

function downsampledPathFor(
  config: AppConfig,
  row: RecordingRow,
  format: DownsampleFormat,
): string {
  return join(
    config.downsampledDir,
    row.sha256.slice(0, 2),
    `${row.sha256}.${format}`,
  );
}

function runFfmpeg(
  inputPath: string,
  outputPath: string,
  options: {
    format: DownsampleFormat;
    bitrate: string;
    sampleRate: number;
    overwrite: boolean;
  },
): void {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    options.overwrite ? "-y" : "-n",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(options.sampleRate),
    ...codecArgs(options.format, options.bitrate),
    outputPath,
  ];
  const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `ffmpeg exited ${result.status}`;
    throw new Error(detail);
  }
}

function codecArgs(format: DownsampleFormat, bitrate: string): string[] {
  if (format === "mp3") return ["-codec:a", "libmp3lame", "-b:a", bitrate];
  if (format === "m4a") return ["-codec:a", "aac", "-b:a", bitrate];
  return ["-codec:a", "pcm_s16le"];
}

function contentTypeForFormat(format: DownsampleFormat): string {
  if (format === "mp3") return "audio/mpeg";
  if (format === "m4a") return "audio/mp4";
  return "audio/wav";
}

function ensureFfmpeg(): void {
  const result = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      "ffmpeg is required for downsample; install it with `brew install ffmpeg`",
    );
  }
}
