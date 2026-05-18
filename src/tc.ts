import { spawnSync } from "node:child_process";

export interface TcOptions {
  profile?: string;
  host?: string;
}

export interface TcRunResult {
  stdout: string;
  stderr: string;
}

export function runTc(args: string[], options: TcOptions = {}): TcRunResult {
  const fullArgs = [
    ...(options.profile ? ["--profile", options.profile] : []),
    ...(options.host ? ["--host", options.host] : []),
    ...args,
  ];
  const result = spawnSync("tc", fullArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `tc exited ${result.status}`;
    throw new Error(`tc ${fullArgs.join(" ")} failed: ${detail}`);
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
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
