import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { recordedAtFromName, scanRecorder } from "../src/media";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("media scanning", () => {
  test("finds recorder audio files recursively and skips non-audio", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "listen-importer-"));
    await mkdir(join(tempDir, "REC"), { recursive: true });
    await writeFile(join(tempDir, "REC", "20260513_101112.WAV"), "audio");
    await writeFile(join(tempDir, "REC", "notes.txt"), "nope");

    const files = await scanRecorder(tempDir, "mic-mini");

    expect(files).toHaveLength(1);
    expect(files[0]!.fileName).toBe("20260513_101112.WAV");
    expect(files[0]!.contentType).toBe("audio/wav");
    expect(files[0]!.recorder).toBe("mic-mini");
  });

  test("parses compact timestamps from file names", () => {
    expect(recordedAtFromName("DJI_20260513_101112_001.WAV")).toBe(
      "2026-05-13T10:11:12.000Z",
    );
  });
});
