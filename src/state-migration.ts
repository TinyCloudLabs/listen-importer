import { cp, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface StateMigrationOptions {
  from?: string;
  to?: string;
  dryRun?: boolean;
}

export interface StateMigrationResult {
  from: string;
  to: string;
  migrated: boolean;
  dryRun: boolean;
  reason?: "missing_source" | "target_exists";
}

export async function migrateListenState(
  options: StateMigrationOptions = {},
): Promise<StateMigrationResult> {
  const from = resolve(options.from ?? join(homedir(), ".listen-importer"));
  const to = resolve(
    options.to ?? process.env.LISTEN_HOME ?? join(homedir(), ".listen"),
  );
  const dryRun = options.dryRun === true;

  const sourceExists = await exists(from);
  if (!sourceExists) {
    return { from, to, migrated: false, dryRun, reason: "missing_source" };
  }

  const targetExists = await exists(to);
  if (targetExists) {
    return { from, to, migrated: false, dryRun, reason: "target_exists" };
  }

  if (dryRun) return { from, to, migrated: false, dryRun };

  try {
    await rename(from, to);
  } catch (err) {
    if (!isCrossDeviceError(err)) throw err;
    await cp(from, to, { recursive: true, preserveTimestamps: true });
    await rm(from, { recursive: true, force: true });
  }
  await renameLegacyDatabase(to);

  return { from, to, migrated: true, dryRun };
}

export function formatStateMigrationResult(
  result: StateMigrationResult,
): string {
  if (result.reason === "missing_source") {
    return `No old state found at ${result.from}`;
  }

  if (result.reason === "target_exists") {
    return `Refusing to migrate because ${result.to} already exists`;
  }

  if (result.dryRun) {
    return `Would move ${result.from} to ${result.to}`;
  }

  return `Moved ${result.from} to ${result.to}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw err;
  }
}

async function renameLegacyDatabase(homeDir: string): Promise<void> {
  const oldDbPath = join(homeDir, "listen-importer.sqlite");
  const newDbPath = join(homeDir, "listen.sqlite");
  if (!(await exists(oldDbPath)) || (await exists(newDbPath))) return;
  await rename(oldDbPath, newDbPath);
}

function isCrossDeviceError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EXDEV"
  );
}
