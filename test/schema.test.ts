import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const apply = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const query = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, data: { rows: [] } })),
);
const restoreSession = vi.hoisted(() => vi.fn(async () => undefined));
const sqlForSpace = vi.hoisted(() =>
  vi.fn(() => ({
    db: vi.fn(() => ({
      migrations: { apply },
      query,
    })),
  })),
);

vi.mock("@tinycloud/node-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tinycloud/node-sdk")>();
  class TinyCloudNodeMock {
    restoreSession = restoreSession;
    signIn = vi.fn(async () => undefined);
    sqlForSpace = sqlForSpace;
  }

  return {
    ...actual,
    TinyCloudNode: TinyCloudNodeMock,
  };
});

const { ensureConversationSchema, ensureRemoteImporterSchema } =
  await import("../src/schema");

let tempHome: string | null = null;
let originalHome: string | undefined;

beforeEach(async () => {
  apply.mockClear();
  query.mockClear();
  restoreSession.mockClear();
  sqlForSpace.mockClear();

  originalHome = process.env.HOME;
  tempHome = await mkdtemp(join(tmpdir(), "listen-importer-schema-"));
  process.env.HOME = tempHome;
  await writeProfile(tempHome);
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (tempHome) await rm(tempHome, { recursive: true, force: true });
  tempHome = null;
});

describe("remote schema migrations", () => {
  test("uses sql migrations for importer table setup", async () => {
    await ensureRemoteImporterSchema(config(), {});

    expect(sqlForSpace).toHaveBeenCalledWith(
      "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications",
    );
    expect(apply).toHaveBeenCalledWith({
      namespace: "xyz.tinycloud.listen.conversations",
      migrations: [
        {
          id: "001_create_importer_recording",
          sql: [
            expect.stringContaining(
              "CREATE TABLE IF NOT EXISTS listen_importer_recording",
            ),
          ],
        },
      ],
    });
  });

  test("applies conversation migrations and alters missing transcript columns", async () => {
    query.mockResolvedValueOnce({
      ok: true,
      data: {
        rows: [{ name: "id" }, { name: "created_at" }, { name: "updated_at" }],
      },
    } as never);

    await ensureConversationSchema(config(), {});

    expect(apply).toHaveBeenCalledWith({
      namespace: "xyz.tinycloud.listen.conversations",
      migrations: [
        {
          id: "002_create_conversation",
          sql: [
            expect.stringContaining("CREATE TABLE IF NOT EXISTS conversation"),
          ],
        },
        {
          id: "003_create_participant",
          sql: [
            expect.stringContaining("CREATE TABLE IF NOT EXISTS participant"),
          ],
        },
        {
          id: "004_add_conversation_transcript_json",
          sql: ["ALTER TABLE conversation ADD COLUMN transcript_json TEXT"],
        },
        {
          id: "005_add_conversation_transcript_text",
          sql: ["ALTER TABLE conversation ADD COLUMN transcript_text TEXT"],
        },
      ],
    });
  });

  test("records transcript migrations as no-ops when columns already exist", async () => {
    query.mockResolvedValueOnce({
      ok: true,
      data: {
        rows: [
          [0, "id"],
          [1, "transcript_json"],
          [2, "transcript_text"],
        ],
      },
    } as never);

    await ensureConversationSchema(config(), {});

    const firstCall = apply.mock.calls[0] as unknown as [
      { migrations: unknown[] },
    ];
    const migrations = firstCall[0].migrations;
    expect(migrations[2]).toEqual({
      id: "004_add_conversation_transcript_json",
      sql: [],
    });
    expect(migrations[3]).toEqual({
      id: "005_add_conversation_transcript_text",
      sql: [],
    });
  });
});

async function writeProfile(home: string): Promise<void> {
  const profileDir = join(home, ".tinycloud", "profiles", "default");
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(home, ".tinycloud", "config.json"),
    JSON.stringify({ defaultProfile: "default", version: 1 }),
  );
  await writeFile(
    join(profileDir, "profile.json"),
    JSON.stringify({
      name: "default",
      host: "https://node.example",
      address: "0x1111111111111111111111111111111111111111",
      chainId: 1,
    }),
  );
  await writeFile(join(profileDir, "key.json"), JSON.stringify({ kty: "OKP" }));
  await writeFile(
    join(profileDir, "session.json"),
    JSON.stringify({
      delegationHeader: { Authorization: "tc test" },
      delegationCid: "bafytest",
      spaceId:
        "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default",
      jwk: { kty: "OKP" },
      verificationMethod: "did:key:test#test",
      address: "0x1111111111111111111111111111111111111111",
      chainId: 1,
    }),
  );
}

function config() {
  return {
    homeDir: tempHome!,
    dbPath: join(tempHome!, "state.sqlite"),
    mediaDir: join(tempHome!, "media"),
    downsampledDir: join(tempHome!, "downsampled"),
    transcriptsDir: join(tempHome!, "transcripts"),
    listenAppId: "xyz.tinycloud.listen",
    listenSqlDb: "xyz.tinycloud.listen/conversations",
    listenKvPrefix: "xyz.tinycloud.listen",
    listenAppSpace: "applications",
    listenSecretScope: "listen",
    mediaKvPath: "importer/media",
    metadataKvPath: "importer/metadata",
    transcriptKvPath: "importer/transcripts",
  };
}
