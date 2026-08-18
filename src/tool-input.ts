import { nodeError } from "./errors.js";
import type { EffectivePolicy } from "./policy.js";

export function objectInput(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw nodeError("invalid_request", "input must be an object");
  }
  return input as Record<string, unknown>;
}

export function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw nodeError("invalid_request", "value must be a positive integer");
  }
  return value as number;
}

export function boundedOutput(value: unknown, ceiling: number): number {
  return Math.min(positiveInteger(value, ceiling), ceiling);
}

export function assertWritesAllowed(policy: EffectivePolicy): void {
  if (!policy.allowWrites) throw nodeError("policy_denied", "Writes are not allowed by policy", 403);
}

const SHA_PATTERN = /^[a-f0-9]{7,64}$/;

export function isSafeBranch(value: string): boolean {
  return value === "" || (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value)
    && !value.includes("..")
    && !value.includes("@{")
    && !value.includes("//")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.endsWith(".lock")
  );
}

// Validates a caller-supplied Git ref (branch name or commit SHA) at the function boundary that
// embeds it into a git argv, so both the policy-checked tool paths and the internal gitRaw paths
// share one guard instead of trusting a bare `typeof === "string"` check.
export function safeRef(value: string, field: string): string {
  if (!isSafeBranch(value) && !SHA_PATTERN.test(value)) {
    throw nodeError("invalid_request", `${field} must be a safe branch name or commit SHA`, 400);
  }
  return value;
}
