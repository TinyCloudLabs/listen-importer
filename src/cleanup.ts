import { stat, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ImporterStore, RecordingRow } from "./db";
import { detectRecorder, scanRecorder, type RecorderFile } from "./media";

export interface CleanupRecorderOptions {
  recorder?: string;
  deleteFiles?: boolean;
  confirm?: string;
  includeUntranscribed?: boolean;
  includeUntracked?: boolean;
  confirmRisky?: string;
}

export interface CleanupRecorderEntry {
  sourcePath: string;
  fileName: string;
  sizeBytes: number;
  rowId: string | null;
  status: string | null;
  tracked: boolean;
  transcriptReady: boolean;
  eligible: boolean;
  deleted: boolean;
  reason: CleanupRecorderReason;
  error?: string;
}

export type CleanupRecorderReason =
  | "transcribed"
  | "untranscribed"
  | "untracked"
  | "changed"
  | "delete_failed";

export interface CleanupRecorderResult {
  rootPath: string;
  recorder: string;
  dryRun: boolean;
  scanned: number;
  eligible: number;
  deleted: number;
  blockedUntranscribed: number;
  blockedUntracked: number;
  failed: number;
  entries: CleanupRecorderEntry[];
}

const RISKY_CONFIRMATION = "delete-unverified";

export async function cleanupRecorderCaptures(
  store: ImporterStore,
  rootPath: string,
  options: CleanupRecorderOptions = {},
): Promise<CleanupRecorderResult> {
  const recorder = options.recorder ?? detectRecorder(rootPath);
  const files = await scanRecorder(rootPath, recorder);
  const deleteFiles = options.deleteFiles === true;
  validateDeleteConfirmation(rootPath, options);

  const result: CleanupRecorderResult = {
    rootPath,
    recorder,
    dryRun: !deleteFiles,
    scanned: files.length,
    eligible: 0,
    deleted: 0,
    blockedUntranscribed: 0,
    blockedUntracked: 0,
    failed: 0,
    entries: [],
  };

  for (const file of files) {
    const row = store.findSourceSnapshot(file);
    const transcriptReady = rowHasTranscript(row);
    const reason = reasonFor(file, row, transcriptReady, options);
    const eligible =
      reason === "transcribed" ||
      (reason === "untranscribed" && options.includeUntranscribed === true) ||
      (reason === "untracked" && options.includeUntracked === true);
    const entry: CleanupRecorderEntry = {
      sourcePath: file.sourcePath,
      fileName: file.fileName,
      sizeBytes: file.sizeBytes,
      rowId: row?.id ?? null,
      status: row?.status ?? null,
      tracked: row !== null,
      transcriptReady,
      eligible,
      deleted: false,
      reason,
    };

    if (!eligible) {
      if (reason === "untranscribed") result.blockedUntranscribed += 1;
      if (reason === "untracked") result.blockedUntracked += 1;
      result.entries.push(entry);
      continue;
    }

    result.eligible += 1;
    if (!deleteFiles) {
      result.entries.push(entry);
      continue;
    }

    try {
      const changed = await sourceChangedSinceScan(file);
      if (changed) {
        entry.eligible = false;
        entry.reason = "changed";
        result.failed += 1;
      } else {
        await unlink(file.sourcePath);
        entry.deleted = true;
        result.deleted += 1;
      }
    } catch (err) {
      entry.reason = "delete_failed";
      entry.error = err instanceof Error ? err.message : String(err);
      result.failed += 1;
    }
    result.entries.push(entry);
  }

  return result;
}

export function expectedRecorderConfirmation(rootPath: string): string {
  return basename(resolve(rootPath));
}

export function riskyCleanupConfirmation(): string {
  return RISKY_CONFIRMATION;
}

function validateDeleteConfirmation(
  rootPath: string,
  options: CleanupRecorderOptions,
): void {
  if (!options.deleteFiles) return;
  const expected = expectedRecorderConfirmation(rootPath);
  if (options.confirm !== expected) {
    throw new Error(
      `cleanup-recorder requires --confirm ${JSON.stringify(expected)} to delete files`,
    );
  }

  const includesRiskyFiles =
    options.includeUntranscribed === true || options.includeUntracked === true;
  if (includesRiskyFiles && options.confirmRisky !== RISKY_CONFIRMATION) {
    throw new Error(
      `Deleting untranscribed or untracked files requires --confirm-risky ${RISKY_CONFIRMATION}`,
    );
  }
}

function rowHasTranscript(row: RecordingRow | null): boolean {
  return Boolean(row?.transcript_path || row?.transcript_text);
}

function reasonFor(
  _file: RecorderFile,
  row: RecordingRow | null,
  transcriptReady: boolean,
  _options: CleanupRecorderOptions,
): CleanupRecorderReason {
  if (!row) return "untracked";
  if (!transcriptReady) return "untranscribed";
  return "transcribed";
}

async function sourceChangedSinceScan(file: RecorderFile): Promise<boolean> {
  const stats = await stat(file.sourcePath);
  return (
    stats.size !== file.sizeBytes ||
    stats.mtime.toISOString() !== file.modifiedAt
  );
}
