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
    expect(store.upsertRecording({ ...recording, fileName: "B.WAV" })).toBe(
      "updated",
    );
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
});
