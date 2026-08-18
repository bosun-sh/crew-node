import { spawnSync } from "node:child_process";
import { nodeError } from "./errors.js";
import { GIT_HARDENING_ARGS } from "./git-policy.js";
import { checkCommandAllowed, checkPublishAllowed, commandEnv, resolveWorkspacePath, truncateText } from "./policy.js";
import { isSensitivePath, redactSecrets } from "./redact.js";
import { globMatches } from "./runtime.js";
import type { ToolContext } from "./tool-context.js";
import { readBoundedText } from "./tool-files.js";
import { assertWritesAllowed, isSafeBranch, objectInput, safeRef } from "./tool-input.js";
import type { SafetyFinding, WorkspaceHandle } from "./types.js";

const HIGH_RISK_PATTERNS = [
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /^Dockerfile(\.|$)/,
  /^docker-compose\./,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^bun\.lock$/,
  /^yarn\.lock$/,
  /^\.npmrc$/,
  /^\.env/,
  /^scripts\/.*\.(sh|bash|zsh)$/,
];
const LARGE_DIFF_BYTES = 250_000;

export function prepareWorkspace(input: unknown, context: ToolContext): { workspace: WorkspaceHandle; warnings: string[] } {
  assertWritesAllowed(context.policy);
  const value = objectInput(input);
  if (typeof value.runId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.runId)) {
    throw nodeError("invalid_request", "runId must contain 1 to 128 safe characters");
  }
  if (gitRaw(context, ["rev-parse", "--git-dir"]).exitCode !== 0) {
    throw nodeError("tool_failed", `Workspace branch isolation requires a git repository at ${context.root}.`, 500);
  }
  if (typeof value.resumeWorkspace === "object" && value.resumeWorkspace !== null) {
    return { workspace: resumeWorkspace(context, value.resumeWorkspace), warnings: [] };
  }

  const dirty = dirtyFiles(context);
  if (dirty.length && value.allowDirty !== true) {
    throw nodeError("tool_failed", `Work tree has uncommitted changes outside .crew/: ${dirty.slice(0, 10).join(", ")}${dirty.length > 10 ? "..." : ""}.`, 409);
  }
  const head = gitRaw(context, ["rev-parse", "HEAD"]);
  if (head.exitCode !== 0) throw nodeError("tool_failed", "Workspace branch isolation requires at least one commit (HEAD is unborn).", 500);
  const baseSha = head.stdout.trim();
  const abbreviation = gitRaw(context, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const baseBranch = abbreviation === "HEAD" ? "" : abbreviation;
  const branch = `crew/${value.runId}`;
  const checkout = gitRaw(context, ["checkout", "-b", branch]);
  if (checkout.exitCode !== 0) throw nodeError("tool_failed", `Could not create run branch ${branch}: ${checkout.stderr.trim()}`, 500);
  return { workspace: { root: context.root, branch, baseSha, baseBranch, createdAt: new Date().toISOString() }, warnings: [] };
}

export function finalizeWorkspace(input: unknown, context: ToolContext): { committed: boolean; sha?: string } {
  assertWritesAllowed(context.policy);
  const value = objectInput(input);
  const workspace = workspaceHandle(value.workspace);
  if (!isOutcome(value.outcome) || typeof value.goal !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(typeof value.runId === "string" ? value.runId : "")) {
    throw nodeError("invalid_request", "outcome, goal, and runId are required");
  }
  const add = gitRaw(context, ["add", "-A", "--", ".", ":(exclude).crew"]);
  if (add.exitCode !== 0) throw nodeError("tool_failed", `Could not stage run changes: ${add.stderr.trim()}`, 500);

  let sha: string | undefined;
  if (gitRaw(context, ["diff", "--cached", "--quiet"]).exitCode !== 0) {
    const prefix = value.outcome === "complete" ? "crew" : `crew(${value.outcome === "failed" ? "wip-failed" : "wip-blocked"})`;
    const goal = value.goal.replace(/[\r\n]/g, " ").slice(0, 200);
    const commit = gitRaw(context, ["commit", "--no-verify", "-m", `${prefix}: ${goal} [run ${value.runId}]`]);
    if (commit.exitCode !== 0) throw nodeError("tool_failed", `Could not commit run changes: ${commit.stderr.trim()}`, 500);
    sha = gitRaw(context, ["rev-parse", "HEAD"]).stdout.trim();
  }

  if (value.restoreBaseBranch === true) {
    const target = workspace.baseBranch || workspace.baseSha;
    const checkout = gitRaw(context, ["checkout", target]);
    if (checkout.exitCode !== 0) throw nodeError("tool_failed", `Could not restore ${target}: ${checkout.stderr.trim()}`, 500);
  }
  if (sha && value.publishRemote === true) {
    if (!workspace.branch.startsWith("crew/")) throw nodeError("tool_failed", "Refusing to publish an invalid Crew branch.", 500);
    const permission = checkPublishAllowed(context.policy);
    if (!permission.allowed) throw nodeError("policy_denied", permission.reason ?? "Publishing is not allowed by policy", 403);
    const push = gitPush(context, ["origin", `HEAD:refs/heads/${workspace.branch}`], 120_000);
    if (push.exitCode !== 0) throw nodeError("tool_failed", `Could not publish ${workspace.branch}: ${push.stderr.trim()}`, 500);
  }
  return sha ? { committed: true, sha } : { committed: false };
}

export function readCumulativeDiffTool(input: unknown, context: ToolContext): { diff: string } {
  const value = objectInput(input ?? {});
  return { diff: readCumulativeDiff(context, typeof value.baseRef === "string" ? value.baseRef : undefined, context.policy.outputMaxBytes) };
}

export function collectSafetyFindingsTool(input: unknown, context: ToolContext): { changedFiles: string[]; findings: SafetyFinding[] } {
  const value = objectInput(input ?? {});
  const baseRef = typeof value.baseRef === "string" ? value.baseRef : undefined;
  const allowedGlobs = Array.isArray(value.allowedChangeGlobs)
    ? value.allowedChangeGlobs.filter((glob): glob is string => typeof glob === "string").slice(0, 100)
    : [];
  const changedFiles = collectChangedFiles(context, baseRef);
  const findings: SafetyFinding[] = [];
  for (const path of changedFiles) {
    if (allowedGlobs.length && !allowedGlobs.some((pattern) => globMatches(pattern, path))) {
      findings.push({ kind: "unrelated-change", severity: "warning", path, reason: `Changed file is outside the allowed change globs: ${allowedGlobs.join(", ")}` });
    }
    if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(path))) {
      findings.push({ kind: "high-risk-path", severity: "warning", path, reason: "Changed file is in a high-risk operational, dependency, or secret-adjacent path." });
    }
  }
  const diffBytes = Buffer.byteLength(gitRaw(context, ["diff", ...(baseRef ? [safeRef(baseRef, "baseRef")] : []), "--", "."]).stdout);
  if (diffBytes > LARGE_DIFF_BYTES) {
    findings.push({ kind: "large-diff", severity: "warning", reason: `Cumulative diff is ${diffBytes} bytes, above the ${LARGE_DIFF_BYTES} byte review threshold.` });
  }
  return { changedFiles, findings };
}

function readCumulativeDiff(context: ToolContext, baseRef: string | undefined, maxBytes: number): string {
  const sections = [gitRaw(context, ["diff", ...(baseRef ? [safeRef(baseRef, "baseRef")] : []), "--", "."]).stdout];
  const untracked = gitRaw(context, ["status", "--porcelain"]).stdout
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3).trim())
    .filter((path) => path && !path.startsWith(".crew/") && !isSensitivePath(path));
  for (const path of untracked.slice(0, 50)) {
    try {
      const content = readBoundedText(resolveWorkspacePath(context.root, path), maxBytes);
      sections.push(["--- /dev/null", `+++ b/${path} (untracked)`, ...content.split("\n").map((line) => `+${line}`)].join("\n"));
    } catch {}
  }
  const bounded = truncateText(redactSecrets(sections.filter(Boolean).join("\n")), maxBytes);
  return bounded.truncated ? `${bounded.text}\n[truncated]` : bounded.text;
}

function collectChangedFiles(context: ToolContext, baseRef?: string): string[] {
  const tracked = gitRaw(context, ["diff", "--name-only", ...(baseRef ? [safeRef(baseRef, "baseRef")] : []), "--", "."]).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const untracked = gitRaw(context, ["status", "--porcelain"]).stdout.split("\n").filter((line) => line.startsWith("??")).map((line) => line.slice(3).trim()).filter(Boolean);
  return [...new Set([...tracked, ...untracked])].filter((path) => path !== ".crew" && !path.startsWith(".crew/"));
}

function resumeWorkspace(context: ToolContext, value: unknown): WorkspaceHandle {
  const info = workspaceHandle(value);
  if (gitRaw(context, ["rev-parse", "--verify", `refs/heads/${info.branch}`]).exitCode !== 0) {
    throw nodeError("tool_failed", `Cannot resume: run branch ${info.branch} no longer exists.`, 500);
  }
  const current = gitRaw(context, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (current !== info.branch) {
    const checkout = gitRaw(context, ["checkout", info.branch]);
    if (checkout.exitCode !== 0) throw nodeError("tool_failed", `Could not check out run branch ${info.branch}: ${checkout.stderr.trim()}`, 500);
  }
  return { ...info, root: context.root };
}

function workspaceHandle(value: unknown): WorkspaceHandle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw nodeError("invalid_request", "workspace is invalid");
  const info = value as Record<string, unknown>;
  if (typeof info.root !== "string" || typeof info.branch !== "string" || typeof info.baseSha !== "string" || typeof info.baseBranch !== "string" || typeof info.createdAt !== "string") {
    throw nodeError("invalid_request", "workspace is invalid");
  }
  if (!/^crew\/[A-Za-z0-9_-]{1,128}$/.test(info.branch) || !/^[a-f0-9]{40,64}$/.test(info.baseSha) || !isSafeBranch(info.baseBranch)) {
    throw nodeError("invalid_request", "workspace identifiers are invalid");
  }
  return { root: info.root, branch: info.branch, baseSha: info.baseSha, baseBranch: info.baseBranch, createdAt: info.createdAt };
}

function dirtyFiles(context: ToolContext): string[] {
  return gitRaw(context, ["status", "--porcelain"]).stdout.split("\n").filter(Boolean).map((line) => line.slice(3).trim()).filter((path) => path && path !== ".crew" && !path.startsWith(".crew/"));
}

type GitResult = { stdout: string; stderr: string; exitCode: number };

// Every internal Git invocation goes through the real policy check against its actual argv, so
// the argument screening and write gating in checkCommandAllowed apply uniformly here too.
function gitRaw(context: ToolContext, args: string[], timeout = 30_000): GitResult {
  const check = checkCommandAllowed(context.policy, ["git", ...args]);
  if (!check.allowed) throw nodeError("policy_denied", check.reason ?? "Git is denied by policy", 403);
  return spawnGit(context.root, args, timeout);
}

// `push` is deliberately absent from GIT_SUBCOMMAND_ALLOWLIST (run-command/git-diff must always
// deny it); finalizeWorkspace's publish flow is gated by checkPublishAllowed instead, so this
// bypasses the general subcommand check rather than being denied by it.
function gitPush(context: ToolContext, args: string[], timeout = 30_000): GitResult {
  return spawnGit(context.root, ["push", ...args], timeout);
}

function spawnGit(root: string, args: string[], timeout: number): GitResult {
  const identity = args[0] === "commit" ? ["-c", "user.name=crew-agent", "-c", "user.email=crew-agent@local"] : [];
  const process = spawnSync("git", [...GIT_HARDENING_ARGS, ...identity, ...args], {
    cwd: root,
    env: commandEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: 1_000_000,
  });
  const decoder = new TextDecoder();
  return { stdout: decoder.decode(process.stdout), stderr: decoder.decode(process.stderr), exitCode: process.status ?? 1 };
}

function isOutcome(value: unknown): value is "complete" | "failed" | "blocked" {
  return value === "complete" || value === "failed" || value === "blocked";
}
