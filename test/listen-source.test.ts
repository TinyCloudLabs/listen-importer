import { describe, expect, test } from "vitest";
import { parseListenSource } from "../src/listen-source";

describe("Listen source parsing", () => {
  test("accepts canonical sources and aliases", () => {
    expect(parseListenSource(undefined)).toBeUndefined();
    expect(parseListenSource("all")).toBeUndefined();
    expect(parseListenSource("recorder")).toBe("recorder");
    expect(parseListenSource("voice_memos")).toBe("voice_memos");
    expect(parseListenSource("voice-memos")).toBe("voice_memos");
    expect(parseListenSource("voxterm")).toBe("voxterm");
    expect(parseListenSource("soundcore_sync")).toBe("soundcore_sync");
    expect(parseListenSource("soundcore-sync")).toBe("soundcore_sync");
    expect(() => parseListenSource("voice")).toThrow("--source must be");
  });
});
