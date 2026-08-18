import { secureUrl } from "./config.js";
import { nodeError } from "./errors.js";
import { NODE_TOOL_IDS, RunnerToolId, ToolPolicy } from "./types.js";

export type NodeControlJob = { id: string; tool: RunnerToolId; input: unknown; root: string; policy?: ToolPolicy };
export type RuntimeSession = { dashboardUrl: string; runnerUrl: string; session: string; expiresAt: number };

export function decodeBootstrap(value: unknown): RuntimeSession {
  const body = record(value, "bootstrap response");
  const session = string(body.session, "bootstrap session", 4_096);
  const expiresAt = Date.parse(string(body.expiresAt, "bootstrap expiry", 128));
  if (!Number.isFinite(expiresAt)) throw nodeError("invalid_request", "bootstrap expiry is invalid");
  return {
    dashboardUrl: secureUrl(string(body.dashboardUrl, "Dashboard URL", 2_048)),
    runnerUrl: secureUrl(string(body.runnerUrl, "Runner URL", 2_048)),
    session,
    expiresAt,
  };
}

export function decodeJob(value: unknown): NodeControlJob | undefined {
  const envelope = record(value, "job response");
  if (envelope.job === null || envelope.job === undefined) return undefined;
  const job = record(envelope.job, "job");
  return {
    id: string(job.id, "job id", 128),
    tool: toolId(job.tool),
    input: job.input,
    root: string(job.root, "job root", 4_096),
    ...(job.policy === undefined ? {} : { policy: decodePolicy(job.policy) }),
  };
}

export function retryDelay(attempt: number, random = Math.random()): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
  return Math.round(base * (0.8 + random * 0.4));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw nodeError("invalid_request", `${label} is invalid`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw nodeError("invalid_request", `${label} is invalid`);
  return value;
}

const KNOWN_POLICY_KEYS = new Set([
  "allowWrites",
  "allowCommands",
  "allowedCommands",
  "deniedCommands",
  "timeoutSeconds",
  "commandTimeoutMs",
  "outputMaxBytes",
  "maxOutputBytes",
  "allowPublish",
]);

function decodePolicy(value: unknown): ToolPolicy {
  const body = record(value, "job policy");
  const unknownKey = Object.keys(body).find((key) => !KNOWN_POLICY_KEYS.has(key));
  if (unknownKey) throw nodeError("invalid_request", `job policy has an unsupported field: ${unknownKey}`);
  return {
    ...optionalBoolean(body, "allowWrites"),
    ...optionalBoolean(body, "allowPublish"),
    ...optionalStrings(body, "allowCommands"),
    ...optionalStrings(body, "allowedCommands"),
    ...optionalStrings(body, "deniedCommands"),
    ...optionalInteger(body, "timeoutSeconds"),
    ...optionalInteger(body, "commandTimeoutMs"),
    ...optionalInteger(body, "outputMaxBytes"),
    ...optionalInteger(body, "maxOutputBytes"),
  };
}

function optionalBoolean(value: Record<string, unknown>, key: "allowWrites" | "allowPublish"): Partial<ToolPolicy> {
  if (value[key] === undefined) return {};
  if (typeof value[key] !== "boolean") throw nodeError("invalid_request", `job policy ${key} is invalid`);
  return { [key]: value[key] };
}

function optionalStrings(value: Record<string, unknown>, key: "allowCommands" | "allowedCommands" | "deniedCommands"): Partial<ToolPolicy> {
  const entry = value[key];
  if (entry === undefined) return {};
  if (!Array.isArray(entry) || entry.length > 100 || entry.some((item) => typeof item !== "string" || !item || item.length > 256)) {
    throw nodeError("invalid_request", `job policy ${key} is invalid`);
  }
  return { [key]: entry };
}

function optionalInteger(value: Record<string, unknown>, key: "timeoutSeconds" | "commandTimeoutMs" | "outputMaxBytes" | "maxOutputBytes"): Partial<ToolPolicy> {
  const entry = value[key];
  if (entry === undefined) return {};
  if (!Number.isSafeInteger(entry) || (entry as number) <= 0) throw nodeError("invalid_request", `job policy ${key} is invalid`);
  return { [key]: entry as number };
}

function toolId(value: unknown): RunnerToolId {
  if (typeof value !== "string" || !TOOL_IDS.has(value as RunnerToolId)) throw nodeError("invalid_request", "job tool is invalid");
  return value as RunnerToolId;
}

const TOOL_IDS = new Set<RunnerToolId>(NODE_TOOL_IDS);
