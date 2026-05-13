import { basename } from "node:path";
import type { AppConfig } from "./config";
import { remoteKey } from "./config";
import type { ImporterStore, RecordingRow } from "./db";
import { audioSourceFor, type AudioSource } from "./downsample";
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
}

export interface UploadResult {
  uploaded: number;
  published: number;
  failed: number;
}

export async function uploadPending(
  config: AppConfig,
  store: ImporterStore,
  limit: number,
  options: UploadOptions,
): Promise<UploadResult> {
  ensureRemoteImporterSchema(config, options);
  if (options.publish) ensureConversationSchema(config, options);

  const rows = store.pendingUpload(limit, Boolean(options.publish));
  const result: UploadResult = { uploaded: 0, published: 0, failed: 0 };

  for (const row of rows) {
    try {
      const audio = audioSourceFor(row, Boolean(options.useDownsampled));
      const mediaKey = mediaKeyFor(config, row, audio);
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

      putKvFile(mediaKey, audio.path, options);
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
  audio: AudioSource,
  mediaKey: string,
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
      audio.sizeBytes,
      audio.contentType,
      row.recorded_at,
      row.source_path,
      mediaKey,
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
  audio: AudioSource,
  mediaKey: string,
  metadataKey: string,
  transcriptImportKey: string | null,
  options: TcOptions,
): Promise<string> {
  const conversationId = `rec-${row.sha256.slice(0, 24)}`;
  const now = new Date().toISOString();
  const startedAt = row.recorded_at ?? row.modified_at ?? now;
  const endedAt = row.duration_secs
    ? addSeconds(startedAt, row.duration_secs)
    : null;
  const transcript = await loadTranscript(row);
  const metadata = {
    import_type: "recorder-audio",
    importer: "listen-importer",
    importer_recording_id: row.id,
    original_file_name: row.file_name,
    original_source_path: row.source_path,
    audio_kv_key: mediaKey,
    audio_metadata_kv_key: metadataKey,
    audio_source_kind: audio.kind,
    transcript_kv_key: transcriptImportKey,
    transcription_provider: row.transcription_provider,
    transcribed_at: row.transcribed_at,
    audio_content_type: audio.contentType,
    audio_size_bytes: audio.sizeBytes,
    original_audio_content_type: row.content_type,
    original_audio_size_bytes: row.size_bytes,
    downsampled_audio_path: row.downsampled_path,
    downsampled_audio_size_bytes: row.downsampled_size_bytes,
    sha256: row.sha256,
    recorder: row.recorder,
  };

  putKvString(
    remoteKey(config, `transcript/${conversationId}`),
    JSON.stringify(transcript),
    options,
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
      "recorder",
      `listen-importer:${row.sha256}`,
      null,
      startedAt,
      endedAt,
      row.duration_secs,
      null,
      JSON.stringify(metadata),
      now,
      now,
    ],
    options,
  );
  insertParticipants(config, conversationId, transcript, options);
  return conversationId;
}

function metadataFor(
  row: RecordingRow,
  audio: AudioSource,
  mediaKey: string,
  metadataKey: string,
  transcriptKey: string | null,
) {
  return {
    id: row.id,
    fileName: row.file_name,
    recorder: row.recorder,
    sha256: row.sha256,
    sizeBytes: audio.sizeBytes,
    contentType: audio.contentType,
    mediaSourceKind: audio.kind,
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
  const stem = basename(row.file_name, row.extension).replace(/[_-]+/g, " ");
  return stem.trim() || row.file_name;
}

async function loadTranscript(row: RecordingRow): Promise<TranscriptSegment[]> {
  if (!row.transcript_path) return [];
  const raw = await Bun.file(row.transcript_path).text();
  const parsed = JSON.parse(raw) as TranscriptSegment[];
  return Array.isArray(parsed) ? parsed : [];
}

function insertParticipants(
  config: AppConfig,
  conversationId: string,
  transcript: TranscriptSegment[],
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

function addSeconds(iso: string, seconds: number): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + seconds * 1000).toISOString();
}
