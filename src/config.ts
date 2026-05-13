import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_LISTEN_SQL_DB = "xyz.tinycloud.listen/conversations";
export const DEFAULT_LISTEN_KV_PREFIX = "xyz.tinycloud.listen";

export interface AppConfig {
  homeDir: string;
  dbPath: string;
  mediaDir: string;
  listenSqlDb: string;
  listenKvPrefix: string;
}

export function getConfig(): AppConfig {
  const homeDir = resolve(
    process.env.LISTEN_IMPORTER_HOME || join(homedir(), ".listen-importer"),
  );
  const listenSqlDb =
    process.env.LISTEN_IMPORTER_SQL_DB || DEFAULT_LISTEN_SQL_DB;
  const listenKvPrefix = stripSlashes(
    process.env.LISTEN_IMPORTER_KV_PREFIX || DEFAULT_LISTEN_KV_PREFIX,
  );

  return {
    homeDir,
    dbPath: join(homeDir, "listen-importer.sqlite"),
    mediaDir: join(homeDir, "media"),
    listenSqlDb,
    listenKvPrefix,
  };
}

export function remoteKey(
  config: Pick<AppConfig, "listenKvPrefix">,
  key: string,
): string {
  return `${stripSlashes(config.listenKvPrefix)}/${stripSlashes(key)}`;
}

function stripSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}
