import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../src/config.js";
import { toNodeError } from "../src/errors.js";
import { executeAuditedTool } from "../src/executor.js";

export function tempDir(prefix = "crew-node-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const root = overrides.workspaceRoot ?? tempDir();
  const dashboardUrl = "http://127.0.0.1:3000";
  const auditDir = overrides.auditDir ?? join(root, ".crew-audit");
  const stateDir = overrides.stateDir ?? join(auditDir, "state");
  if (!existsSync(auditDir) || statSync(auditDir).isDirectory()) mkdirSync(auditDir, { recursive: true });
  if ((!existsSync(auditDir) || statSync(auditDir).isDirectory()) && (!existsSync(stateDir) || statSync(stateDir).isDirectory())) {
    mkdirSync(stateDir, { recursive: true });
  }
  return {
    apiKey: `crew_node_key_v2.${Buffer.from(dashboardUrl).toString("base64url")}.${Buffer.alloc(32, 1).toString("base64url")}`,
    dashboardUrl,
    workspaceRoot: root,
    port: 4321,
    commandTimeoutSeconds: 2,
    outputMaxBytes: 65_536,
    allowedCommands: new Set(),
    allowWrites: true,
    auditDir,
    stateDir,
    auditMaxBytes: 50_000_000,
    auditRetentionDays: 30,
    ...overrides,
  };
}

export async function execute(config: Config, body: unknown): Promise<Response> {
  try {
    const result = await executeAuditedTool(config, body as never);
    return Response.json(result);
  } catch (error) {
    const nodeError = toNodeError(error);
    return Response.json({ ok: false, error: { code: nodeError.code, message: nodeError.message } }, { status: nodeError.status });
  }
}
