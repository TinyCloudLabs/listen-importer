import { test, expect } from "bun:test";
import { RecordingRow } from "../src/db";
import {
  normalizeConversationMetadata,
  normalizeTranscriptSegments,
  parseTimestampToSeconds,
} from "../src/upload";

const mockRecordingRow: RecordingRow = {
  id: "test-id",
  source_path: "/path/to/audio.mp3",
  file_name: "audio.mp3",
  extension: ".mp3",
  content_type: "audio/mpeg",
  source_adapter: "test-adapter",
  import_type: "test-import",
  listen_source: "voice_memos",
  source_id: "source-123",
  source_uri: "file://source-123",
  title: "Test Recording",
  artifact_kind: "audio",
  metadata_json: null,
  downsampled_path: null,
  downsampled_content_type: null,
  downsampled_size_bytes: null,
  downsampled_format: null,
  downsampled_bitrate: null,
  downsampled_sample_rate: null,
  downsampled_at: null,
  downsample_error: null,
  recorder: "iPhone",
  sha256: "sha256-hash",
  size_bytes: 12345,
  recorded_at: "2023-01-01T12:00:00Z",
  modified_at: "2023-01-01T12:00:00Z",
  local_path: "/local/path/to/audio.mp3",
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
  created_at: "2023-01-01T12:00:00Z",
  updated_at: "2023-01-01T12:00:00Z",
  uploaded_at: null,
};

test("normalizeConversationMetadata sets source_label correctly", () => {
  const result = normalizeConversationMetadata(mockRecordingRow, null);
  expect(result.source_label).toBe("voice_memos");
});

test("normalizeConversationMetadata handles null source_metadata", () => {
  const result = normalizeConversationMetadata(mockRecordingRow, null);
  expect(result.source_label).toBe("voice_memos");
  expect(result.recorder_device).toBeUndefined();
  expect(result.tags).toBeUndefined();
  expect(result.original_file_name).toBeUndefined();
});

test("parseTimestampToSeconds handles valid number timestamps", () => {
  expect(parseTimestampToSeconds(0)).toBe(0);
  expect(parseTimestampToSeconds(60)).toBe(60);
  expect(parseTimestampToSeconds(3600)).toBe(3600);
  expect(parseTimestampToSeconds(1.234)).toBe(1.234);
});

test("parseTimestampToSeconds handles valid string timestamps", () => {
  expect(parseTimestampToSeconds("0")).toBe(0);
  expect(parseTimestampToSeconds("60")).toBe(60);
  expect(parseTimestampToSeconds("3600")).toBe(3600);
  expect(parseTimestampToSeconds("00:01:00")).toBe(60);
  expect(parseTimestampToSeconds("01:00")).toBe(60);
  expect(parseTimestampToSeconds("00:00:01.234")).toBe(1.234);
  expect(parseTimestampToSeconds("1.234")).toBe(1.234);
  expect(parseTimestampToSeconds("01:01:01.500")).toBe(3661.5);
});

test("parseTimestampToSeconds handles invalid timestamps", () => {
  expect(parseTimestampToSeconds("abc")).toBeNull();
  expect(parseTimestampToSeconds("")).toBeNull();
  expect(parseTimestampToSeconds(null)).toBeNull();
  expect(parseTimestampToSeconds(undefined)).toBeNull();
  expect(parseTimestampToSeconds("01:invalid")).toBeNull();
});

test("normalizeTranscriptSegments normalizes valid segments", () => {
  const segments: any[] = [
    { speaker_name: "Speaker 1", text: "Hello", start_time: 0, end_time: 1 },
  ];
  const result = normalizeTranscriptSegments(segments);
  expect(result).toEqual([
    {
      index: 0,
      speaker_id: "speaker-1",
      speaker_name: "Speaker 1",
      text: "Hello",
      start_time: 0,
      end_time: 1,
      language: null,
    },
  ]);
});

test("normalizeTranscriptSegments defaults speaker_name", () => {
  const segments: any[] = [
    { text: "Hello", start_time: 0, end_time: 1 },
  ];
  const result = normalizeTranscriptSegments(segments);
  expect(result[0]?.speaker_name).toBe("Unknown Speaker");
  expect(result[0]?.speaker_id).toBe("unknown-speaker");
  expect(result[0]?.start_time).toBe(0);
});

test("normalizeTranscriptSegments filters segments with empty text", () => {
  const segments: any[] = [
    { speaker_name: "Speaker 1", text: "", start_time: 0, end_time: 1 },
    { speaker_name: "Speaker 2", text: "World", start_time: 1, end_time: 2 },
  ];
  const result = normalizeTranscriptSegments(segments);
  expect(result.length).toBe(1);
  expect(result[0]?.text).toBe("World");
});

test("normalizeTranscriptSegments handles string timestamps", () => {
  const segments: any[] = [
    { speaker_name: "S1", text: "A", start_time: "00:00:01", end_time: "2.5" },
  ];
  const result = normalizeTranscriptSegments(segments);
  expect(result[0]?.start_time).toBe(1);
  expect(result[0]?.end_time).toBe(2.5);
});

test("normalizeTranscriptSegments handles nullable timestamps", () => {
  const segments: any[] = [
    { speaker_name: "S1", text: "A", start_time: null, end_time: undefined },
  ];
  const result = normalizeTranscriptSegments(segments);
  expect(result[0]?.start_time).toBeNull();
  expect(result[0]?.end_time).toBeNull();
});

test("normalizeTranscriptSegments handles mixed valid/invalid segments", () => {
  const segments: any[] = [
    { speaker_name: "S1", text: "Valid", start_time: 0, end_time: 1 },
    { speaker_name: "S2", text: "", start_time: 1, end_time: 2 }, // Filtered
    { text: "No Speaker", start_time: "abc", end_time: 3 }, // Speaker defaulted, timestamps null
    { speaker_name: "S3", text: "Another", start_time: "00:00:05", end_time: 6 },
  ];
  const result = normalizeTranscriptSegments(segments);
  expect(result.length).toBe(3);
  expect(result[0]?.text).toBe("Valid");
  expect(result[1]?.speaker_name).toBe("Unknown Speaker");
  expect(result[1]?.start_time).toBeNull();
  expect(result[2]?.start_time).toBe(5);
});

test("normalizeTranscriptSegments handles empty input", () => {
  expect(normalizeTranscriptSegments([])).toEqual([]);
});
