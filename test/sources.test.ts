import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { parseSince, scanImportSource } from "../src/sources";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("source scanning", () => {
  test("defaults --since to local midnight one week ago", () => {
    const since = parseSince(undefined, new Date(2026, 4, 26, 15, 30));

    expect(since.getFullYear()).toBe(2026);
    expect(since.getMonth()).toBe(4);
    expect(since.getDate()).toBe(19);
    expect(since.getHours()).toBe(0);
    expect(parseSince("yesterday", new Date(2026, 4, 26, 15)).getDate()).toBe(
      25,
    );
  });

  test("reads Voice Memos audio from a library with metadata", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "listen-importer-sources-"));
    await writeFile(join(tempDir, "memo-new.m4a"), "new audio");
    await writeFile(join(tempDir, "memo-old.m4a"), "old audio");
    const db = new Database(join(tempDir, "CloudRecordings.db"));
    db.exec(`
      CREATE TABLE ZCLOUDRECORDING (
        ZUNIQUEID TEXT,
        ZCUSTOMLABEL TEXT,
        ZDATE REAL,
        ZDURATION REAL,
        ZPATH TEXT
      )
    `);
    db.query(`INSERT INTO ZCLOUDRECORDING VALUES (?, ?, ?, ?, ?)`).run(
      "memo-new-id",
      "New Memo",
      appleSeconds("2026-05-25T15:00:00Z"),
      12.5,
      "memo-new.m4a",
    );
    db.query(`INSERT INTO ZCLOUDRECORDING VALUES (?, ?, ?, ?, ?)`).run(
      "memo-old-id",
      "Old Memo",
      appleSeconds("2026-05-24T15:00:00Z"),
      10,
      "memo-old.m4a",
    );
    db.close();

    const files = await scanImportSource("voice-memos", {
      path: tempDir,
      since: new Date("2026-05-25T00:00:00Z"),
    });

    expect(files).toHaveLength(1);
    expect(files[0]!.sourceAdapter).toBe("macos-voice-memos");
    expect(files[0]!.importType).toBe("voice-memo-audio");
    expect(files[0]!.listenSource).toBe("voice_memos");
    expect(files[0]!.sourceId).toBe("memo-new-id");
    expect(files[0]!.title).toBe("New Memo");
    expect(files[0]!.durationSecs).toBe(12.5);
  });

  test("reads VoxTerm markdown transcripts as transcript imports", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "listen-importer-sources-"));
    const transcriptPath = join(tempDir, "2026-05-25_101112-transcript.md");
    await writeFile(
      transcriptPath,
      [
        "# VoxTerm Transcript",
        "",
        "**[10:11:12]** **Sam:** First line",
        "",
        "**[10:11:13]** Second line",
        "",
      ].join("\n"),
    );

    const files = await scanImportSource("voxterm", {
      path: tempDir,
      since: new Date("2026-05-25T00:00:00Z"),
    });

    expect(files).toHaveLength(1);
    expect(files[0]!.sourceAdapter).toBe("voxterm");
    expect(files[0]!.importType).toBe("voxterm-transcript");
    expect(files[0]!.listenSource).toBe("voxterm");
    expect(files[0]!.artifactKind).toBe("transcript");
    expect(files[0]!.transcriptSegments).toEqual([
      {
        speaker_name: "Sam",
        text: "First line",
        start_time: null,
        end_time: null,
      },
      {
        speaker_name: "Unknown",
        text: "Second line",
        start_time: null,
        end_time: null,
      },
    ]);
  });
});

function appleSeconds(iso: string): number {
  return (Date.parse(iso) - Date.UTC(2001, 0, 1)) / 1000;
}
