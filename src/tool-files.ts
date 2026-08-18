import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { nodeError } from "./errors.js";
import {
  resolveCreatablePathUnderRoot,
  resolvePathUnderRoot,
  toWorkspaceRelativePath,
  truncateText,
} from "./policy.js";
import { isSensitivePath, redactSecrets } from "./redact.js";
import type { ToolContext } from "./tool-context.js";
import { assertWritesAllowed, boundedOutput, objectInput, positiveInteger } from "./tool-input.js";

const MAX_LISTED_FILES = 10_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;

export function listRepoFiles(input: unknown, context: ToolContext): string[] {
  const value = objectInput(input);
  const maxFiles = Math.min(positiveInteger(value.maxFiles, 500), MAX_LISTED_FILES);
  const files: string[] = [];
  walkFiles(context.root, context.root, files, maxFiles);
  return files.sort();
}

export function readRepoFile(input: unknown, context: ToolContext): { path: string; content: string; truncated: boolean } {
  const value = objectInput(input);
  const maxBytes = boundedOutput(value.maxBytes, context.policy.outputMaxBytes);
  const target = resolvePathUnderRoot(context.root, value.path);
  const path = toWorkspaceRelativePath(context.root, target);
  assertReadable(path);
  const bounded = truncateText(redactSecrets(readBoundedText(target, maxBytes + 1)), maxBytes);
  return {
    path,
    content: bounded.truncated ? `${bounded.text}\n\n[truncated]` : bounded.text,
    truncated: bounded.truncated,
  };
}

export function readFileRange(
  input: unknown,
  context: ToolContext,
): { path: string; content: string; startLine: number; endLine: number; totalLines: number } {
  const value = objectInput(input);
  const startLine = positiveInteger(value.startLine, 1);
  const endLine = positiveInteger(value.endLine, startLine);
  const maxBytes = boundedOutput(value.maxBytes, context.policy.outputMaxBytes);
  const target = resolvePathUnderRoot(context.root, value.path);
  const path = toWorkspaceRelativePath(context.root, target);
  assertReadable(path);
  const lines = readBoundedText(target, MAX_SEARCH_FILE_BYTES, true).split("\n");
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, Math.max(start, endLine));
  const bounded = truncateText(lines.slice(start - 1, end).join("\n"), maxBytes);
  return {
    path,
    content: bounded.truncated ? `${bounded.text}\n[truncated]` : bounded.text,
    startLine: start,
    endLine: end,
    totalLines: lines.length,
  };
}

export function outlineFile(input: unknown, context: ToolContext): { path: string; outline: string[]; totalLines: number } {
  const value = objectInput(input);
  const file = readRepoFile({ path: value.path, maxBytes: boundedOutput(value.maxBytes, context.policy.outputMaxBytes) }, context);
  const lines = file.content.split("\n");
  const pattern = /^\s{0,2}(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|def)\s+([A-Za-z0-9_$]+)/;
  return {
    path: file.path,
    outline: lines.flatMap((line, index) => pattern.test(line) ? [`${index + 1}: ${line.trim().slice(0, 120)}`] : []),
    totalLines: lines.length,
  };
}

export function searchRepo(input: unknown, context: ToolContext): { matches: string; exitCode: number } {
  const value = objectInput(input);
  if (typeof value.query !== "string" || !value.query || value.query.length > 1_000) {
    throw nodeError("invalid_request", "query must be a non-empty string of at most 1000 characters");
  }
  const matches: string[] = [];
  for (const file of listRepoFiles({ maxFiles: MAX_LISTED_FILES }, context)) {
    const content = safeReadText(resolvePathUnderRoot(context.root, file));
    if (content === null) continue;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (line.includes(value.query)) matches.push(`${file}:${index + 1}:${line}`);
    }
  }
  const output = truncateText(redactSecrets(matches.join("\n")), context.policy.outputMaxBytes);
  return { matches: output.truncated ? `${output.text}\n[truncated]` : output.text, exitCode: matches.length ? 0 : 1 };
}

export function writeRepoFile(input: unknown, context: ToolContext): { kind: "write"; path: string; bytesWritten: number; existedBefore: boolean } {
  assertWritesAllowed(context.policy);
  const value = objectInput(input);
  if (typeof value.content !== "string") throw nodeError("invalid_request", "content must be a string");
  const target = resolveCreatablePathUnderRoot(context.root, value.path);
  assertWritable(toWorkspaceRelativePath(context.root, target));
  const existedBefore = existsSync(target);
  if (existedBefore && lstatSync(target).isSymbolicLink()) {
    throw nodeError("policy_denied", "Refusing to write through a symbolic link", 403);
  }
  mkdirSync(dirname(target), { recursive: true });
  const descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, value.content, "utf8");
  } finally {
    closeSync(descriptor);
  }
  return {
    kind: "write",
    path: toWorkspaceRelativePath(context.root, target),
    bytesWritten: Buffer.byteLength(value.content),
    existedBefore,
  };
}

export function deleteRepoFile(input: unknown, context: ToolContext): { kind: "delete"; path: string; existedBefore: boolean } {
  assertWritesAllowed(context.policy);
  const target = resolveCreatablePathUnderRoot(context.root, objectInput(input).path);
  assertWritable(toWorkspaceRelativePath(context.root, target));
  const existedBefore = existsSync(target);
  if (existedBefore) rmSync(target, { force: true });
  return { kind: "delete", path: toWorkspaceRelativePath(context.root, target), existedBefore };
}

export function readBoundedText(path: string, maxBytes: number, rejectOversize = false): string {
  return new TextDecoder().decode(readBoundedBytes(path, maxBytes, rejectOversize));
}

function assertReadable(path: string): void {
  if (isSensitivePath(path)) throw nodeError("policy_denied", `Refusing to read sensitive file: ${path}`, 403);
}

function assertWritable(path: string): void {
  if (isSensitivePath(path)) throw nodeError("policy_denied", `Refusing to write a sensitive file: ${path}`, 403);
}

function walkFiles(root: string, directory: string, files: string[], maxFiles: number): void {
  if (files.length >= maxFiles) return;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", ".git", ".crew", ".crew-audit", ".mastra", "dist", "coverage"].includes(entry.name)) {
        walkFiles(root, absolute, files, maxFiles);
      }
    } else if (entry.isFile()) {
      const path = toWorkspaceRelativePath(root, absolute);
      if (!isSensitivePath(path)) files.push(path);
    }
  }
}

function safeReadText(path: string): string | null {
  try {
    const data = Buffer.from(readBoundedBytes(path, MAX_SEARCH_FILE_BYTES));
    return data.includes(0) ? null : redactSecrets(data.toString("utf8"));
  } catch {
    return null;
  }
}

function readBoundedBytes(path: string, maxBytes: number, rejectOversize = false): Uint8Array {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(descriptor).size;
    if (size > maxBytes && rejectOversize) {
      throw nodeError("policy_denied", `File exceeds the ${maxBytes} byte inspection limit.`, 403);
    }
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    readSync(descriptor, buffer, 0, length, 0);
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}
