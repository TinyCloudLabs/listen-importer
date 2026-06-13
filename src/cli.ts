#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import {
  cleanupRecorderCaptures,
  expectedRecorderConfirmation,
  riskyCleanupConfirmation,
  type CleanupRecorderResult,
} from "./cleanup";
import { getConfig } from "./config";
import {
  downsamplePending,
  parseDownsampleFormat,
  type DownsampleFormat,
} from "./downsample";
import { openStore } from "./db";
import { parseListenSource } from "./listen-source";
import { cloneRecording, detectRecorder, scanRecorder } from "./media";
import {
  formatSince,
  parseImportSource,
  parseSince,
  scanImportSource,
} from "./sources";
import { authStatus, createDelegation, type TcOptions } from "./tc";
import { transcribePending, type TranscriptionProvider } from "./transcription";
import { uploadPending } from "./upload";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = getConfig();

  switch (args.command) {
    case "init": {
      await mkdir(config.homeDir, { recursive: true });
      await mkdir(config.mediaDir, { recursive: true });
      await mkdir(config.downsampledDir, { recursive: true });
      await mkdir(config.transcriptsDir, { recursive: true });
      const store = await openStore(config);
      store.close();
      console.log(`Initialized ${config.homeDir}`);
      break;
    }

    case "auth": {
      console.log(authStatus(tcOptions(args)));
      break;
    }

    case "permissions": {
      const to = stringFlag(args, "to");
      const expiry = stringFlag(args, "expiry") ?? "30d";
      if (!to) {
        console.log("Required TinyCloud capabilities:");
        console.log(`- KV get/put/list under ${config.listenKvPrefix}/`);
        console.log(
          `- SQL read/write on ${config.listenSqlDb} from your authenticated tc profile`,
        );
        console.log("Pass --to <did> to create the KV delegation with tc.");
        break;
      }
      const output = createDelegation(
        to,
        `${config.listenKvPrefix}/`,
        ["kv/get", "kv/put", "kv/list"],
        expiry,
        tcOptions(args),
      );
      console.log(output);
      break;
    }

    case "scan": {
      const rootPath = args.positionals[0];
      if (!rootPath) throw new Error("scan requires a recorder path");
      const recorder = stringFlag(args, "recorder") ?? detectRecorder(rootPath);
      const dryRun = Boolean(args.flags["dry-run"]);
      const files = await scanRecorder(rootPath, recorder);
      if (dryRun) {
        console.log(JSON.stringify({ found: files.length, files }, null, 2));
        break;
      }

      const store = await openStore(config);
      let created = 0;
      let updated = 0;
      let skipped = 0;
      for (const file of files) {
        if (store.hasSourceSnapshot(file)) {
          skipped += 1;
          continue;
        }
        const cloned = await cloneRecording(config, file);
        const result = store.upsertRecording(cloned);
        if (result === "created") created += 1;
        else updated += 1;
      }
      store.close();
      console.log(
        `Scanned ${files.length} audio file(s): ${created} new, ${updated} updated, ${skipped} unchanged`,
      );
      break;
    }

    case "scan-source": {
      const source = parseImportSource(args.positionals[0]);
      const since = parseSince(stringFlag(args, "since"));
      const dryRun = Boolean(args.flags["dry-run"]);
      const files = await scanImportSource(source, {
        since,
        path: stringFlag(args, "path") ?? stringFlag(args, "library"),
        includeDeleted: Boolean(args.flags["include-deleted"]),
      });
      if (dryRun) {
        console.log(
          JSON.stringify(
            { source, since: formatSince(since), found: files.length, files },
            null,
            2,
          ),
        );
        break;
      }

      const store = await openStore(config);
      const result = await cacheFiles(config, store, files);
      store.close();
      console.log(
        `Scanned ${files.length} ${source} item(s) since ${formatSince(since)}: ${result.created} new, ${result.updated} updated, ${result.skipped} unchanged`,
      );
      break;
    }

    case "cleanup-recorder":
    case "delete-recorder-captures": {
      const rootPath = args.positionals[0];
      if (!rootPath)
        throw new Error(`${args.command} requires a recorder path`);
      const store = await openStore(config);
      const result = await cleanupRecorderCaptures(store, rootPath, {
        recorder: stringFlag(args, "recorder"),
        deleteFiles: Boolean(args.flags.delete),
        confirm: stringFlag(args, "confirm"),
        includeUntranscribed: Boolean(args.flags["include-untranscribed"]),
        includeUntracked: Boolean(args.flags["include-untracked"]),
        confirmRisky: stringFlag(args, "confirm-risky"),
      });
      store.close();
      if (args.flags.json) console.log(JSON.stringify(result, null, 2));
      else printCleanupRecorderResult(result, Boolean(args.flags.verbose));
      break;
    }

    case "status": {
      const source = sourceFlag(args);
      const store = await openStore(config);
      const counts = store.counts(source);
      store.close();
      if (args.flags.json) console.log(JSON.stringify(counts, null, 2));
      else {
        console.log(`Total: ${counts.total}`);
        console.log(`Cloned: ${counts.cloned}`);
        console.log(`Uploaded: ${counts.uploaded}`);
        console.log(`Published: ${counts.published}`);
        console.log(`Failed: ${counts.failed}`);
        console.log(
          `Transcripts: ${counts.transcript_ready} ready, ${counts.transcript_missing} missing`,
        );
        console.log(
          `Downsampled: ${counts.downsampled_ready} ready, ${counts.downsampled_missing} missing`,
        );
      }
      break;
    }

    case "list": {
      const limit = numberFlag(args, "limit") ?? 50;
      const source = sourceFlag(args);
      const store = await openStore(config);
      const rows = store.list(limit, source);
      store.close();
      for (const row of rows) {
        console.log(
          `${row.status.padEnd(9)} ${row.listen_source.padEnd(12)} ${row.file_name} ${row.sha256.slice(0, 12)}`,
        );
      }
      break;
    }

    case "downsample":
    case "preprocess": {
      const limit = numberFlag(args, "limit") ?? 25;
      const source = sourceFlag(args);
      const store = await openStore(config);
      const result = await downsamplePending(config, store, {
        limit,
        force: Boolean(args.flags.force),
        format: formatFlag(args),
        bitrate: stringFlag(args, "bitrate"),
        sampleRate: numberFlag(args, "sample-rate"),
        listenSource: source,
      });
      store.close();
      const verb =
        args.command === "preprocess" ? "Preprocessed" : "Downsampled";
      console.log(`${verb} ${result.downsampled}; failed ${result.failed}`);
      break;
    }

    case "transcribe": {
      const limit = numberFlag(args, "limit") ?? 10;
      const source = sourceFlag(args);
      const store = await openStore(config);
      const result = await transcribePending(config, store, {
        provider: providerFlag(args),
        apiKey: stringFlag(args, "api-key"),
        limit,
        force: Boolean(args.flags.force),
        model: stringFlag(args, "model"),
        language: stringFlag(args, "language"),
        listenSource: source,
      });
      store.close();
      console.log(`Transcribed ${result.transcribed}; failed ${result.failed}`);
      break;
    }

    case "upload": {
      const limit = numberFlag(args, "limit") ?? 25;
      const store = await openStore(config);
      const result = await uploadPending(config, store, limit, {
        ...tcOptions(args),
        publish: Boolean(args.flags.publish),
        useDownsampled: Boolean(args.flags["use-downsampled"]),
        transcriptsOnly: Boolean(args.flags["transcripts-only"]),
        listenSource: sourceFlag(args),
      });
      store.close();
      console.log(
        `Uploaded ${result.uploaded}; published ${result.published}; failed ${result.failed}`,
      );
      break;
    }

    case "doctor": {
      await openStore(config).then((store) => store.close());
      console.log(`State: ${config.homeDir}`);
      console.log(`Database: ${config.dbPath}`);
      console.log(`Media: ${config.mediaDir}`);
      console.log(`Downsampled: ${config.downsampledDir}`);
      console.log(`Transcripts: ${config.transcriptsDir}`);
      console.log(`Listen SQL DB: ${config.listenSqlDb}`);
      console.log(`Listen KV prefix: ${config.listenKvPrefix}`);
      console.log(`Listen app space: ${config.listenAppSpace}`);
      try {
        console.log(authStatus(tcOptions(args)));
      } catch (err) {
        console.log(err instanceof Error ? err.message : String(err));
      }
      break;
    }

    case "help":
    default:
      printHelp();
      if (args.command !== "help") process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }

    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      i += 1;
    } else {
      flags[rawKey] = true;
    }
  }

  return { command, positionals, flags };
}

function tcOptions(args: ParsedArgs): TcOptions {
  return {
    profile: stringFlag(args, "profile"),
    host: stringFlag(args, "host"),
  };
}

async function cacheFiles(
  config: ReturnType<typeof getConfig>,
  store: Awaited<ReturnType<typeof openStore>>,
  files: Awaited<ReturnType<typeof scanRecorder>>,
): Promise<{ created: number; updated: number; skipped: number }> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const file of files) {
    if (store.hasSourceSnapshot(file)) {
      skipped += 1;
      continue;
    }
    const cloned = await cloneRecording(config, file);
    const result = store.upsertRecording(cloned);
    if (result === "created") created += 1;
    else updated += 1;
  }
  return { created, updated, skipped };
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1)
    throw new Error(`--${name} must be a positive number`);
  return Math.floor(parsed);
}

function providerFlag(args: ParsedArgs): TranscriptionProvider | undefined {
  const provider = stringFlag(args, "provider");
  if (!provider) return undefined;
  if (provider === "deepgram" || provider === "assemblyai") return provider;
  throw new Error("--provider must be deepgram or assemblyai");
}

function formatFlag(args: ParsedArgs): DownsampleFormat | undefined {
  return parseDownsampleFormat(stringFlag(args, "format"));
}

function sourceFlag(args: ParsedArgs): ReturnType<typeof parseListenSource> {
  return parseListenSource(stringFlag(args, "source"));
}

function printHelp(): void {
  console.log(`listen-importer

Usage:
  listen-importer init
  listen-importer auth [--profile name] [--host url]
  listen-importer permissions [--to did] [--expiry 30d]
  listen-importer scan <path> [--recorder mic-mini|generic] [--dry-run]
  listen-importer cleanup-recorder <path> [--recorder mic-mini|generic] [--delete] [--confirm volume-name] [--include-untranscribed] [--include-untracked] [--confirm-risky delete-unverified] [--json] [--verbose]
  listen-importer scan-source voice-memos|voxterm|soundcore-sync [--since yesterday|YYYY-MM-DD] [--path path] [--include-deleted] [--dry-run]
  listen-importer status [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--json]
  listen-importer list [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all]
  listen-importer preprocess [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--format mp3|m4a|wav] [--bitrate 64k] [--sample-rate 16000] [--force]
  listen-importer downsample [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--format mp3|m4a|wav] [--bitrate 64k] [--sample-rate 16000] [--force]
  listen-importer transcribe [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--provider deepgram|assemblyai] [--api-key key] [--force]
  listen-importer upload [--limit n] [--publish] [--use-downsampled] [--transcripts-only] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--profile name] [--host url]
  listen-importer doctor
`);
}

function printCleanupRecorderResult(
  result: CleanupRecorderResult,
  verbose: boolean,
): void {
  const confirm = expectedRecorderConfirmation(result.rootPath);
  console.log(
    `Recorder cleanup scan: ${result.scanned} file(s) under ${result.rootPath} (${result.recorder})`,
  );
  console.log(`Eligible: ${result.eligible}`);
  console.log(`Deleted: ${result.deleted}`);
  console.log(
    `Blocked: ${result.blockedUntranscribed} untranscribed, ${result.blockedUntracked} untracked`,
  );
  console.log(`Failed: ${result.failed}`);
  if (result.dryRun) {
    console.log(
      `Dry run. To delete eligible transcribed files, rerun with --delete --confirm ${JSON.stringify(confirm)}.`,
    );
    console.log(
      `To also delete untranscribed or untracked files, add --include-untranscribed or --include-untracked plus --confirm-risky ${riskyCleanupConfirmation()}.`,
    );
  }

  if (!verbose) return;
  for (const entry of result.entries) {
    const action = entry.deleted
      ? "deleted"
      : entry.eligible
        ? result.dryRun
          ? "would-delete"
          : "kept"
        : "blocked";
    const error = entry.error ? ` (${entry.error})` : "";
    console.log(
      `${action.padEnd(12)} ${entry.reason.padEnd(13)} ${entry.fileName}${error}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
