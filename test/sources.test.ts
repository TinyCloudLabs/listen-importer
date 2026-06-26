import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
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
    db.prepare(`INSERT INTO ZCLOUDRECORDING VALUES (?, ?, ?, ?, ?)`).run(
      "memo-new-id",
      "New Memo",
      appleSeconds("2026-05-25T15:00:00Z"),
      12.5,
      "memo-new.m4a",
    );
    db.prepare(`INSERT INTO ZCLOUDRECORDING VALUES (?, ?, ?, ?, ?)`).run(
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

  test("skips deleted Voice Memos unless requested", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "listen-importer-sources-"));
    await writeFile(join(tempDir, "active.m4a"), "active audio");
    await writeFile(join(tempDir, "deleted.m4a"), "deleted audio");
    const db = new Database(join(tempDir, "CloudRecordings.db"));
    db.exec(`
      CREATE TABLE ZCLOUDRECORDING (
        ZUNIQUEID TEXT,
        ZCUSTOMLABEL TEXT,
        ZDATE REAL,
        ZDURATION REAL,
        ZPATH TEXT,
        ZFLAGS INTEGER
      )
    `);
    db.prepare(`INSERT INTO ZCLOUDRECORDING VALUES (?, ?, ?, ?, ?, ?)`).run(
      "active-id",
      "Active Memo",
      appleSeconds("2026-05-25T15:00:00Z"),
      12.5,
      "active.m4a",
      4,
    );
    db.prepare(`INSERT INTO ZCLOUDRECORDING VALUES (?, ?, ?, ?, ?, ?)`).run(
      "deleted-id",
      "Deleted Memo",
      appleSeconds("2026-05-25T16:00:00Z"),
      8,
      "deleted.m4a",
      1540,
    );
    db.close();

    const defaultFiles = await scanImportSource("voice-memos", {
      path: tempDir,
      since: new Date("2026-05-25T00:00:00Z"),
    });
    const includingDeleted = await scanImportSource("voice-memos", {
      path: tempDir,
      since: new Date("2026-05-25T00:00:00Z"),
      includeDeleted: true,
    });

    expect(defaultFiles.map((file) => file.sourceId)).toEqual(["active-id"]);
    expect(includingDeleted.map((file) => file.sourceId)).toEqual([
      "active-id",
      "deleted-id",
    ]);
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

  test("reads Soundcore Sync markdown transcripts as transcript imports", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "listen-importer-sources-"));
    const transcriptPath = join(tempDir, "2026-06", "2026-06-08-planning.md");
    await mkdir(join(tempDir, "2026-06"), { recursive: true });
    await writeFile(
      transcriptPath,
      [
        "# Synthetic Soundcore Planning Meeting",
        "**Date:** 2026-06-08",
        "**Duration:** 23 min",
        "",
        "## Summary",
        "",
        "**What**: The team weighs charging per widget.",
        "",
        "## Transcript",
        "",
        "**Ada:**",
        "We should charge by the widget.",
        "",
        "**speaker1:**",
        "Plan B: we ship the pricing change Friday.",
        "",
      ].join("\n"),
    );

    const files = await scanImportSource("soundcore-sync", {
      path: tempDir,
      since: new Date("2026-06-01T00:00:00Z"),
    });

    expect(files).toHaveLength(1);
    expect(files[0]!.sourceAdapter).toBe("soundcore-sync");
    expect(files[0]!.importType).toBe("soundcore-transcript");
    expect(files[0]!.listenSource).toBe("soundcore_sync");
    expect(files[0]!.artifactKind).toBe("transcript");
    expect(files[0]!.title).toBe("Synthetic Soundcore Planning Meeting");
    expect(files[0]!.durationSecs).toBe(23 * 60);
    expect(files[0]!.recordedAt).toBe("2026-06-08T00:00:00.000Z");
    expect(files[0]!.sourceId).toBe(
      "soundcore-sync:2026-06/2026-06-08-planning.md",
    );
    expect(files[0]!.transcriptSegments).toEqual([
      {
        speaker_name: "Ada",
        text: "We should charge by the widget.",
        start_time: null,
        end_time: null,
      },
      {
        speaker_name: "speaker1",
        text: "Plan B: we ship the pricing change Friday.",
        start_time: null,
        end_time: null,
      },
    ]);
    expect(JSON.parse(files[0]!.metadataJson!)).toMatchObject({
      source_app: "Soundcore",
      has_transcript: true,
      empty_transcript: false,
    });
  });

  test("does not treat empty Soundcore placeholder as spoken text", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "listen-importer-sources-"));
    const transcriptPath = join(tempDir, "2026-06-07-empty.md");
    await writeFile(
      transcriptPath,
      [
        "# 2026-06-07 15:05:32",
        "**Date:** 2026-06-07",
        "**Duration:** 0 min",
        "",
        "## Transcript",
        "",
        "_(No transcript segments available.)_",
        "",
      ].join("\n"),
    );

    const files = await scanImportSource("soundcore-sync", {
      path: tempDir,
      since: new Date("2026-06-01T00:00:00Z"),
    });

    expect(files).toHaveLength(1);
    expect(files[0]!.transcriptSegments).toEqual([]);
    expect(files[0]!.transcriptText).toBe("");
    expect(JSON.parse(files[0]!.metadataJson!)).toMatchObject({
      has_transcript: false,
      empty_transcript: true,
    });
  });
});

function appleSeconds(iso: string): number {
  return (Date.parse(iso) - Date.UTC(2001, 0, 1)) / 1000;
}
