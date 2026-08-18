import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type StoredJobResult = { result?: unknown; error?: string };
const MAX_STORED_RESULT_BYTES = 2_000_000;

export function readJobResult(stateDir: string, jobId: string): StoredJobResult | undefined {
  const path = jobPath(stateDir, jobId);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (fstatSync(descriptor).size > MAX_STORED_RESULT_BYTES) throw new Error("stored job result exceeds size limit");
    return decodeStoredResult(JSON.parse(readFileSync(descriptor, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // A corrupt or unreadable durable result must not permanently block this job's slot; move it
    // aside so a fresh write can take its place instead of retrying the same failure forever.
    try { renameSync(path, `${path}.corrupt`); } catch {}
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeJobResult(stateDir: string, jobId: string, value: StoredJobResult): void {
  const path = jobPath(stateDir, jobId);
  const temporary = `${path}.${process.pid}.tmp`;
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_STORED_RESULT_BYTES) throw new Error("job result exceeds size limit");
  try {
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    syncDirectory(stateDir);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function removeJobResult(stateDir: string, jobId: string): void {
  rmSync(jobPath(stateDir, jobId), { force: true });
  syncDirectory(stateDir);
}

function jobPath(stateDir: string, jobId: string): string {
  return join(stateDir, `${Buffer.from(jobId).toString("base64url")}.json`);
}

function decodeStoredResult(value: unknown): StoredJobResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("stored job result is invalid");
  const result = value as Record<string, unknown>;
  if (typeof result.error === "string" && !("result" in result)) return { error: result.error };
  if ("result" in result && result.error === undefined) return { result: result.result };
  throw new Error("stored job result is invalid");
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
