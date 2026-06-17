import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TcOptions {
  profile?: string;
  host?: string;
  space?: string;
}

export interface TcSecretOptions extends TcOptions {
  scope?: string;
}

export interface TcRunResult {
  stdout: string;
  stderr: string;
}

export interface SecretsNetworkStatus {
  networkId: string | null;
  exists: boolean;
  state: string | null;
  name: string | null;
}

export function runTc(args: string[], options: TcOptions = {}): TcRunResult {
  const tc = tcExecutable();
  const fullArgs = [
    ...(options.profile ? ["--profile", options.profile] : []),
    ...(options.host ? ["--host", options.host] : []),
    ...args,
    ...(options.space ? ["--space", options.space] : []),
  ];
  const result = spawnSync(tc, fullArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `tc exited ${result.status}`;
    throw new Error(`${tc} ${fullArgs.join(" ")} failed: ${detail}`);
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function tcExecutable(): string {
  if (process.env.LISTEN_TC_PATH) {
    return process.env.LISTEN_TC_PATH;
  }

  const localBinName = process.platform === "win32" ? "tc.cmd" : "tc";
  const candidates = [
    join(process.cwd(), "node_modules", ".bin", localBinName),
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "node_modules",
      ".bin",
      localBinName,
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "tc";
}

export function authStatus(options: TcOptions = {}): string {
  return runTc(["auth", "status"], options).stdout.trim();
}

export function putKvFile(
  key: string,
  filePath: string,
  options: TcOptions = {},
): void {
  runTc(["kv", "put", key, "--file", filePath], options);
}

export function putKvString(
  key: string,
  value: string,
  options: TcOptions = {},
): void {
  runTc(["kv", "put", key, value], options);
}

export function sqlExecute(
  db: string,
  sql: string,
  params: unknown[] = [],
  options: TcOptions = {},
): void {
  runTc(
    ["sql", "execute", sql, "--db", db, "--params", JSON.stringify(params)],
    options,
  );
}

export function createDelegation(
  to: string,
  path: string,
  actions: string[],
  expiry: string,
  options: TcOptions = {},
): string {
  return runTc(
    [
      "delegation",
      "create",
      "--to",
      to,
      "--path",
      path,
      "--actions",
      actions.join(","),
      "--expiry",
      expiry,
    ],
    options,
  ).stdout.trim();
}

export function getSecret(
  name: string,
  options: TcSecretOptions = {},
): string | undefined {
  try {
    const result = runTc(
      [
        "secrets",
        "get",
        name,
        "--raw",
        ...(options.scope ? ["--scope", options.scope] : []),
      ],
      options,
    );
    return result.stdout.trim();
  } catch (err) {
    if (isTcNotFoundError(err)) return undefined;
    throw err;
  }
}

export function ensureSecretsNetwork(options: TcSecretOptions = {}): string {
  return runTc(["secrets", "network", "init"], options).stdout.trim();
}

export function secretsNetworkStatus(
  options: TcSecretOptions = {},
): SecretsNetworkStatus {
  const result = runTc(["secrets", "network", "show"], options);
  const parsed = JSON.parse(result.stdout) as {
    networkId?: string;
    exists?: boolean;
    descriptor?: { state?: string; name?: string };
  };
  return {
    networkId: parsed.networkId ?? null,
    exists: parsed.exists === true,
    state: parsed.descriptor?.state ?? null,
    name: parsed.descriptor?.name ?? null,
  };
}

export function requestCapabilities(
  capabilities: string[],
  options: TcOptions & {
    expiry?: string;
    grant?: boolean;
    yes?: boolean;
  } = {},
): string {
  return runTc(
    [
      "auth",
      "request",
      ...capabilities.flatMap((capability) => ["--cap", capability]),
      ...(options.expiry ? ["--expiry", options.expiry] : []),
      ...(options.grant ? ["--grant"] : []),
      ...(options.yes ? ["--yes"] : []),
    ],
    options,
  ).stdout.trim();
}

function isTcNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('"code": "NOT_FOUND"') ||
    message.includes('"code": "KEY_NOT_FOUND"') ||
    (message.includes("Secret ") && message.includes(" not found"))
  );
}
