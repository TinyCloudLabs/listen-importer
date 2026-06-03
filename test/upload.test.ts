import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import type { AudioSource } from "../src/downsample";
import type { RecordingRow } from "../src/db";
import {
  buildPublishedConversationMetadata,
  mediaKeyPathFor,
  metadataKeyPathFor,
  normalizeTranscriptSegments,
  transcriptImportKeyPathFor,
} from "../src/upload";

const config: AppConfig = {
  homeDir: "/tmp/listen-importer",
  dbPath: "/tmp/listen-importer/state.sqlite",
  mediaDir: "/tmp/listen-importer/media",
  downsampledDir: "/tmp/listen-importer/downsampled",
  transcriptsDir: "/tmp/listen-importer/transcripts",
  listenSqlDb: "xyz.tinycloud.listen/conversations",
  listenKvPrefix: "xyz.tinycloud.listen",
  listenAppId: "xyz.tinycloud.listen",
  mediaKvPath: "importer/media",
  metadataKvPath: "importer/metadata",
  transcriptKvPath: "importer/transcripts",
};

describe("upload normalization", () => {
  test("normalizes transcript segments into Listen-compatible sentences", () => {
    const transcript = normalizeTranscriptSegments([
      {
        index: 7,
        speaker_name: " Ada ",
        speaker_id: "speaker-ada",
        text: " Hello world ",
        start_time: "01:02.5",
        end_time: "01:05.25",
        language: "en",
      },
      {
        speaker_name: " ",
        text: "   ",
        start_time: null,
        end_time: null,
      },
    ]);

    expect(transcript).toEqual([
      {
        index: 7,
        speaker_id: "speaker-ada",
        speaker_name: "Ada",
        text: "Hello world",
        start_time: 62.5,
        end_time: 65.25,
        language: "en",
      },
    ]);
  });

  test("publishes Listen conversation metadata with audio aliases and source back-compat", () => {
    const row = {
      id: "row-1",
      source_adapter: "macos-voice-memos",
      import_type: "voice-memo-audio",
      listen_source: "voice_memos",
      source_id: "memo-1",
      source_uri: "/Voice Memos/Memo.m4a",
      artifact_kind: "audio",
      file_name: "Memo.m4a",
      source_path: "/Voice Memos/Memo.m4a",
      title: "Voice Memo",
      recorder: "voice-memos",
      sha256: "abc123",
      size_bytes: 42,
      recorded_at: "2026-05-01T12:00:00.000Z",
      modified_at: "2026-05-01T12:00:00.000Z",
      local_path: "/tmp/abc123.m4a",
      status: "cloned",
      media_kv_key: null,
      metadata_kv_key: null,
      transcript_kv_key: null,
      conversation_id: null,
      transcript_path: null,
      transcript_text: null,
      transcription_provider: null,
      transcribed_at: null,
      transcription_error: null,
      duration_secs: 120,
      error: null,
      created_at: "2026-05-01T12:00:00.000Z",
      updated_at: "2026-05-01T12:00:00.000Z",
      uploaded_at: null,
      downsampled_path: null,
      downsampled_content_type: null,
      downsampled_size_bytes: null,
      downsampled_format: null,
      downsampled_bitrate: null,
      downsampled_sample_rate: null,
      downsampled_at: null,
      downsample_error: null,
      content_type: "audio/mp4",
    } as RecordingRow;
    const audio: AudioSource = {
      path: "/tmp/abc123.m4a",
      extension: ".m4a",
      contentType: "audio/mp4",
      sizeBytes: 42,
      kind: "original",
    };
    const mediaKeyPath = mediaKeyPathFor(config, row, audio);
    const metadataKeyPath = metadataKeyPathFor(config, row);
    const transcriptKeyPath = transcriptImportKeyPathFor(config, row);

    const metadata = buildPublishedConversationMetadata(
      row,
      audio,
      mediaKeyPath,
      metadataKeyPath,
      transcriptKeyPath,
      { device: "Mic Mini" },
    );

    expect(mediaKeyPath).toBe("importer/media/ab/abc123.m4a");
    expect(metadataKeyPath).toBe("importer/metadata/abc123.json");
    expect(transcriptKeyPath).toBe("importer/transcripts/abc123.json");
    expect(metadata.audio_kv_key).toBe("importer/media/ab/abc123.m4a");
    expect(metadata.audio_data_kv_key).toBe("importer/media/ab/abc123.m4a");
    expect(metadata.audio_metadata_kv_key).toBe("importer/metadata/abc123.json");
    expect(metadata.source_label).toBe("voice_memos");
    expect((metadata.source_metadata as Record<string, unknown>).device).toBe("Mic Mini");
  });
});
