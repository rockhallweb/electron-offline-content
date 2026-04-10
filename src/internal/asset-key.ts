import { createHash } from "node:crypto";

/** Accepted asset key input: a plain string or an array of string segments. */
export type AssetKeyInput = string | readonly string[];

/**
 * Hash an asset key input to a fixed 16-char hex string for storage identity.
 * String inputs are treated as a single segment. Array inputs are joined with
 * null-byte separators to prevent ambiguity between segment boundaries.
 */
export function hashKey(input: AssetKeyInput): string {
  const normalized = typeof input === "string" ? input : input.join("\0");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Produce a human-readable display key for debugging and UI. */
export function displayKey(input: AssetKeyInput): string {
  return typeof input === "string" ? input : input.join("/");
}

/**
 * Validate that an asset key input is non-empty.
 * Returns `true` if the input is a non-empty string or a non-empty array of non-empty strings.
 */
export function isValidKeyInput(input: AssetKeyInput): boolean {
  if (typeof input === "string") return input.length > 0;
  return input.length > 0 && input.every((s) => s.length > 0);
}
