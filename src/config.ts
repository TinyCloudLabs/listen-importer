import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_LISTEN_APP_ID = "xyz.tinycloud.listen";
export const DEFAULT_LISTEN_SQL_DB = `${DEFAULT_LISTEN_APP_ID}/conversations`;
export const DEFAULT_LISTEN_KV_PREFIX = DEFAULT_LISTEN_APP_ID;
export const DEFAULT_LISTEN_APP_SPACE = "applications";
export const DEFAULT_LISTEN_SECRET_SCOPE = "";

export interface AppConfig {
  homeDir: string;
  dbPath: string;
  mediaDir: string;
  downsampledDir: string;
  transcriptsDir: string;
  listenAppId: string;
  listenSqlDb: string;
  listenKvPrefix: string;
  listenAppSpace: string;
  listenSecretScope: string;
  mediaKvPath: string;
  metadataKvPath: string;
  transcriptKvPath: string;
}

export function getConfig(): AppConfig {
  const homeDir = resolve(
    process.env.LISTEN_HOME || join(homedir(), ".listen"),
  );
  const listenAppId = process.env.LISTEN_APP_ID || DEFAULT_LISTEN_APP_ID;
  const listenSqlDb =
    process.env.LISTEN_SQL_DB || remoteSqlDb({ listenAppId }, "conversations");
  const listenKvPrefix = stripSlashes(
    process.env.LISTEN_KV_PREFIX || listenAppId,
  );
  const listenAppSpace =
    process.env.LISTEN_APP_SPACE || DEFAULT_LISTEN_APP_SPACE;
  const listenSecretScope =
    process.env.LISTEN_SECRET_SCOPE || DEFAULT_LISTEN_SECRET_SCOPE;
  const mediaKvPath = stripSlashes(
    process.env.LISTEN_MEDIA_KV_PATH || "importer/media",
  );
  const metadataKvPath = stripSlashes(
    process.env.LISTEN_METADATA_KV_PATH || "importer/metadata",
  );
  const transcriptKvPath = stripSlashes(
    process.env.LISTEN_TRANSCRIPT_KV_PATH || "importer/transcripts",
  );

  return {
    homeDir,
    dbPath: join(homeDir, "listen.sqlite"),
    mediaDir: join(homeDir, "media"),
    downsampledDir: join(homeDir, "downsampled"),
    transcriptsDir: join(homeDir, "transcripts"),
    listenAppId,
    listenSqlDb,
    listenKvPrefix,
    listenAppSpace,
    listenSecretScope,
    mediaKvPath,
    metadataKvPath,
    transcriptKvPath,
  };
}

export function remoteKey(
  config: Pick<AppConfig, "listenKvPrefix">,
  key: string,
): string {
  return `${stripSlashes(config.listenKvPrefix)}/${stripSlashes(key)}`;
}

export function remoteSqlDb(
  config: Pick<AppConfig, "listenAppId">,
  db: string,
): string {
  return `${stripSlashes(config.listenAppId)}/${stripSlashes(db)}`;
}

function stripSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}
