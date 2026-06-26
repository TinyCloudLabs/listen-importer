import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { migrateListenState } from "../src/state-migration";

describe("migrateListenState", () => {
  let tempDir: string;
  let oldHome: string;
  let newHome: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "listen-state-"));
    oldHome = join(tempDir, ".listen-importer");
    newHome = join(tempDir, ".listen");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("moves old state to new state", async () => {
    await mkdir(oldHome, { recursive: true });
    await writeFile(join(oldHome, "listen-importer.sqlite"), "state");

    const result = await migrateListenState({ from: oldHome, to: newHome });

    expect(result).toMatchObject({ migrated: true, dryRun: false });
    expect(await readFile(join(newHome, "listen.sqlite"), "utf8")).toBe(
      "state",
    );
  });

  test("reports missing old state without failing", async () => {
    const result = await migrateListenState({ from: oldHome, to: newHome });

    expect(result).toMatchObject({
      migrated: false,
      dryRun: false,
      reason: "missing_source",
    });
  });

  test("refuses to overwrite existing new state", async () => {
    await mkdir(oldHome, { recursive: true });
    await mkdir(newHome, { recursive: true });

    const result = await migrateListenState({ from: oldHome, to: newHome });

    expect(result).toMatchObject({
      migrated: false,
      dryRun: false,
      reason: "target_exists",
    });
  });

  test("dry run reports planned move without moving files", async () => {
    await mkdir(oldHome, { recursive: true });

    const result = await migrateListenState({
      from: oldHome,
      to: newHome,
      dryRun: true,
    });

    expect(result).toMatchObject({ migrated: false, dryRun: true });
    expect(await pathExists(oldHome)).toBe(true);
    expect(await pathExists(newHome)).toBe(false);
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
