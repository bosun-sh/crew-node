import { buildAuditRecord, writeAudit } from "./audit.js";
import { Config } from "./config.js";
import { toNodeError } from "./errors.js";
import { effectivePolicy, resolveRoot } from "./policy.js";
import { executeTool } from "./tools.js";
import { RunnerToolId, ToolPolicy } from "./types.js";

export interface ToolJob {
  id?: string;
  root: unknown;
  policy?: ToolPolicy;
  tool: RunnerToolId;
  input: unknown;
}

export async function executeAuditedTool(
  config: Config,
  job: ToolJob,
  execute: typeof executeTool = executeTool,
): Promise<unknown> {
  const startedAt = new Date().toISOString();
  let root: string | null = null;
  try {
    root = resolveRoot(config, job.root);
    const result = await execute(job.tool, job.input, {
      config,
      root,
      policy: effectivePolicy(config, job.policy),
    });
    writeAudit(config, buildAuditRecord(config, {
      requestId: job.id ?? null,
      tool: job.tool,
      root,
      startedAt,
      endedAt: new Date().toISOString(),
      status: "success",
    }, result));
    return result;
  } catch (error) {
    const nodeError = toNodeError(error);
    writeAudit(config, buildAuditRecord(config, {
      requestId: job.id ?? null,
      tool: job.tool ?? null,
      root,
      startedAt,
      endedAt: new Date().toISOString(),
      status: "failure",
      failureReason: nodeError.message,
    }));
    throw nodeError;
  }
}
