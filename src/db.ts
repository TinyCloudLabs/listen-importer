import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import type { AppConfig } from "./config";
import type { ClonedRecording, RecorderFile } from "./media";

export type RecordingStatus = "cloned" | "uploaded" | "published" | "failed";

export interface RecordingRow {
  id: string;
  source_path: string;
  file_name: string;
  extension: string;
  content_type: string;
  downsampled_path: string | null;
  downsampled_content_type: string | null;
  downsampled_size_bytes: number | null;
  downsampled_format: string | null;
  downsampled_bitrate: string | null;
  downsampled_sample_rate: number | null;
  downsampled_at: string | null;
  downsample_error: string | null;
  recorder: string;
  sha256: string;
  size_bytes: number;
  recorded_at: string | null;
  modified_at: string;
  local_path: string;
  status: RecordingStatus;
  media_kv_key: string | null;
  metadata_kv_key: string | null;
  transcript_kv_key: string | null;
  conversation_id: string | null;
  transcript_path: string | null;
  transcript_text: string | null;
  transcription_provider: string | null;
  transcribed_at: string | null;
  transcription_error: string | null;
  duration_secs: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  uploaded_at: string | null;
}

export interface StatusCounts {
  total: number;
  cloned: number;
  uploaded: number;
  published: number;
  failed: number;
  transcript_ready: number;
  transcript_missing: number;
  downsampled_ready: number;
  downsampled_missing: number;
}

export interface MarkDownsampledInput {
  path: string;
  contentType: string;
  sizeBytes: number;
  format: string;
  bitrate: string;
  sampleRate: number;
}

export interface MarkTranscribedInput {
  provider: string;
  transcriptPath: string;
  transcriptText: string;
  durationSecs: number | null;
}

export async function openStore(config: AppConfig): Promise<ImporterStore> {
  await mkdir(config.homeDir, { recursive: true });
  await mkdir(config.mediaDir, { recursive: true });
  await mkdir(config.downsampledDir, { recursive: true });
  await mkdir(config.transcriptsDir, { recursive: true });
  const db = new Database(config.dbPath, { create: true });
  const store = new ImporterStore(db);
  store.migrate();
  return store;
}

export class ImporterStore {
  constructor(private readonly db: Database) {}

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        extension TEXT NOT NULL,
        content_type TEXT NOT NULL,
        downsampled_path TEXT,
        downsampled_content_type TEXT,
        downsampled_size_bytes INTEGER,
        downsampled_format TEXT,
        downsampled_bitrate TEXT,
        downsampled_sample_rate INTEGER,
        downsampled_at TEXT,
        downsample_error TEXT,
        recorder TEXT NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL,
        recorded_at TEXT,
        modified_at TEXT NOT NULL,
        local_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'cloned',
        media_kv_key TEXT,
        metadata_kv_key TEXT,
        transcript_kv_key TEXT,
        conversation_id TEXT,
        transcript_path TEXT,
        transcript_text TEXT,
        transcription_provider TEXT,
        transcribed_at TEXT,
        transcription_error TEXT,
        duration_secs REAL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        uploaded_at TEXT
      );
      CREATE INDEX IF NOT EXISTS recordings_status_idx ON recordings(status);
      CREATE INDEX IF NOT EXISTS recordings_recorder_idx ON recordings(recorder);
    `);
    this.ensureColumn("transcript_kv_key", "TEXT");
    this.ensureColumn("downsampled_path", "TEXT");
    this.ensureColumn("downsampled_content_type", "TEXT");
    this.ensureColumn("downsampled_size_bytes", "INTEGER");
    this.ensureColumn("downsampled_format", "TEXT");
    this.ensureColumn("downsampled_bitrate", "TEXT");
    this.ensureColumn("downsampled_sample_rate", "INTEGER");
    this.ensureColumn("downsampled_at", "TEXT");
    this.ensureColumn("downsample_error", "TEXT");
    this.ensureColumn("transcript_path", "TEXT");
    this.ensureColumn("transcript_text", "TEXT");
    this.ensureColumn("transcription_provider", "TEXT");
    this.ensureColumn("transcribed_at", "TEXT");
    this.ensureColumn("transcription_error", "TEXT");
    this.ensureColumn("duration_secs", "REAL");
  }

  upsertRecording(recording: ClonedRecording): "created" | "updated" {
    const now = new Date().toISOString();
    const existing = this.findBySha(recording.sha256);
    if (existing) {
      this.db
        .query(
          `UPDATE recordings
           SET source_path = ?, file_name = ?, extension = ?, content_type = ?, recorder = ?,
               size_bytes = ?, recorded_at = ?, modified_at = ?, local_path = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          recording.sourcePath,
          recording.fileName,
          recording.extension,
          recording.contentType,
          recording.recorder,
          recording.sizeBytes,
          recording.recordedAt,
          recording.modifiedAt,
          recording.localPath,
          now,
          existing.id,
        );
      return "updated";
    }

    this.db
      .query(
        `INSERT INTO recordings (
          id, source_path, file_name, extension, content_type, recorder, sha256, size_bytes,
          recorded_at, modified_at, local_path, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cloned', ?, ?)`,
      )
      .run(
        recording.id,
        recording.sourcePath,
        recording.fileName,
        recording.extension,
        recording.contentType,
        recording.recorder,
        recording.sha256,
        recording.sizeBytes,
        recording.recordedAt,
        recording.modifiedAt,
        recording.localPath,
        now,
        now,
      );
    return "created";
  }

  list(limit = 50): RecordingRow[] {
    return this.db
      .query(`SELECT * FROM recordings ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as RecordingRow[];
  }

  pendingUpload(limit = 25, includeUploaded = false): RecordingRow[] {
    const statuses = includeUploaded
      ? "'cloned', 'failed', 'uploaded'"
      : "'cloned', 'failed'";
    return this.db
      .query(
        `SELECT * FROM recordings
         WHERE status IN (${statuses})
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit) as RecordingRow[];
  }

  pendingTranscription(limit = 25, force = false): RecordingRow[] {
    return this.db
      .query(
        `SELECT * FROM recordings
         WHERE ${force ? "1 = 1" : "transcript_path IS NULL"}
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit) as RecordingRow[];
  }

  pendingDownsample(limit = 25, force = false): RecordingRow[] {
    return this.db
      .query(
        `SELECT * FROM recordings
         WHERE ${force ? "1 = 1" : "downsampled_path IS NULL"}
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit) as RecordingRow[];
  }

  hasSourceSnapshot(recording: RecorderFile): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM recordings
         WHERE source_path = ? AND size_bytes = ? AND modified_at = ?
         LIMIT 1`,
      )
      .get(recording.sourcePath, recording.sizeBytes, recording.modifiedAt);
    return row !== null;
  }

  counts(): StatusCounts {
    const rows = this.db
      .query(`SELECT status, COUNT(*) AS count FROM recordings GROUP BY status`)
      .all() as Array<{
      status: RecordingStatus;
      count: number;
    }>;
    const counts: StatusCounts = {
      total: 0,
      cloned: 0,
      uploaded: 0,
      published: 0,
      failed: 0,
      transcript_ready: 0,
      transcript_missing: 0,
      downsampled_ready: 0,
      downsampled_missing: 0,
    };
    for (const row of rows) {
      counts[row.status] = Number(row.count);
      counts.total += Number(row.count);
    }
    const transcriptRow = this.db
      .query(
        `SELECT COUNT(*) AS count FROM recordings WHERE transcript_path IS NOT NULL`,
      )
      .get() as { count: number } | null;
    counts.transcript_ready = Number(transcriptRow?.count ?? 0);
    counts.transcript_missing = Math.max(
      0,
      counts.total - counts.transcript_ready,
    );
    const downsampleRow = this.db
      .query(
        `SELECT COUNT(*) AS count FROM recordings WHERE downsampled_path IS NOT NULL`,
      )
      .get() as { count: number } | null;
    counts.downsampled_ready = Number(downsampleRow?.count ?? 0);
    counts.downsampled_missing = Math.max(
      0,
      counts.total - counts.downsampled_ready,
    );
    return counts;
  }

  markUploaded(id: string, mediaKvKey: string, metadataKvKey: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE recordings
         SET status = 'uploaded', media_kv_key = ?, metadata_kv_key = ?, uploaded_at = ?,
             error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(mediaKvKey, metadataKvKey, now, now, id);
  }

  markTranscriptUploaded(id: string, transcriptKvKey: string): void {
    this.db
      .query(
        `UPDATE recordings SET transcript_kv_key = ?, updated_at = ? WHERE id = ?`,
      )
      .run(transcriptKvKey, new Date().toISOString(), id);
  }

  markPublished(id: string, conversationId: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE recordings
         SET status = 'published', conversation_id = ?, error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(conversationId, now, id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .query(
        `UPDATE recordings SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(error, new Date().toISOString(), id);
  }

  markDownsampled(id: string, input: MarkDownsampledInput): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE recordings
         SET downsampled_path = ?, downsampled_content_type = ?, downsampled_size_bytes = ?,
             downsampled_format = ?, downsampled_bitrate = ?, downsampled_sample_rate = ?,
             downsampled_at = ?, downsample_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.path,
        input.contentType,
        input.sizeBytes,
        input.format,
        input.bitrate,
        input.sampleRate,
        now,
        now,
        id,
      );
  }

  markDownsampleFailed(id: string, error: string): void {
    this.db
      .query(
        `UPDATE recordings SET downsample_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(error, new Date().toISOString(), id);
  }

  markTranscribed(id: string, input: MarkTranscribedInput): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE recordings
         SET transcript_path = ?, transcript_text = ?, transcription_provider = ?,
             transcribed_at = ?, transcription_error = NULL, duration_secs = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.transcriptPath,
        input.transcriptText,
        input.provider,
        now,
        input.durationSecs,
        now,
        id,
      );
  }

  markTranscriptionFailed(id: string, error: string): void {
    this.db
      .query(
        `UPDATE recordings SET transcription_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(error, new Date().toISOString(), id);
  }

  private findBySha(sha256: string): RecordingRow | null {
    return this.db
      .query(`SELECT * FROM recordings WHERE sha256 = ?`)
      .get(sha256) as RecordingRow | null;
  }

  private ensureColumn(name: string, definition: string): void {
    const columns = this.db
      .query(`PRAGMA table_info(recordings)`)
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE recordings ADD COLUMN ${name} ${definition}`);
    }
  }
}
