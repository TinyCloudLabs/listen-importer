import { describe, expect, test } from "bun:test";
import { audioSourceFor, parseDownsampleFormat } from "../src/downsample";
import type { RecordingRow } from "../src/db";

const row: RecordingRow = {
  id: "sha",
  source_path: "/Volumes/MIC MINI/A.WAV",
  file_name: "A.WAV",
  extension: ".wav",
  content_type: "audio/wav",
  downsampled_path: "/tmp/sha.mp3",
  downsampled_content_type: "audio/mpeg",
  downsampled_size_bytes: 12,
  downsampled_format: "mp3",
  downsampled_bitrate: "64k",
  downsampled_sample_rate: 16000,
  downsampled_at: new Date(0).toISOString(),
  downsample_error: null,
  recorder: "mic-mini",
  sha256: "sha",
  size_bytes: 100,
  recorded_at: null,
  modified_at: new Date(0).toISOString(),
  local_path: "/tmp/sha.wav",
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
  duration_secs: null,
  error: null,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  uploaded_at: null,
};

describe("downsample helpers", () => {
  test("prefers downsampled audio when requested", () => {
    expect(audioSourceFor(row, true)).toEqual({
      path: "/tmp/sha.mp3",
      extension: ".mp3",
      contentType: "audio/mpeg",
      sizeBytes: 12,
      kind: "downsampled",
    });
    expect(audioSourceFor(row, false).kind).toBe("original");
  });

  test("validates downsample formats", () => {
    expect(parseDownsampleFormat("mp3")).toBe("mp3");
    expect(() => parseDownsampleFormat("flac")).toThrow(
      "--format must be mp3, m4a, or wav",
    );
  });
});
