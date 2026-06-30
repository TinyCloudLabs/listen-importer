import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const spawnSync = vi.hoisted(() =>
  vi.fn(() => ({
    status: 0,
    stdout: "",
    stderr: "",
  })),
);

vi.mock("node:child_process", () => ({ spawnSync }));
vi.mock("../src/schema", () => ({
  ensureConversationSchema: vi.fn(async () => undefined),
  ensureRemoteImporterSchema: vi.fn(async () => undefined),
}));

const { openStore } = await import("../src/db");
const { uploadPending } = await import("../src/upload");

type SpawnCall = [string, string[], unknown?];

let tempDir: string | null = null;

beforeEach(() => {
  spawnSync.mockClear();
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("upload", () => {
  test("publishes Listen conversations and transcripts to the app space", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "listen-importer-upload-"));
    const transcriptPath = join(tempDir, "transcript.json");
    await writeFile(
      transcriptPath,
      JSON.stringify([
        {
          speaker_name: "Speaker A",
          text: " Hello there ",
          start_time: 1,
          end_time: 2,
        },
      ]),
    );

    const config = {
      homeDir: tempDir,
      dbPath: join(tempDir, "state.sqlite"),
      mediaDir: join(tempDir, "media"),
      downsampledDir: join(tempDir, "downsampled"),
      transcriptsDir: join(tempDir, "transcripts"),
      listenAppId: "test-prefix",
      listenSqlDb: "test-prefix/conversations",
      listenKvPrefix: "test-prefix",
      listenAppSpace: "applications",
      listenSecretScope: "listen",
      mediaKvPath: "importer/media",
      metadataKvPath: "importer/metadata",
      transcriptKvPath: "importer/transcripts",
    };
    const store = await openStore(config);
    const sha256 =
      "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    store.upsertRecording({
      id: sha256,
      sha256,
      sourcePath: "/Volumes/MIC MINI/A.WAV",
      localPath: join(tempDir, "media", "sha.wav"),
      fileName: "A.WAV",
      extension: ".wav",
      contentType: "audio/wav",
      recorder: "mic-mini",
      sizeBytes: 12,
      recordedAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      transcriptPath,
      durationSecs: 1,
    });

    const result = await uploadPending(config, store, 1, {
      publish: true,
      transcriptsOnly: true,
      listenSource: "recorder",
    });
    store.close();

    expect(result).toEqual({ uploaded: 0, published: 1, failed: 0 });

    const calls = spawnSync.mock.calls as unknown as SpawnCall[];
    const transcriptKvCall = calls.find(([, argv]) => {
      return (
        argv[0] === "kv" &&
        argv[1] === "put" &&
        argv[2]?.startsWith("test-prefix/transcript/")
      );
    });
    expect(transcriptKvCall).toBeUndefined();

    const conversationInsert = calls.find(([, argv]) => {
      return (
        argv[0] === "sql" &&
        argv[1] === "execute" &&
        argv[2]?.includes("INSERT OR REPLACE INTO conversation")
      );
    });
    expect(conversationInsert).toBeDefined();
    const paramsIndex = conversationInsert![1].indexOf("--params") + 1;
    const params = JSON.parse(conversationInsert![1][paramsIndex]!);
    expect(JSON.parse(params[10]!)).toEqual([
      {
        index: 0,
        speaker_id: "speaker-a",
        speaker_name: "Speaker A",
        text: "Hello there",
        start_time: 1,
        end_time: 2,
        language: null,
      },
    ]);
    expect(params[11]).toBe("Hello there");

    const sqlCalls = calls.filter(([, argv]) => {
      return argv[0] === "sql" && argv[1] === "execute";
    });
    expect(sqlCalls.length).toBeGreaterThan(0);
    for (const [, args] of sqlCalls) {
      expect(args.slice(-2)).toEqual(["--space", "applications"]);
    }
  });

  test("publishes Soundcore Sync conversations with a dedicated source and id prefix", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "listen-importer-upload-"));
    const transcriptPath = join(tempDir, "soundcore-transcript.json");
    await writeFile(
      transcriptPath,
      JSON.stringify([
        {
          speaker_name: "Ada",
          text: "Soundcore line",
          start_time: null,
          end_time: null,
        },
      ]),
    );

    const config = {
      homeDir: tempDir,
      dbPath: join(tempDir, "state.sqlite"),
      mediaDir: join(tempDir, "media"),
      downsampledDir: join(tempDir, "downsampled"),
      transcriptsDir: join(tempDir, "transcripts"),
      listenAppId: "test-prefix",
      listenSqlDb: "test-prefix/conversations",
      listenKvPrefix: "test-prefix",
      listenAppSpace: "applications",
      listenSecretScope: "listen",
      mediaKvPath: "importer/media",
      metadataKvPath: "importer/metadata",
      transcriptKvPath: "importer/transcripts",
    };
    const store = await openStore(config);
    const sha256 =
      "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

    store.upsertRecording({
      id: sha256,
      sha256,
      sourcePath: "/Soundcore/2026-06-08-planning.md",
      localPath: join(tempDir, "media", "sha.md"),
      fileName: "2026-06-08-planning.md",
      extension: ".md",
      contentType: "text/markdown",
      sourceAdapter: "soundcore-sync",
      importType: "soundcore-transcript",
      listenSource: "soundcore_sync",
      sourceId: "soundcore-sync:2026-06/2026-06-08-planning.md",
      sourceUri: "/Soundcore/2026-06-08-planning.md",
      title: "Planning",
      artifactKind: "transcript",
      metadataJson: JSON.stringify({ source_app: "Soundcore" }),
      recorder: "soundcore-sync",
      sizeBytes: 12,
      recordedAt: "2026-06-08T00:00:00.000Z",
      modifiedAt: "2026-06-08T00:00:00.000Z",
      transcriptPath,
      transcriptText: "Soundcore line",
      durationSecs: 60,
    });

    const result = await uploadPending(config, store, 1, {
      publish: true,
      transcriptsOnly: true,
      listenSource: "soundcore_sync",
    });
    store.close();

    expect(result).toEqual({ uploaded: 0, published: 1, failed: 0 });

    const calls = spawnSync.mock.calls as unknown as SpawnCall[];
    const transcriptKvCall = calls.find(([, argv]) => {
      return (
        argv[0] === "kv" &&
        argv[1] === "put" &&
        argv[2]?.startsWith("test-prefix/transcript/")
      );
    });
    expect(transcriptKvCall).toBeUndefined();

    const conversationInsert = calls.find(([, argv]) => {
      return (
        argv[0] === "sql" &&
        argv[1] === "execute" &&
        argv[2]?.includes("INSERT OR REPLACE INTO conversation")
      );
    });
    expect(conversationInsert).toBeDefined();
    const paramsIndex = conversationInsert![1].indexOf("--params") + 1;
    const params = JSON.parse(conversationInsert![1][paramsIndex]!);
    expect(params[0]).toBe("sc-1234567890abcdef12345678");
    expect(params[2]).toBe("soundcore_sync");
    expect(params[3]).toBe(
      "soundcore-sync:soundcore-sync:2026-06/2026-06-08-planning.md",
    );
    expect(JSON.parse(params[10]!)).toHaveLength(1);
    expect(params[11]).toBe("Soundcore line");
  });
});
