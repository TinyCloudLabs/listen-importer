import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  TinyCloudNode,
  canonicalizeAddress,
  makePkhSpaceId,
  parseSpaceUri,
  type QueryResponse,
  type TinyCloudSession,
} from "@tinycloud/node-sdk";
import type { AppConfig } from "./config";
import type { TcOptions } from "./tc";

const DEFAULT_PROFILE = "default";
const DEFAULT_HOST = "https://node.tinycloud.xyz";
const MIGRATION_NAMESPACE = "xyz.tinycloud.listen.conversations";

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
  source_adapter TEXT,
  import_type TEXT,
  listen_source TEXT,
  source_id TEXT,
  artifact_kind TEXT,
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

interface ProfileConfig {
  name?: string;
  host?: string;
  address?: string;
  chainId?: number;
  ownerDid?: string;
  defaultSpace?: string;
  privateKey?: string;
}

interface CliConfig {
  defaultProfile?: string;
}

type StoredSession = TinyCloudSession & {
  address?: string;
  chainId?: number;
};

interface SqlMigration {
  id: string;
  sql: Array<string | { sql: string; params?: unknown[] }>;
}

interface MigrationDatabase {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<
    | { ok: true; data: QueryResponse }
    | { ok: false; error: { message: string } }
  >;
  migrations: {
    apply(options: {
      namespace: string;
      migrations: SqlMigration[];
    }): Promise<{ ok: true } | { ok: false; error: { message: string } }>;
  };
}

export async function ensureRemoteImporterSchema(
  config: AppConfig,
  options: TcOptions,
): Promise<void> {
  const db = await listenDatabase(config, options);
  await applyMigrations(db, [
    {
      id: "001_create_importer_recording",
      sql: [IMPORTER_TABLE_SQL],
    },
  ]);
}

export async function ensureConversationSchema(
  config: AppConfig,
  options: TcOptions,
): Promise<void> {
  const db = await listenDatabase(config, options);
  const columns = await conversationColumns(db);
  await applyMigrations(db, [
    {
      id: "002_create_conversation",
      sql: [CONVERSATION_TABLE_SQL],
    },
    {
      id: "003_create_participant",
      sql: [PARTICIPANT_TABLE_SQL],
    },
    {
      id: "004_add_conversation_transcript_json",
      sql:
        columns && columns.has("transcript_json")
          ? []
          : ["ALTER TABLE conversation ADD COLUMN transcript_json TEXT"],
    },
    {
      id: "005_add_conversation_transcript_text",
      sql:
        columns && columns.has("transcript_text")
          ? []
          : ["ALTER TABLE conversation ADD COLUMN transcript_text TEXT"],
    },
  ]);
}

async function listenDatabase(
  config: AppConfig,
  options: TcOptions,
): Promise<MigrationDatabase> {
  const context = await loadTinyCloudContext(options);
  const node = new TinyCloudNode({
    host: context.host,
    privateKey: context.profile.privateKey,
  });

  if (context.session?.delegationHeader && context.session.delegationCid) {
    await node.restoreSession({
      delegationHeader: context.session.delegationHeader,
      delegationCid: context.session.delegationCid,
      spaceId: context.session.spaceId,
      jwk: context.session.jwk ?? context.key,
      verificationMethod:
        context.session.verificationMethod ?? context.profile.ownerDid ?? "",
      address: context.session.address,
      chainId: context.session.chainId,
      siwe: context.session.siwe,
      signature: context.session.signature,
    });
  } else if (context.profile.privateKey) {
    await node.signIn();
  } else {
    throw new Error(
      `Not authenticated. Run \`tc auth login\` or \`tc init\` for profile "${context.profileName}" first.`,
    );
  }

  const space = resolveSpaceUri(config.listenAppSpace, context);
  return node
    .sqlForSpace(space)
    .db(config.listenSqlDb) as unknown as MigrationDatabase;
}

async function applyMigrations(
  db: MigrationDatabase,
  migrations: SqlMigration[],
): Promise<void> {
  const result = await db.migrations.apply({
    namespace: MIGRATION_NAMESPACE,
    migrations,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

async function conversationColumns(
  db: MigrationDatabase,
): Promise<Set<string> | null> {
  const result = await db.query("PRAGMA table_info(conversation)");
  if (!result.ok) return null;

  const names = queryRows(result.data)
    .map((row) => rowValue(row, "name", 1))
    .filter((value): value is string => typeof value === "string");
  return new Set(names);
}

function queryRows(data: QueryResponse): unknown[] {
  const rows = (data as { rows?: unknown[] }).rows;
  return Array.isArray(rows) ? rows : [];
}

function rowValue(row: unknown, key: string, index: number): unknown {
  if (Array.isArray(row)) return row[index];
  if (row && typeof row === "object") {
    return (row as Record<string, unknown>)[key];
  }
  return undefined;
}

async function loadTinyCloudContext(options: TcOptions): Promise<{
  profileName: string;
  host: string;
  profile: ProfileConfig;
  session: StoredSession | null;
  key: object | null;
}> {
  const profileName = await resolveProfileName(options.profile);
  const profile = await readProfileJson<ProfileConfig>(
    profileName,
    "profile.json",
  );
  if (!profile) {
    throw new Error(
      `Profile "${profileName}" does not exist. Run \`tc init\` or \`tc profile create ${profileName}\` first.`,
    );
  }

  return {
    profileName,
    host: options.host ?? process.env.TC_HOST ?? profile.host ?? DEFAULT_HOST,
    profile,
    session: await readProfileJson<StoredSession>(profileName, "session.json"),
    key: await readProfileJson<object>(profileName, "key.json"),
  };
}

async function resolveProfileName(
  explicit: string | undefined,
): Promise<string> {
  if (explicit) return explicit;
  if (process.env.TC_PROFILE) return process.env.TC_PROFILE;

  const config = await readJson<CliConfig>(join(tinycloudDir(), "config.json"));
  return config?.defaultProfile ?? DEFAULT_PROFILE;
}

async function readProfileJson<T>(
  profileName: string,
  fileName: string,
): Promise<T | null> {
  return readJson<T>(join(tinycloudDir(), "profiles", profileName, fileName));
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

function tinycloudDir(): string {
  return join(homedir(), ".tinycloud");
}

function resolveSpaceUri(
  input: string,
  context: {
    profile: ProfileConfig;
    session: StoredSession | null;
    profileName: string;
  },
): string {
  if (input.startsWith("tinycloud:")) {
    const parsed = parseSpaceUri(input);
    if (!parsed) throw new Error(`Invalid space "${input}".`);
    return `tinycloud:${parsed.owner}:${parsed.name}`;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new Error(`Invalid space "${input}".`);
  }

  const address = resolveAddress(context.profile, context.session);
  const chainId = context.session?.chainId ?? context.profile.chainId ?? 1;
  return makePkhSpaceId(address, chainId, input);
}

function resolveAddress(
  profile: ProfileConfig,
  session: StoredSession | null,
): string {
  const candidate = session?.address ?? profile.address;
  if (candidate) return canonicalizeAddress(candidate);

  const match = profile.ownerDid?.match(
    /^did:pkh:eip155:\d+:(0x[a-fA-F0-9]{40})$/,
  );
  if (match) return canonicalizeAddress(match[1]);

  throw new Error(
    `Cannot determine Ethereum address for profile "${profile.name ?? DEFAULT_PROFILE}". Run \`tc auth login\` to refresh the session.`,
  );
}
