#!/usr/bin/env tsx
import {
  formatStateMigrationResult,
  migrateListenState,
} from "../src/state-migration";

const args = parseArgs(process.argv.slice(2));
const result = await migrateListenState({
  from: args.from,
  to: args.to,
  dryRun: args.dryRun,
});

console.log(formatStateMigrationResult(result));
if (result.reason === "target_exists") process.exit(1);

function parseArgs(argv: string[]): {
  from?: string;
  to?: string;
  dryRun: boolean;
} {
  const parsed: { from?: string; to?: string; dryRun: boolean } = {
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--from" || arg === "--to") {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      if (arg === "--from") parsed.from = value;
      else parsed.to = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}
