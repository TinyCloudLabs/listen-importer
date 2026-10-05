export const STORAGE_FULL_MESSAGE =
  "Your TinyCloud storage is full, so this change was not saved. Reading still works. Free up space or upgrade your plan to save again.";
export const MANAGE_STORAGE_URL = "https://account.tinycloud.xyz/billing";

/** Dedicated `tc` exit code for a storage rejection (newer tc releases). */
export const TC_STORAGE_FULL_EXIT_CODE = 8;

const STORAGE_FULL_CODES: Record<string, true> = {
  STORAGE_QUOTA_EXCEEDED: true,
  STORAGE_LIMIT_REACHED: true,
  STORAGE_FULL: true,
};
// Older tc/SDK releases only carry the node's wording.
const STORAGE_FULL_TEXT =
  /storage quota exceeded|write exceeds remaining storage|storage is full|storage you have left/i;

/**
 * True when a TinyCloud write was refused because the owner's storage is full.
 * Checks the error code, the tc exit code, then the message text, following
 * `cause`/`error` wrappers.
 */
export function isStorageFullError(err: unknown, depth = 0): boolean {
  if (err == null || depth > 4) return false;
  if (typeof err === "string") return STORAGE_FULL_TEXT.test(err);
  if (typeof err !== "object") return false;

  const value = err as {
    code?: unknown;
    exitCode?: unknown;
    message?: unknown;
    cause?: unknown;
    error?: unknown;
  };
  if (
    typeof value.code === "string" &&
    STORAGE_FULL_CODES[value.code.toUpperCase()] === true
  ) {
    return true;
  }
  if (value.exitCode === TC_STORAGE_FULL_EXIT_CODE) return true;
  if (
    typeof value.message === "string" &&
    STORAGE_FULL_TEXT.test(value.message)
  )
    return true;
  return (
    isStorageFullError(value.cause, depth + 1) ||
    isStorageFullError(value.error, depth + 1)
  );
}
