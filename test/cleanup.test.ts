import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupRecorderCaptures,
  expectedRecorderConfirmation,
  riskyCleanupConfirmation,
} from "../src/cleanup";
import type { AppConfig } from "../src/config";
import { openStore } from "../src/db";
import { cloneRecording, scanRecorder } from "../src/media";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("cleanupRecorderCaptures", () => {
  test("dry-runs by default and only marks transcript-ready tracked files eligible", async () => {
    const { config, rootPath, paths } = await setupRecorderFiles();
    const store = await openStore(config);
    const files = await scanRecorder(rootPath, "mic-mini");
    const transcribed = files.find((file) => file.fileName === "A.wav")!;
    const untranscribed = files.find((file) => file.fileName === "B.wav")!;
    const transcribedRow = await cloneRecording(config, transcribed);
    store.upsertRecording(transcribedRow);
    store.upsertRecording(await cloneRecording(config, untranscribed));
    store.markTranscribed(transcribedRow.id, {
      provider: "assemblyai",
      transcriptPath: join(config.transcriptsDir, "A.json"),
      transcriptText: "hello",
      durationSecs: 1,
    });

    const result = await cleanupRecorderCaptures(store, rootPath, {
      recorder: "mic-mini",
    });

    expect(result.dryRun).toBe(true);
    expect(result.scanned).toBe(3);
    expect(result.eligible).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.blockedUntranscribed).toBe(1);
    expect(result.blockedUntracked).toBe(1);
    expect(await exists(paths.a)).toBe(true);
    expect(await exists(paths.b)).toBe(true);
    expect(await exists(paths.c)).toBe(true);
    store.close();
  });

  test("deletes only transcript-ready tracked files with volume confirmation", async () => {
    const { config, rootPath, paths } = await setupRecorderFiles();
    const store = await openStore(config);
    const files = await scanRecorder(rootPath, "mic-mini");
    const transcribed = files.find((file) => file.fileName === "A.wav")!;
    const untranscribed = files.find((file) => file.fileName === "B.wav")!;
    const transcribedRow = await cloneRecording(config, transcribed);
    store.upsertRecording(transcribedRow);
    store.upsertRecording(await cloneRecording(config, untranscribed));
    store.markTranscribed(transcribedRow.id, {
      provider: "assemblyai",
      transcriptPath: join(config.transcriptsDir, "A.json"),
      transcriptText: "hello",
      durationSecs: 1,
    });

    const result = await cleanupRecorderCaptures(store, rootPath, {
      recorder: "mic-mini",
      deleteFiles: true,
      confirm: expectedRecorderConfirmation(rootPath),
    });

    expect(result.deleted).toBe(1);
    expect(await exists(paths.a)).toBe(false);
    expect(await exists(paths.b)).toBe(true);
    expect(await exists(paths.c)).toBe(true);
    store.close();
  });

  test("requires extra confirmation for untranscribed and untracked deletion", async () => {
    const { config, rootPath, paths } = await setupRecorderFiles();
    const store = await openStore(config);
    const files = await scanRecorder(rootPath, "mic-mini");
    const untranscribed = files.find((file) => file.fileName === "B.wav")!;
    store.upsertRecording(await cloneRecording(config, untranscribed));

    await expect(
      cleanupRecorderCaptures(store, rootPath, {
        recorder: "mic-mini",
        deleteFiles: true,
        confirm: expectedRecorderConfirmation(rootPath),
        includeUntranscribed: true,
        includeUntracked: true,
      }),
    ).rejects.toThrow("--confirm-risky delete-unverified");

    const result = await cleanupRecorderCaptures(store, rootPath, {
      recorder: "mic-mini",
      deleteFiles: true,
      confirm: expectedRecorderConfirmation(rootPath),
      includeUntranscribed: true,
      includeUntracked: true,
      confirmRisky: riskyCleanupConfirmation(),
    });

    expect(result.deleted).toBe(3);
    expect(await exists(paths.a)).toBe(false);
    expect(await exists(paths.b)).toBe(false);
    expect(await exists(paths.c)).toBe(false);
    store.close();
  });
});

async function setupRecorderFiles(): Promise<{
  config: AppConfig;
  rootPath: string;
  paths: { a: string; b: string; c: string };
}> {
  tempDir = await mkdtemp(join(tmpdir(), "listen-importer-cleanup-"));
  const rootPath = join(tempDir, "MIC MINI");
  await mkdir(rootPath);
  const paths = {
    a: join(rootPath, "A.wav"),
    b: join(rootPath, "B.wav"),
    c: join(rootPath, "C.wav"),
  };
  await writeFile(paths.a, "audio-a");
  await writeFile(paths.b, "audio-b");
  await writeFile(paths.c, "audio-c");
  return {
    rootPath,
    paths,
    config: {
      homeDir: join(tempDir, "state"),
      dbPath: join(tempDir, "state", "listen-importer.sqlite"),
      mediaDir: join(tempDir, "state", "media"),
      downsampledDir: join(tempDir, "state", "downsampled"),
      transcriptsDir: join(tempDir, "state", "transcripts"),
      listenSqlDb: "test-db",
      listenKvPrefix: "test-prefix",
      listenAppId: "test-app-id",
      mediaKvPath: "importer/media",
      metadataKvPath: "importer/metadata",
      transcriptKvPath: "importer/transcripts",
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
