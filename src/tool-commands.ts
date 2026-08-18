import { spawn } from "node:child_process";
import { nodeError } from "./errors.js";
import { GIT_HARDENING_ARGS } from "./git-policy.js";
import { checkCommandAllowed, commandEnv, resolvePathUnderRoot, truncateText } from "./policy.js";
import type { EffectivePolicy } from "./policy.js";
import { redactSecrets } from "./redact.js";
import type { ToolContext } from "./tool-context.js";
import { objectInput, safeRef } from "./tool-input.js";
import type { CommandResult } from "./types.js";

export async function runCommandTool(input: unknown, context: ToolContext): Promise<CommandResult> {
  const value = objectInput(input);
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.length > 256 || value.argv.some((arg) => typeof arg !== "string" || arg.length > 16_384)) {
    throw nodeError("invalid_request", "argv must contain 1 to 256 bounded strings");
  }
  const cwd = typeof value.cwd === "string" ? resolvePathUnderRoot(context.root, value.cwd) : context.root;
  return runWorkspaceCommand(value.argv as string[], cwd, context.policy, typeof value.reason === "string" ? value.reason.slice(0, 1_000) : undefined);
}

export async function gitDiff(input: unknown, context: ToolContext): Promise<{ diff: string; exitCode: number }> {
  const value = objectInput(input ?? {});
  const args = [
    "diff",
    "--no-ext-diff",
    ...(typeof value.baseRef === "string" ? [safeRef(value.baseRef, "baseRef")] : []),
    ...(value.nameOnly === true ? ["--name-only"] : []),
    "--",
    ".",
  ];
  const result = await runWorkspaceCommand(["git", ...args], context.root, context.policy, value.nameOnly ? "read changed files" : "read diff");
  return { diff: result.stdout || result.stderr, exitCode: result.exitCode };
}

export async function gitStatus(input: unknown, context: ToolContext): Promise<{ status: string; exitCode: number }> {
  const value = objectInput(input ?? {});
  const result = await runWorkspaceCommand(["git", "status", value.porcelain === true ? "--porcelain" : "--short"], context.root, context.policy, "read status");
  return { status: result.stdout || result.stderr, exitCode: result.exitCode };
}

async function runWorkspaceCommand(
  argv: string[],
  cwd: string,
  policy: EffectivePolicy,
  reason?: string,
  stdin?: string,
): Promise<CommandResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const check = checkCommandAllowed(policy, argv);
  if (!check.allowed) return commandFailure(argv, cwd, startedAt, started, check.reason ?? "Command denied.", false);

  const spawnArgs = argv[0] === "git" ? [...GIT_HARDENING_ARGS, ...argv.slice(1)] : argv.slice(1);
  const proc = spawn(argv[0] ?? "", spawnArgs, {
    cwd,
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: commandEnv(),
    detached: process.platform !== "win32",
  });
  if (stdin !== undefined && proc.stdin) proc.stdin.end(stdin);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(proc);
  }, policy.timeoutMs);

  try {
    const captureLimit = Math.min(policy.outputMaxBytes * 2, 16_000_000);
    const [stdoutCapture, stderrCapture, exitCode] = await Promise.all([
      readStream(proc.stdout, captureLimit),
      readStream(proc.stderr, captureLimit),
      waitForExit(proc),
    ]);
    const stdout = truncateText(redactSecrets(stdoutCapture.text), policy.outputMaxBytes);
    const stderr = truncateText(redactSecrets(`${stderrCapture.text}${timedOut ? `\n[command killed after exceeding timeout of ${policy.timeoutMs}ms]` : ""}`), policy.outputMaxBytes);
    return {
      argv,
      cwd,
      exitCode: timedOut ? 124 : exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      allowed: true,
      ...(reason ? { reason } : {}),
      durationMs: Date.now() - started,
      stdoutTruncated: stdoutCapture.truncated || stdout.truncated,
      stderrTruncated: stderrCapture.truncated || stderr.truncated,
      timedOut,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function commandFailure(argv: string[], cwd: string, startedAt: string, started: number, reason: string, allowed: boolean): CommandResult {
  return {
    argv,
    cwd,
    exitCode: allowed ? 127 : 1,
    stdout: "",
    stderr: reason,
    allowed,
    reason,
    durationMs: Date.now() - started,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function readStream(stream: NodeJS.ReadableStream | null, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return Promise.resolve({ text: "", truncated: false });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.byteLength;
      }
      if (buffer.byteLength > remaining) truncated = true;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ text: Buffer.concat(chunks, bytes).toString("utf8"), truncated }));
  });
}

function waitForExit(proc: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    proc.on("error", () => resolve(127));
    proc.on("close", (code) => resolve(code ?? 0));
  });
}

function killProcessTree(proc: ReturnType<typeof spawn>): void {
  try {
    if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
    else proc.kill("SIGKILL");
  } catch {
    try { proc.kill("SIGKILL"); } catch {}
  }
}
