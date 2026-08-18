import { nodeError } from "./errors.js";
import { gitDiff, gitStatus, runCommandTool } from "./tool-commands.js";
import type { ToolContext } from "./tool-context.js";
import {
  deleteRepoFile,
  listRepoFiles,
  outlineFile,
  readFileRange,
  readRepoFile,
  searchRepo,
  writeRepoFile,
} from "./tool-files.js";
import {
  collectSafetyFindingsTool,
  finalizeWorkspace,
  prepareWorkspace,
  readCumulativeDiffTool,
} from "./tool-workspace.js";
import type { ToolId } from "./types.js";

export async function executeTool(tool: ToolId, input: unknown, context: ToolContext): Promise<unknown> {
  switch (tool) {
    case "list-repo-files": return listRepoFiles(input, context);
    case "read-repo-file": return readRepoFile(input, context);
    case "read-file-range": return readFileRange(input, context);
    case "outline-file": return outlineFile(input, context);
    case "search-repo": return searchRepo(input, context);
    case "write-repo-file": return writeRepoFile(input, context);
    case "delete-repo-file": return deleteRepoFile(input, context);
    case "run-command": return runCommandTool(input, context);
    case "git-diff": return gitDiff(input, context);
    case "git-status": return gitStatus(input, context);
    case "prepare-workspace": return prepareWorkspace(input, context);
    case "finalize-workspace": return finalizeWorkspace(input, context);
    case "read-cumulative-diff": return readCumulativeDiffTool(input, context);
    case "collect-safety-findings": return collectSafetyFindingsTool(input, context);
  }
  return assertNever(tool);
}

function assertNever(value: never): never {
  throw nodeError("invalid_request", `Unsupported tool: ${String(value)}`);
}
