import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import type { AppConfig } from "./config";
import type { ListenSource } from "./listen-source";
import type { ClonedRecording, RecorderFile } from "./media";

export type RecordingStatus = "cloned" | "uploaded" | "published" | "failed";

export interface RecordingRow {
  id: string;
  source_path: string;
  file_name: string;
  extension: string;
  content_type: string;
  source_adapter: string;
  import_type: string;
  listen_source: string;
  source_id: string | null;
  source_uri: string | null;
  title: string | null;
  artifact_kind: "audio" | "transcript";
  metadata_json: string | null;
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
        source_adapter TEXT NOT NULL DEFAULT 'recorder-disk',
        import_type TEXT NOT NULL DEFAULT 'recorder-audio',
        listen_source TEXT NOT NULL DEFAULT 'recorder',
        source_id TEXT,
        source_uri TEXT,
        title TEXT,
        artifact_kind TEXT NOT NULL DEFAULT 'audio',
        metadata_json TEXT,
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
    this.ensureColumn(
      "source_adapter",
      "TEXT NOT NULL DEFAULT 'recorder-disk'",
    );
    this.ensureColumn("import_type", "TEXT NOT NULL DEFAULT 'recorder-audio'");
    this.ensureColumn("listen_source", "TEXT NOT NULL DEFAULT 'recorder'");
    this.ensureColumn("source_id", "TEXT");
    this.ensureColumn("source_uri", "TEXT");
    this.ensureColumn("title", "TEXT");
    this.ensureColumn("artifact_kind", "TEXT NOT NULL DEFAULT 'audio'");
    this.ensureColumn("metadata_json", "TEXT");
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
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS recordings_source_id_idx
        ON recordings(source_adapter, source_id)
        WHERE source_id IS NOT NULL;
    `);
  }

  upsertRecording(recording: ClonedRecording): "created" | "updated" {
    const now = new Date().toISOString();
    const sourceAdapter = recording.sourceAdapter ?? "recorder-disk";
    const importType = recording.importType ?? "recorder-audio";
    const listenSource = recording.listenSource ?? "recorder";
    const artifactKind = recording.artifactKind ?? "audio";
    const existing = this.findExistingRecording(sourceAdapter, recording);
    if (existing) {
      this.db
        .query(
          `UPDATE recordings
           SET source_path = ?, file_name = ?, extension = ?, content_type = ?,
               source_adapter = ?, import_type = ?, listen_source = ?, source_id = ?,
               source_uri = ?, title = ?, artifact_kind = ?, metadata_json = ?, recorder = ?,
               sha256 = ?, size_bytes = ?, recorded_at = ?, modified_at = ?, local_path = ?,
               transcript_path = COALESCE(?, transcript_path),
               transcript_text = COALESCE(?, transcript_text),
               duration_secs = COALESCE(?, duration_secs),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          recording.sourcePath,
          recording.fileName,
          recording.extension,
          recording.contentType,
          sourceAdapter,
          importType,
          listenSource,
          recording.sourceId ?? null,
          recording.sourceUri ?? recording.sourcePath,
          recording.title ?? null,
          artifactKind,
          recording.metadataJson ?? null,
          recording.recorder,
          recording.sha256,
          recording.sizeBytes,
          recording.recordedAt,
          recording.modifiedAt,
          recording.localPath,
          recording.transcriptPath ?? null,
          recording.transcriptText ?? null,
          recording.durationSecs ?? null,
          now,
          existing.id,
        );
      return "updated";
    }

    this.db
      .query(
        `INSERT INTO recordings (
          id, source_path, file_name, extension, content_type, source_adapter, import_type,
          listen_source, source_id, source_uri, title, artifact_kind, metadata_json, recorder,
          sha256, size_bytes, recorded_at, modified_at, local_path, status, transcript_path,
          transcript_text, duration_secs, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cloned', ?, ?, ?, ?, ?)`,
      )
      .run(
        recording.id,
        recording.sourcePath,
        recording.fileName,
        recording.extension,
        recording.contentType,
        sourceAdapter,
        importType,
        listenSource,
        recording.sourceId ?? null,
        recording.sourceUri ?? recording.sourcePath,
        recording.title ?? null,
        artifactKind,
        recording.metadataJson ?? null,
        recording.recorder,
        recording.sha256,
        recording.sizeBytes,
        recording.recordedAt,
        recording.modifiedAt,
        recording.localPath,
        recording.transcriptPath ?? null,
        recording.transcriptText ?? null,
        recording.durationSecs ?? null,
        now,
        now,
      );
    return "created";
  }

  list(limit = 50, listenSource?: ListenSource): RecordingRow[] {
    const sourceClause = listenSource ? "WHERE listen_source = ?" : "";
    const params = listenSource ? [listenSource, limit] : [limit];
    return this.db
      .query(
        `SELECT * FROM recordings ${sourceClause} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params) as RecordingRow[];
  }

  pendingUpload(
    limit = 25,
    includeUploaded = false,
    listenSource?: ListenSource,
  ): RecordingRow[] {
    const statuses = includeUploaded
      ? "'cloned', 'failed', 'uploaded'"
      : "'cloned', 'failed'";
    const sourceClause = listenSource ? "AND listen_source = ?" : "";
    const params = listenSource ? [listenSource, limit] : [limit];
    return this.db
      .query(
        `SELECT * FROM recordings
         WHERE status IN (${statuses}) ${sourceClause}
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(...params) as RecordingRow[];
  }

  pendingTranscription(
    limit = 25,
    force = false,
    listenSource?: ListenSource,
  ): RecordingRow[] {
    const sourceClause = listenSource ? "AND listen_source = ?" : "";
    const params = listenSource ? [listenSource, limit] : [limit];
    return this.db
      .query(
        `SELECT * FROM recordings
         WHERE artifact_kind = 'audio' AND ${force ? "1 = 1" : "transcript_path IS NULL"} ${sourceClause}
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(...params) as RecordingRow[];
  }

  pendingDownsample(
    limit = 25,
    force = false,
    listenSource?: ListenSource,
  ): RecordingRow[] {
    const sourceClause = listenSource ? "AND listen_source = ?" : "";
    const params = listenSource ? [listenSource, limit] : [limit];
    return this.db
      .query(
        `SELECT * FROM recordings
         WHERE artifact_kind = 'audio' AND ${force ? "1 = 1" : "downsampled_path IS NULL"} ${sourceClause}
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(...params) as RecordingRow[];
  }

  hasSourceSnapshot(recording: RecorderFile): boolean {
    return this.findSourceSnapshot(recording) !== null;
  }

  findSourceSnapshot(recording: RecorderFile): RecordingRow | null {
    if (recording.sourceId) {
      const row = this.db
        .query(
          `SELECT * FROM recordings
           WHERE source_adapter = ? AND source_id = ? AND size_bytes = ? AND modified_at = ?
           LIMIT 1`,
        )
        .get(
          recording.sourceAdapter ?? "recorder-disk",
          recording.sourceId,
          recording.sizeBytes,
          recording.modifiedAt,
        ) as RecordingRow | null;
      return row;
    }

    return this.db
      .query(
        `SELECT * FROM recordings
         WHERE source_path = ? AND size_bytes = ? AND modified_at = ?
         LIMIT 1`,
      )
      .get(
        recording.sourcePath,
        recording.sizeBytes,
        recording.modifiedAt,
      ) as RecordingRow | null;
  }

  counts(listenSource?: ListenSource): StatusCounts {
    const sourceClause = listenSource ? "WHERE listen_source = ?" : "";
    const sourceParams = listenSource ? [listenSource] : [];
    const rows = this.db
      .query(
        `SELECT status, COUNT(*) AS count FROM recordings ${sourceClause} GROUP BY status`,
      )
      .all(...sourceParams) as Array<{
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
        `SELECT COUNT(*) AS count FROM recordings
         WHERE transcript_path IS NOT NULL ${listenSource ? "AND listen_source = ?" : ""}`,
      )
      .get(...sourceParams) as { count: number } | null;
    counts.transcript_ready = Number(transcriptRow?.count ?? 0);
    counts.transcript_missing = Math.max(
      0,
      counts.total - counts.transcript_ready,
    );
    const downsampleRow = this.db
      .query(
        `SELECT COUNT(*) AS count FROM recordings
         WHERE downsampled_path IS NOT NULL ${listenSource ? "AND listen_source = ?" : ""}`,
      )
      .get(...sourceParams) as { count: number } | null;
    counts.downsampled_ready = Number(downsampleRow?.count ?? 0);
    counts.downsampled_missing = Math.max(
      0,
      counts.total - counts.downsampled_ready,
    );
    return counts;
  }

  markUploaded(
    id: string,
    mediaKvKey: string | null,
    metadataKvKey: string,
  ): void {
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

  private findExistingRecording(
    sourceAdapter: string,
    recording: ClonedRecording,
  ): RecordingRow | null {
    if (recording.sourceId) {
      const sourceMatch = this.db
        .query(
          `SELECT * FROM recordings WHERE source_adapter = ? AND source_id = ?`,
        )
        .get(sourceAdapter, recording.sourceId) as RecordingRow | null;
      if (sourceMatch) return sourceMatch;
    }

    return this.db
      .query(`SELECT * FROM recordings WHERE sha256 = ?`)
      .get(recording.sha256) as RecordingRow | null;
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
