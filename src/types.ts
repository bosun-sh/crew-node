export const NODE_TOOL_IDS = [
  "list-repo-files",
  "read-repo-file",
  "read-file-range",
  "outline-file",
  "search-repo",
  "write-repo-file",
  "delete-repo-file",
  "run-command",
  "git-diff",
  "git-status",
  "prepare-workspace",
  "finalize-workspace",
  "read-cumulative-diff",
  "collect-safety-findings",
] as const;

export type RunnerToolId = (typeof NODE_TOOL_IDS)[number];

export type ToolId = RunnerToolId;

// Cloud's ExecutionPolicy carries additional orchestration-only concerns (profile, budgets,
// review cycles, context limits, ...) that Node never reads and does not enforce; those stay
// Cloud-side and are trimmed off the wire policy Cloud sends here (see cloud/apps/runner/src/
// autonomy/tool-backend.ts). Node's ToolPolicy is exactly the ceiling fields effectivePolicy
// reads, plus allowPublish.
export interface ToolPolicy {
  allowWrites?: boolean;
  allowCommands?: string[];
  allowedCommands?: string[];
  deniedCommands?: string[];
  timeoutSeconds?: number;
  commandTimeoutMs?: number;
  outputMaxBytes?: number;
  maxOutputBytes?: number;
  allowPublish?: boolean;
}

export interface CommandResult {
  argv: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  allowed: boolean;
  reason?: string;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
}

export interface WorkspaceHandle {
  root: string;
  branch: string;
  baseSha: string;
  baseBranch: string;
  createdAt: string;
}

export interface SafetyFinding {
  kind: "unrelated-change" | "high-risk-path" | "large-diff";
  severity: "info" | "warning" | "error";
  path?: string;
  reason: string;
}
