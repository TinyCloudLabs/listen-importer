import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_LISTEN_APP_ID,
  getConfig,
  remoteSqlDb,
} from "../src/config";

const ENV_KEYS = [
  "LISTEN_APP_ID",
  "LISTEN_SQL_DB",
  "LISTEN_KV_PREFIX",
  "LISTEN_MEDIA_KV_PATH",
  "LISTEN_METADATA_KV_PATH",
  "LISTEN_TRANSCRIPT_KV_PATH",
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("config", () => {
  test("derives Listen storage from the manifest app id by default", () => {
    const config = getConfig();

    expect(config.listenAppId).toBe(DEFAULT_LISTEN_APP_ID);
    expect(config.listenSqlDb).toBe(`${DEFAULT_LISTEN_APP_ID}/conversations`);
    expect(config.listenKvPrefix).toBe(DEFAULT_LISTEN_APP_ID);
    expect(config.mediaKvPath).toBe("importer/media");
    expect(config.metadataKvPath).toBe("importer/metadata");
    expect(config.transcriptKvPath).toBe("importer/transcripts");
  });

  test("lets the app id drive the SQL and KV defaults when overridden", () => {
    process.env.LISTEN_APP_ID = "xyz.tinycloud.listen-beta";
    process.env.LISTEN_KV_PREFIX = "/listen-beta/";
    process.env.LISTEN_MEDIA_KV_PATH = "/media/";
    process.env.LISTEN_METADATA_KV_PATH = "/metadata/";
    process.env.LISTEN_TRANSCRIPT_KV_PATH = "/transcripts/";

    const config = getConfig();

    expect(config.listenAppId).toBe("xyz.tinycloud.listen-beta");
    expect(config.listenSqlDb).toBe("xyz.tinycloud.listen-beta/conversations");
    expect(config.listenKvPrefix).toBe("listen-beta");
    expect(config.mediaKvPath).toBe("media");
    expect(config.metadataKvPath).toBe("metadata");
    expect(config.transcriptKvPath).toBe("transcripts");
    expect(remoteSqlDb({ listenAppId: config.listenAppId }, "archive")).toBe(
      "xyz.tinycloud.listen-beta/archive",
    );
  });
});
