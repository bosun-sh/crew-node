import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Config } from "./config.js";
import { nodeError } from "./errors.js";
import { checkGitInvocation } from "./git-policy.js";
import { ToolPolicy } from "./types.js";

export interface EffectivePolicy {
  allowedCommands: Set<string>;
  deniedCommands: string[];
  timeoutMs: number;
  outputMaxBytes: number;
  allowWrites: boolean;
  allowPublish: boolean;
}

const RUNTIME_EVAL_FLAGS: Record<string, Set<string>> = {
  node: new Set(["-e", "--eval", "-p", "--print"]),
  bun: new Set(["-e", "--eval", "-p", "--print"]),
  deno: new Set(["eval"]),
};

const FIND_DENIED_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete"]);

export function effectivePolicy(config: Config, requestPolicy: ToolPolicy | undefined): EffectivePolicy {
  const nodeAllowed = config.allowedCommands;
  const requestedAllowed = requestPolicy?.allowedCommands ?? requestPolicy?.allowCommands;
  const allowedCommands =
    requestedAllowed === undefined
      ? new Set(nodeAllowed)
      : assertRequestedCommandsAllowed(nodeAllowed, requestedAllowed);

  const requestedTimeout = requestPolicy?.commandTimeoutMs ?? secondsToMs(requestPolicy?.timeoutSeconds ?? config.commandTimeoutSeconds);
  const requestedOutput = requestPolicy?.maxOutputBytes ?? requestPolicy?.outputMaxBytes ?? config.outputMaxBytes;
  if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout <= 0) {
    throw nodeError("invalid_request", "command timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(requestedOutput) || requestedOutput <= 0) {
    throw nodeError("invalid_request", "output limit must be a positive integer");
  }

  return {
    allowedCommands,
    deniedCommands: requestPolicy?.deniedCommands ?? [],
    timeoutMs: Math.min(requestedTimeout, secondsToMs(config.commandTimeoutSeconds)),
    outputMaxBytes: Math.min(requestedOutput, config.outputMaxBytes),
    allowWrites: (requestPolicy?.allowWrites ?? false) && config.allowWrites,
    allowPublish: requestPolicy?.allowPublish ?? false,
  };
}

// Narrow, separately-gated permission for pushing a Crew run branch to its remote. `push` is
// deliberately absent from GIT_SUBCOMMAND_ALLOWLIST, so run-command/git-diff always deny it;
// only finalizeWorkspace's own publish path checks this before invoking git push directly.
export function checkPublishAllowed(policy: EffectivePolicy): { allowed: boolean; reason?: string } {
  if (!policy.allowWrites) {
    return { allowed: false, reason: "Publishing requires write permission." };
  }
  if (!policy.allowPublish) {
    return { allowed: false, reason: "Publishing requires explicit publish permission." };
  }
  return { allowed: true };
}

export function checkCommandAllowed(policy: EffectivePolicy, argv: string[]): { allowed: boolean; reason?: string } {
  const command = argv[0];
  if (!command) {
    return { allowed: false, reason: "Empty command." };
  }

  if (!policy.allowedCommands.has(command)) {
    return { allowed: false, reason: `Command is not allowlisted: ${command}` };
  }
  if (command.includes("/") || command.includes("\\")) {
    return { allowed: false, reason: "Command paths are not allowed; allowlist a binary name." };
  }

  const subcommand = resolveSubcommand(command, argv);
  const denied = policy.deniedCommands.find((entry) => matchesDeniedEntry(entry, command, subcommand));
  if (denied) {
    return { allowed: false, reason: `Command is denied by policy: ${denied}` };
  }

  if (command === "git") {
    const gitCheck = checkGitInvocation(policy, argv);
    if (!gitCheck.allowed) return gitCheck;
  }

  if (!policy.allowWrites && !READ_ONLY_COMMANDS.has(command)) {
    return { allowed: false, reason: `${command} requires write permission.` };
  }

  const evalFlags = RUNTIME_EVAL_FLAGS[command];
  if (evalFlags) {
    const evalFlag = argv.slice(1).find((arg) => evalFlags.has(arg) || evalFlags.has(arg.split("=")[0] ?? arg));
    if (evalFlag) {
      return { allowed: false, reason: `Inline eval is denied for ${command}: ${evalFlag}` };
    }
  }

  if (command === "find") {
    const deniedFlag = argv.slice(1).find((arg) => FIND_DENIED_FLAGS.has(arg));
    if (deniedFlag) {
      return { allowed: false, reason: `find action is denied by policy: ${deniedFlag}` };
    }
  }

  return { allowed: true };
}

const READ_ONLY_COMMANDS = new Set(["cat", "git", "ls"]);

export function assertCommandAllowed(argv: string[], policy: EffectivePolicy): void {
  const check = checkCommandAllowed(policy, argv);
  if (!check.allowed) {
    throw nodeError("policy_denied", check.reason ?? "Command denied", 403);
  }
}

export function resolveRoot(config: Config, root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") {
    throw nodeError("invalid_request", "root must be a non-empty string");
  }

  const candidate = isAbsolute(root) ? root : resolve(config.workspaceRoot, root);
  return requireInsideWorkspace(config.workspaceRoot, candidate, "root");
}

export function resolvePathUnderRoot(root: string, inputPath: unknown): string {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw nodeError("invalid_request", "path must be a non-empty string");
  }

  if (isAbsolute(inputPath)) {
    throw nodeError("policy_denied", "absolute input paths are not allowed", 403);
  }

  const candidate = resolveWorkspacePath(root, inputPath);
  return requireInsideWorkspace(root, candidate, "path");
}

export function resolveCreatablePathUnderRoot(root: string, inputPath: unknown): string {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw nodeError("invalid_request", "path must be a non-empty string");
  }

  if (isAbsolute(inputPath)) {
    throw nodeError("policy_denied", "absolute input paths are not allowed", 403);
  }

  const candidate = resolveWorkspacePath(root, inputPath);
  const parent = nearestExistingParent(dirname(candidate));
  const verifiedParent = requireInsideWorkspace(root, parent, "parent path");
  return join(verifiedParent, relative(parent, candidate));
}

export function resolveWorkspacePath(root: string, targetPath: string): string {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(root, targetPath);
  const relativePath = relative(absoluteRoot, absoluteTarget);

  if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`) || isAbsolute(relativePath)) {
    throw nodeError("policy_denied", `Path escapes workspace root: ${targetPath}`, 403);
  }

  return absoluteTarget;
}

export function toWorkspaceRelativePath(root: string, targetPath: string): string {
  return relative(resolve(root), resolveWorkspacePath(root, targetPath)).split("\\").join("/");
}

export function requireInsideWorkspace(workspaceRoot: string, candidate: string, label: string): string {
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw nodeError("policy_denied", `${label} does not exist or is not accessible`, 403);
  }

  if (!isInside(workspaceRoot, real)) {
    throw nodeError("policy_denied", `${label} escapes workspace root`, 403);
  }

  return real;
}

export function commandEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const passthrough = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "SHELL", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS"];
  const env: Record<string, string> = { CI: "1", NO_COLOR: "1" };
  for (const key of passthrough) {
    const value = base[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) {
    return { text, truncated: false };
  }

  return {
    text: new TextDecoder().decode(encoded.slice(0, maxBytes)),
    truncated: true,
  };
}

function assertRequestedCommandsAllowed(nodeAllowed: Set<string>, requestedAllowed: string[]): Set<string> {
  const result = new Set<string>();
  for (const command of requestedAllowed) {
    if (!nodeAllowed.has(command)) {
      throw nodeError("policy_denied", `Command '${command}' is not allowed by node policy`, 403);
    }
    result.add(command);
  }
  return result;
}

function nearestExistingParent(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      throw nodeError("policy_denied", "parent path does not exist or is not accessible", 403);
    }
    current = parent;
  }
  return current;
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function secondsToMs(seconds: number): number {
  return seconds * 1000;
}

function resolveSubcommand(command: string, argv: string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return undefined;
}

function matchesDeniedEntry(entry: string, command: string, subcommand: string | undefined): boolean {
  const parts = entry.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0] === command;
  }
  return parts[0] === command && parts[1] === subcommand;
}
