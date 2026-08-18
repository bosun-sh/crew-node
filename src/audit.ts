import { closeSync, constants, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Config } from "./config.js";
import { truncateText } from "./policy.js";
import { CommandResult } from "./types.js";
import { redactSecrets } from "./redact.js";

export interface AuditRecord {
  requestId: string | null;
  tool: string | null;
  root: string | null;
  startedAt: string;
  endedAt: string;
  status: "success" | "failure";
  failureReason?: string;
  exitCode?: number | null;
  stdout?: AuditTextMetadata;
  stderr?: AuditTextMetadata;
  touchedPaths?: string[];
  mutatingDiff?: AuditDiffMetadata;
}

export interface AuditTextMetadata {
  bytes: number;
  truncated: boolean;
}

export interface AuditDiffMetadata {
  bytes: number;
  truncated: boolean;
  preview: string;
  paths?: string[];
}

const AUDIT_DIFF_PREVIEW_BYTES = 8_192;
const AUDIT_MAX_PATHS = 20;

export function buildAuditRecord(
  config: Config,
  base: Pick<AuditRecord, "requestId" | "tool" | "root" | "startedAt" | "endedAt" | "status" | "failureReason">,
  result?: unknown,
): AuditRecord {
  const record: AuditRecord = { ...base };

  if (isCommandResult(result)) {
    record.exitCode = result.exitCode;
    record.stdout = textMetadata(result.stdout, result.stdoutTruncated);
    record.stderr = textMetadata(result.stderr, result.stderrTruncated);
  } else if (hasNumericExitCode(result)) {
    record.exitCode = result.exitCode;
  }

  const touchedPaths = collectTouchedPaths(result);
  if (touchedPaths.length > 0) {
    record.touchedPaths = touchedPaths.slice(0, AUDIT_MAX_PATHS);
  }

  const diff = collectDiffPreview(config, result);
  if (diff) {
    record.mutatingDiff = diff;
  }

  return record;
}

const AUDIT_LOG_NAME = "crew-node-audit.jsonl";
const AUDIT_ROTATED_PREFIX = "crew-node-audit-";

export function writeAudit(config: Config, record: AuditRecord): void {
  const path = join(config.auditDir, AUDIT_LOG_NAME);
  rotateAuditLogIfNeeded(config, path);
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const redacted = JSON.stringify(record, (_key, value) => (typeof value === "string" ? redactSecrets(value) : value));
    writeSync(descriptor, `${redacted}\n`, undefined, "utf8");
  } finally {
    closeSync(descriptor);
  }
  pruneRotatedAuditLogs(config);
}

/** Rolls the live log to a timestamped file once it reaches auditMaxBytes, so append-only
 * writes cannot grow crew-node-audit.jsonl without bound. Rotated files are plain JSONL and
 * are the export path: copy them off (`docker cp`) or read them from the mounted data volume. */
function rotateAuditLogIfNeeded(config: Config, path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < config.auditMaxBytes) return;
  const rotatedPath = join(config.auditDir, `${AUDIT_ROTATED_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  renameSync(path, rotatedPath);
}

/** Deletes rotated audit files older than auditRetentionDays. The live log is never pruned by
 * age; only files rotateAuditLogIfNeeded has already rolled over are retention candidates. */
function pruneRotatedAuditLogs(config: Config): void {
  const cutoffMs = Date.now() - config.auditRetentionDays * 24 * 60 * 60 * 1_000;
  let entries: string[];
  try {
    entries = readdirSync(config.auditDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(AUDIT_ROTATED_PREFIX) || !entry.endsWith(".jsonl")) continue;
    const entryPath = join(config.auditDir, entry);
    try {
      if (statSync(entryPath).mtimeMs < cutoffMs) rmSync(entryPath, { force: true });
    } catch {
      // Best-effort cleanup; one bad stat/rm must not block audit writes.
    }
  }
}

function textMetadata(text: string, truncated: boolean): AuditTextMetadata {
  return {
    bytes: new TextEncoder().encode(text).byteLength,
    truncated,
  };
}

function collectTouchedPaths(result: unknown): string[] {
  if (typeof result !== "object" || result === null) {
    return [];
  }

  const value = result as Record<string, unknown>;
  const paths = new Set<string>();
  for (const key of ["path", "sourcePath", "targetPath", "diffPath"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      paths.add(value[key]);
    }
  }
  for (const key of ["paths", "changedFiles", "touchedPaths"]) {
    const entries = value[key];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (typeof entry === "string" && entry.trim()) {
          paths.add(entry);
        }
      }
    }
  }

  return Array.from(paths);
}

function collectDiffPreview(config: Config, result: unknown): AuditDiffMetadata | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }

  const value = result as Record<string, unknown>;
  if (typeof value.diff !== "string" || value.diff.length === 0) {
    return null;
  }

  const encoded = new TextEncoder().encode(value.diff);
  const preview = truncateText(value.diff, Math.min(AUDIT_DIFF_PREVIEW_BYTES, config.outputMaxBytes));
  return {
    bytes: encoded.byteLength,
    truncated: preview.truncated,
    preview: preview.text,
    paths: collectTouchedPaths(result).slice(0, AUDIT_MAX_PATHS),
  };
}

function isCommandResult(result: unknown): result is CommandResult {
  if (typeof result !== "object" || result === null) {
    return false;
  }

  const value = result as Record<string, unknown>;
  return (
    Array.isArray(value.argv) &&
    typeof value.cwd === "string" &&
    typeof value.exitCode === "number" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    typeof value.allowed === "boolean" &&
    typeof value.durationMs === "number" &&
    typeof value.stdoutTruncated === "boolean" &&
    typeof value.stderrTruncated === "boolean" &&
    typeof value.timedOut === "boolean" &&
    typeof value.startedAt === "string" &&
    typeof value.finishedAt === "string"
  );
}

function hasNumericExitCode(result: unknown): result is { exitCode: number } {
  return typeof result === "object" && result !== null && typeof (result as Record<string, unknown>).exitCode === "number";
}
