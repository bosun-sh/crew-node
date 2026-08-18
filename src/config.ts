import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isNodeError, nodeError } from "./errors.js";

export interface Config {
  apiKey: string;
  dashboardUrl: string;
  workspaceRoot: string;
  port: number;
  commandTimeoutSeconds: number;
  outputMaxBytes: number;
  allowedCommands: Set<string>;
  allowWrites: boolean;
  auditDir: string;
  stateDir: string;
  auditMaxBytes: number;
  auditRetentionDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = requireEnv(env, "CREW_NODE_API_KEY");
  const dashboardUrl = dashboardUrlFromApiKey(apiKey);
  const workspaceRoot = realpathSync(resolve(env.CREW_WORKSPACE_ROOT?.trim() || defaultWorkspaceRoot()));
  const port = parsePositiveInt(env.CREW_PORT, 4321, "CREW_PORT", 65_535);
  const commandTimeoutSeconds = parsePositiveInt(
    env.CREW_COMMAND_TIMEOUT_SECONDS,
    30,
    "CREW_COMMAND_TIMEOUT_SECONDS",
    3_600,
  );
  const outputMaxBytes = parsePositiveInt(env.CREW_OUTPUT_MAX_BYTES, 65_536, "CREW_OUTPUT_MAX_BYTES", 16_000_000);
  // Outside the workspace so a write-repo-file/run-command tool call can never reach the audit
  // trail (previously defaulted under workspaceRoot, which meant an in-scope "sensitive path"
  // exclusion would have been needed instead of just keeping the audit trail off that tree).
  const auditDir = env.CREW_AUDIT_DIR ? resolve(env.CREW_AUDIT_DIR) : resolve(homedir(), ".crew-node", "audit");
  const stateDir = env.CREW_STATE_DIR?.trim()
    ? resolve(env.CREW_STATE_DIR)
    : resolve(auditDir, "state");
  ensurePrivateDirectory(auditDir);
  ensurePrivateDirectory(stateDir);
  const auditMaxBytes = parsePositiveInt(env.CREW_AUDIT_MAX_BYTES, 50_000_000, "CREW_AUDIT_MAX_BYTES", 5_000_000_000);
  const auditRetentionDays = parsePositiveInt(env.CREW_AUDIT_RETENTION_DAYS, 30, "CREW_AUDIT_RETENTION_DAYS", 3_650);

  return {
    apiKey,
    dashboardUrl,
    workspaceRoot,
    port,
    commandTimeoutSeconds,
    outputMaxBytes,
    allowedCommands: parseCommandSet(env.CREW_ALLOWED_COMMANDS ?? "git,npm,node,sed,cat,ls,find,patch"),
    allowWrites: parseBoolean(env.CREW_ALLOW_WRITES, true, "CREW_ALLOW_WRITES"),
    auditDir,
    stateDir,
    auditMaxBytes,
    auditRetentionDays,
  };
}

function defaultWorkspaceRoot(): string {
  return existsSync("/workspace") ? "/workspace" : process.cwd();
}

export function dashboardUrlFromApiKey(apiKey: string): string {
  const [prefix, encoded, material, extra] = apiKey.split(".");
  if (prefix !== "crew_node_key_v2") throw nodeError("invalid_request", "CREW_NODE_API_KEY must be a v2 install key", 1);
  if (!encoded || !material || extra || Buffer.from(material, "base64url").byteLength < 32) {
    throw nodeError("invalid_request", "CREW_NODE_API_KEY is malformed", 1);
  }
  try {
    return secureUrl(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error) {
    if (isNodeError(error)) throw error;
    throw nodeError("invalid_request", "CREW_NODE_API_KEY contains an invalid Dashboard URL", 1);
  }
}

export function secureUrl(value: string): string {
  if (value.length > 2_048) throw nodeError("invalid_request", "Crew Node control-plane URL is too long", 1);
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw nodeError("invalid_request", "Crew Node control-plane URLs require HTTPS except on loopback", 1);
  }
  if (url.username || url.password) {
    throw nodeError("invalid_request", "Crew Node control-plane URLs must not contain credentials", 1);
  }
  return url.toString().replace(/\/+$/, "");
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw nodeError("invalid_request", `${key} is required`, 1);
  }
  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number, key: string, maximum: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw nodeError("invalid_request", `${key} must be an integer between 1 and ${maximum}`, 1);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean, key: string): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw nodeError("invalid_request", `${key} must be "true" or "false"`, 1);
}

function parseCommandSet(value: string | undefined): Set<string> {
  const commands = new Set(
    (value ?? "")
      .split(",")
      .map((command) => command.trim())
      .filter(Boolean),
  );
  if (commands.size > 100 || [...commands].some((command) => !/^[A-Za-z0-9._+-]+$/.test(command))) {
    throw nodeError("invalid_request", "CREW_ALLOWED_COMMANDS must contain at most 100 binary names", 1);
  }
  return commands;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
