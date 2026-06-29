#!/usr/bin/env node
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
import {
  formatStateMigrationResult,
  migrateListenState,
} from "./state-migration";
import {
  authStatus,
  createDelegation,
  getSecret,
  requestCapabilities,
  secretsDoctorStatus,
  secretsNetworkStatus,
  type SecretsDoctorStatus,
  type SecretsNetworkStatus,
  type TcOptions,
} from "./tc";
import { transcribePending, type TranscriptionProvider } from "./transcription";
import { uploadPending } from "./upload";

const COMMAND = "listen";

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
      const capabilities = listenCapabilities(config);
      const secretScope =
        stringFlag(args, "secret-scope") ?? config.listenSecretScope;
      const includeSecrets = !Boolean(args.flags["no-secrets"]);
      const secretCommand = secretPutCommand(secretScope);
      const networkStatus = includeSecrets
        ? readSecretsNetworkStatus(tcOptions(args))
        : null;
      if (args.flags.grant) {
        console.log(
          requestCapabilities(capabilities, {
            ...tcOptions(args),
            expiry,
            grant: true,
            yes: Boolean(args.flags.yes),
          }),
        );
        if (includeSecrets) {
          const doctorStatus = readSecretsDoctorStatus(
            secretScope,
            tcOptions(args),
          );
          if (doctorStatus?.secret?.readable) {
            console.log(
              `Granted access to ASSEMBLYAI_API_KEY in ${secretScopeLabel(secretScope)}`,
            );
          } else if (doctorStatus) {
            console.log(
              `ASSEMBLYAI_API_KEY is not ready: ${doctorMessage(doctorStatus)}`,
            );
            printSecretSetup(secretScope, doctorStatus.network);
          } else {
            console.log(
              `Could not verify ASSEMBLYAI_API_KEY. Store it with: ${secretCommand}`,
            );
            printSecretSetup(secretScope, networkStatus);
          }
        }
        break;
      }
      if (!to) {
        console.log("Required TinyCloud capabilities:");
        for (const capability of capabilities) console.log(`- ${capability}`);
        if (includeSecrets) {
          console.log(
            `- ASSEMBLYAI_API_KEY from ${secretScopeLabel(secretScope)}`,
          );
          console.log("");
          printSecretSetup(secretScope, networkStatus);
        }
        console.log("");
        console.log("Grant them to the active TinyCloud profile with:");
        console.log("listen permissions --grant");
        console.log("");
        console.log("Pass --to <did> to create the legacy KV delegation only.");
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

    case "downsample": {
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
      console.log(`Downsampled ${result.downsampled}; failed ${result.failed}`);
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
        secretScope: stringFlag(args, "secret-scope"),
        tcOptions: tcOptions(args),
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

    case "migrate-state": {
      const result = await migrateListenState({
        from: stringFlag(args, "from"),
        to: stringFlag(args, "to"),
        dryRun: Boolean(args.flags["dry-run"]),
      });
      console.log(formatStateMigrationResult(result));
      if (result.reason === "target_exists") process.exitCode = 1;
      break;
    }

    case "doctor": {
      const secretScope =
        stringFlag(args, "secret-scope") ?? config.listenSecretScope;
      await openStore(config).then((store) => store.close());
      console.log("Local");
      console.log(`  State: ${config.homeDir}`);
      console.log(`  Database: ${config.dbPath}`);
      console.log(`  Media: ${config.mediaDir}`);
      console.log(`  Downsampled: ${config.downsampledDir}`);
      console.log(`  Transcripts: ${config.transcriptsDir}`);
      console.log("");
      console.log("Listen");
      console.log(`  SQL DB: ${config.listenSqlDb}`);
      console.log(`  KV prefix: ${config.listenKvPrefix}`);
      console.log(`  App space: ${config.listenAppSpace}`);
      console.log(`  Secret scope: ${secretScope || "global"}`);
      console.log("");
      console.log("TinyCloud");
      try {
        const status = authStatus(tcOptions(args));
        printDoctorCheck("TinyCloud auth", "ok", summarizeAuthStatus(status));
      } catch (err) {
        printDoctorCheck("TinyCloud auth", "warn", messageFromError(err));
      }
      const assemblyEnv = Boolean(
        process.env.ASSEMBLYAI_API_KEY || process.env.ASSEMBLY_API_KEY,
      );
      const deepgramEnv = Boolean(process.env.DEEPGRAM_API_KEY);
      if (assemblyEnv) {
        printDoctorCheck("AssemblyAI env key", "ok", "ASSEMBLYAI_API_KEY set");
      } else {
        printDoctorCheck("AssemblyAI env key", "warn", "not set");
      }
      if (deepgramEnv) {
        printDoctorCheck("Deepgram env key", "ok", "DEEPGRAM_API_KEY set");
      }

      console.log("");
      console.log("Secrets");
      const doctorStatus = readSecretsDoctorStatus(
        secretScope,
        tcOptions(args),
      );
      const networkStatus =
        doctorStatus?.network ?? readSecretsNetworkStatus(tcOptions(args));
      if (networkStatus?.exists) {
        printDoctorCheck(
          "Encryption network",
          "ok",
          formatSecretsNetwork(networkStatus),
        );
      } else {
        printDoctorCheck(
          "Encryption network",
          "warn",
          networkStatus
            ? "default network missing"
            : "could not read default network",
        );
      }

      if (doctorStatus) {
        if (doctorStatus.secret?.readable) {
          printDoctorCheck(
            "AssemblyAI TinyCloud secret",
            "ok",
            `ASSEMBLYAI_API_KEY in ${secretScopeLabel(secretScope)}`,
          );
        } else {
          printDoctorCheck(
            "AssemblyAI TinyCloud secret",
            "warn",
            doctorStatus.secret?.exists === false
              ? `missing in ${secretScopeLabel(secretScope)}`
              : doctorMessage(doctorStatus),
          );
          printSecretSetup(secretScope, networkStatus);
        }
      } else {
        try {
          const secret = getSecret("ASSEMBLYAI_API_KEY", {
            ...tcOptions(args),
            scope: secretScope,
          });
          if (secret) {
            printDoctorCheck(
              "AssemblyAI TinyCloud secret",
              "ok",
              `ASSEMBLYAI_API_KEY in ${secretScopeLabel(secretScope)}`,
            );
          } else {
            printDoctorCheck(
              "AssemblyAI TinyCloud secret",
              "warn",
              `missing in ${secretScopeLabel(secretScope)}`,
            );
            printSecretSetup(secretScope, networkStatus);
          }
        } catch (err) {
          printDoctorCheck(
            "AssemblyAI TinyCloud secret",
            "warn",
            messageFromError(err),
          );
          printSecretSetup(secretScope, networkStatus);
        }
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
  const [rawCommand = "help", ...rest] = argv;
  const command =
    rawCommand === "--help" || rawCommand === "-h" ? "help" : rawCommand;
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

function listenCapabilities(config: ReturnType<typeof getConfig>): string[] {
  return [
    `tinycloud.kv:${config.listenAppSpace}:${config.listenKvPrefix}/:get,put,list`,
    `tinycloud.sql:${config.listenAppSpace}:${config.listenSqlDb}:read,write,schema`,
  ];
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

function printDoctorCheck(
  label: string,
  status: "ok" | "warn",
  detail: string,
): void {
  console.log(`${status.toUpperCase()} ${label}: ${detail}`);
}

function printSecretSetup(
  scope: string,
  networkStatus: SecretsNetworkStatus | null,
): void {
  console.log("Secret setup:");
  console.log(`- Open ${secretsAppUrl("ASSEMBLYAI_API_KEY")} to enter the value`);
  if (!networkStatus?.exists) console.log("- tc secrets network init");
  console.log(`- Or via CLI: ${secretPutCommand(scope)}`);
  console.log(`- ${permissionsGrantCommand(scope)}`);
}

const SECRETS_APP_URL = "https://secrets.tinycloud.xyz/app";

function secretsAppUrl(key: string): string {
  return `${SECRETS_APP_URL}?key=${encodeURIComponent(key)}`;
}

function readSecretsNetworkStatus(
  options: TcOptions,
): SecretsNetworkStatus | null {
  try {
    return secretsNetworkStatus(options);
  } catch {
    return null;
  }
}

function readSecretsDoctorStatus(
  scope: string,
  options: TcOptions,
): SecretsDoctorStatus | null {
  try {
    return secretsDoctorStatus("ASSEMBLYAI_API_KEY", {
      ...options,
      scope,
    });
  } catch {
    return null;
  }
}

function doctorMessage(status: SecretsDoctorStatus): string {
  return (
    status.checks.find((check) => check.name === "Secret access")?.detail ??
    "not readable"
  );
}

function secretScopeLabel(scope: string): string {
  return scope ? `tc secrets scope ${scope}` : "global tc secrets";
}

function secretPutCommand(scope: string): string {
  return [
    "tc",
    "secrets",
    "put",
    "ASSEMBLYAI_API_KEY",
    '"$ASSEMBLYAI_API_KEY"',
    ...(scope ? ["--scope", scope] : []),
  ].join(" ");
}

function permissionsGrantCommand(scope: string): string {
  return [
    "listen",
    "permissions",
    "--grant",
    ...(scope ? ["--secret-scope", scope] : []),
  ].join(" ");
}

function formatSecretsNetwork(status: SecretsNetworkStatus): string {
  const parts = [
    status.name ? `name ${status.name}` : null,
    status.state ? `state ${status.state}` : null,
    status.networkId ? shortId(status.networkId) : null,
  ].filter(Boolean);
  return parts.join(", ") || "exists";
}

function shortId(value: string): string {
  return value.length > 36
    ? `${value.slice(0, 28)}...${value.slice(-8)}`
    : value;
}

function firstLine(value: string): string {
  return (
    value
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

function summarizeAuthStatus(value: string): string {
  try {
    const parsed = JSON.parse(value) as {
      profile?: string;
      authenticated?: boolean;
      host?: string;
    };
    const parts = [
      parsed.profile ? `profile ${parsed.profile}` : null,
      typeof parsed.authenticated === "boolean"
        ? `authenticated ${parsed.authenticated ? "yes" : "no"}`
        : null,
      parsed.host ?? null,
    ].filter(Boolean);
    return parts.join(", ") || "ok";
  } catch {
    return firstLine(value);
  }
}

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function printHelp(): void {
  console.log(`${COMMAND}

Usage:
  listen init
  listen auth [--profile name] [--host url]
  listen permissions [--grant] [--expiry 30d] [--secret-scope name]
  listen scan <path> [--recorder mic-mini|generic] [--dry-run]
  listen cleanup-recorder <path> [--recorder mic-mini|generic] [--delete] [--confirm volume-name] [--include-untranscribed] [--include-untracked] [--confirm-risky delete-unverified] [--json] [--verbose]
  listen scan-source voice-memos|voxterm|soundcore-sync [--since yesterday|YYYY-MM-DD] [--path path] [--include-deleted] [--dry-run]
  listen status [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--json]
  listen list [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all]
  listen downsample [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--format mp3|m4a|wav] [--bitrate 64k] [--sample-rate 16000] [--force]
  listen transcribe [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--provider assemblyai|deepgram] [--api-key key] [--secret-scope name] [--force]
  listen upload [--limit n] [--publish] [--use-downsampled] [--transcripts-only] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--profile name] [--host url]
  listen migrate-state [--from path] [--to path] [--dry-run]
  listen doctor [--secret-scope name]

Examples:
  listen scan /Volumes/MIC\\ MINI
  listen downsample --source recorder
  listen transcribe --provider assemblyai --source recorder
  listen upload --publish --use-downsampled --source recorder
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
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`Run '${COMMAND} help' for usage.`);
  process.exit(1);
});
