import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { openStore } from "../src/db";
import type { AppConfig } from "../src/config";
import type { ClonedRecording } from "../src/media";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("ImporterStore", () => {
  test("upserts recordings and counts statuses", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "listen-importer-"));
    const config: AppConfig = {
      homeDir: tempDir,
      dbPath: join(tempDir, "state.sqlite"),
      mediaDir: join(tempDir, "media"),
      downsampledDir: join(tempDir, "downsampled"),
      transcriptsDir: join(tempDir, "transcripts"),
      listenSqlDb: "test-db",
      listenKvPrefix: "test-prefix",
      listenAppSpace: "applications",
    };
    const store = await openStore(config);
    const recording: ClonedRecording = {
      id: "sha",
      sha256: "sha",
      sourcePath: "/Volumes/MIC MINI/A.WAV",
      localPath: join(tempDir, "media", "sha.wav"),
      fileName: "A.WAV",
      extension: ".wav",
      contentType: "audio/wav",
      recorder: "mic-mini",
      sizeBytes: 12,
      recordedAt: null,
      modifiedAt: new Date(0).toISOString(),
    };

    expect(store.upsertRecording(recording)).toBe("created");
    expect(store.hasSourceSnapshot(recording)).toBe(true);
    expect(store.upsertRecording({ ...recording, fileName: "B.WAV" })).toBe(
      "updated",
    );
    expect(
      store.hasSourceSnapshot({
        ...recording,
        modifiedAt: new Date(1).toISOString(),
      }),
    ).toBe(false);
    expect(store.counts()).toEqual({
      total: 1,
      cloned: 1,
      uploaded: 0,
      published: 0,
      failed: 0,
      transcript_ready: 0,
      transcript_missing: 1,
      downsampled_ready: 0,
      downsampled_missing: 1,
    });
    store.markDownsampled("sha", {
      path: join(tempDir, "downsampled", "sha.mp3"),
      contentType: "audio/mpeg",
      sizeBytes: 2,
      format: "mp3",
      bitrate: "64k",
      sampleRate: 16000,
    });
    expect(store.counts().downsampled_ready).toBe(1);
    store.markTranscribed("sha", {
      provider: "deepgram",
      transcriptPath: join(tempDir, "transcripts", "sha.json"),
      transcriptText: "hello",
      durationSecs: 1.2,
    });
    expect(store.counts().transcript_ready).toBe(1);
    expect(store.list(1)[0]!.file_name).toBe("B.WAV");
    store.close();
  });

  test("filters pending uploads by Listen source", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "listen-importer-"));
    const config: AppConfig = {
      homeDir: tempDir,
      dbPath: join(tempDir, "state.sqlite"),
      mediaDir: join(tempDir, "media"),
      downsampledDir: join(tempDir, "downsampled"),
      transcriptsDir: join(tempDir, "transcripts"),
      listenSqlDb: "test-db",
      listenKvPrefix: "test-prefix",
      listenAppSpace: "applications",
    };
    const store = await openStore(config);
    const base: ClonedRecording = {
      id: "recorder-sha",
      sha256: "recorder-sha",
      sourcePath: "/Volumes/MIC MINI/A.WAV",
      localPath: join(tempDir, "media", "recorder-sha.wav"),
      fileName: "A.WAV",
      extension: ".wav",
      contentType: "audio/wav",
      recorder: "mic-mini",
      sizeBytes: 12,
      recordedAt: null,
      modifiedAt: new Date(0).toISOString(),
    };
    store.upsertRecording(base);
    store.upsertRecording({
      ...base,
      id: "voice-sha",
      sha256: "voice-sha",
      sourcePath: "/Voice Memos/B.m4a",
      localPath: join(tempDir, "media", "voice-sha.m4a"),
      fileName: "B.m4a",
      extension: ".m4a",
      contentType: "audio/mp4",
      sourceAdapter: "macos-voice-memos",
      importType: "voice-memo-audio",
      listenSource: "voice_memos",
      sourceId: "voice-1",
      recorder: "voice-memos",
    });
    store.upsertRecording({
      ...base,
      id: "soundcore-sha",
      sha256: "soundcore-sha",
      sourcePath: "/Soundcore/2026-06-08-planning.md",
      localPath: join(tempDir, "media", "soundcore-sha.md"),
      fileName: "2026-06-08-planning.md",
      extension: ".md",
      contentType: "text/markdown",
      sourceAdapter: "soundcore-sync",
      importType: "soundcore-transcript",
      listenSource: "soundcore_sync",
      sourceId: "soundcore-sync:2026-06-08-planning.md",
      artifactKind: "transcript",
      transcriptPath: join(tempDir, "transcripts", "soundcore-sha.json"),
      transcriptText: "Hello from Soundcore",
      recorder: "soundcore-sync",
    });

    expect(store.pendingUpload(10, false, "voice_memos")).toHaveLength(1);
    expect(store.pendingUpload(10, false, "voice_memos")[0]!.file_name).toBe(
      "B.m4a",
    );
    expect(store.pendingUpload(10, false, "recorder")).toHaveLength(1);
    expect(store.pendingDownsample(10, false, "voice_memos")).toHaveLength(1);
    expect(
      store.pendingDownsample(10, false, "voice_memos")[0]!.file_name,
    ).toBe("B.m4a");
    expect(store.pendingTranscription(10, false, "voice_memos")).toHaveLength(
      1,
    );
    expect(
      store.pendingTranscription(10, false, "voice_memos")[0]!.file_name,
    ).toBe("B.m4a");
    expect(store.list(10, "voice_memos")).toHaveLength(1);
    expect(store.list(10, "soundcore_sync")).toHaveLength(1);
    expect(store.pendingDownsample(10, false, "soundcore_sync")).toHaveLength(
      0,
    );
    expect(
      store.pendingTranscription(10, false, "soundcore_sync"),
    ).toHaveLength(0);
    expect(store.pendingUpload(10, false, "soundcore_sync")).toHaveLength(1);
    expect(store.counts("voice_memos").total).toBe(1);
    expect(store.counts("soundcore_sync").total).toBe(1);
    expect(store.counts("recorder").total).toBe(1);
    store.close();
  });
});
