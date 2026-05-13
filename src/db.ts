import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import type { AppConfig } from "./config";
import type { ClonedRecording } from "./media";

export type RecordingStatus = "cloned" | "uploaded" | "published" | "failed";

export interface RecordingRow {
  id: string;
  source_path: string;
  file_name: string;
  extension: string;
  content_type: string;
  recorder: string;
  sha256: string;
  size_bytes: number;
  recorded_at: string | null;
  modified_at: string;
  local_path: string;
  status: RecordingStatus;
  media_kv_key: string | null;
  metadata_kv_key: string | null;
  conversation_id: string | null;
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
}

export async function openStore(config: AppConfig): Promise<ImporterStore> {
  await mkdir(config.homeDir, { recursive: true });
  await mkdir(config.mediaDir, { recursive: true });
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
        recorder TEXT NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL,
        recorded_at TEXT,
        modified_at TEXT NOT NULL,
        local_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'cloned',
        media_kv_key TEXT,
        metadata_kv_key TEXT,
        conversation_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        uploaded_at TEXT
      );
      CREATE INDEX IF NOT EXISTS recordings_status_idx ON recordings(status);
      CREATE INDEX IF NOT EXISTS recordings_recorder_idx ON recordings(recorder);
    `);
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

  pendingUpload(limit = 25): RecordingRow[] {
    return this.db
      .query(
        `SELECT * FROM recordings
         WHERE status IN ('cloned', 'failed')
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit) as RecordingRow[];
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
    };
    for (const row of rows) {
      counts[row.status] = Number(row.count);
      counts.total += Number(row.count);
    }
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

  private findBySha(sha256: string): RecordingRow | null {
    return this.db
      .query(`SELECT * FROM recordings WHERE sha256 = ?`)
      .get(sha256) as RecordingRow | null;
  }
}
