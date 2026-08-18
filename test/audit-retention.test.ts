import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditRecord, writeAudit } from "../src/audit.js";
import { testConfig } from "./helpers.js";

function record(id: string): AuditRecord {
  return {
    requestId: id,
    tool: "run-command",
    root: ".",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    status: "success",
  };
}

describe("audit log rotation and retention", () => {
  test("rolls the live log to a timestamped file once it reaches auditMaxBytes", () => {
    const config = testConfig({ auditMaxBytes: 10 });
    writeAudit(config, record("req-1"));
    writeAudit(config, record("req-2"));

    const entries = readdirSync(config.auditDir);
    expect(entries).toContain("crew-node-audit.jsonl");
    const rotated = entries.filter((entry) => entry.startsWith("crew-node-audit-") && entry.endsWith(".jsonl"));
    expect(rotated.length).toBe(1);

    const liveContent = readFileSync(join(config.auditDir, "crew-node-audit.jsonl"), "utf8");
    expect(liveContent).toContain("req-2");
    expect(liveContent).not.toContain("req-1");

    const rotatedContent = readFileSync(join(config.auditDir, rotated[0]!), "utf8");
    expect(rotatedContent).toContain("req-1");
  });

  test("deletes rotated files older than auditRetentionDays but keeps recent ones and the live log", () => {
    const config = testConfig({ auditRetentionDays: 1 });
    const oldRotated = join(config.auditDir, "crew-node-audit-2000-01-01T00-00-00-000Z.jsonl");
    const recentRotated = join(config.auditDir, "crew-node-audit-2999-01-01T00-00-00-000Z.jsonl");
    writeFileSync(oldRotated, `${JSON.stringify(record("old"))}\n`, { mode: 0o600 });
    writeFileSync(recentRotated, `${JSON.stringify(record("recent"))}\n`, { mode: 0o600 });
    const farPast = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
    utimesSync(oldRotated, farPast, farPast);

    writeAudit(config, record("req-live"));

    const entries = readdirSync(config.auditDir);
    expect(entries).not.toContain("crew-node-audit-2000-01-01T00-00-00-000Z.jsonl");
    expect(entries).toContain("crew-node-audit-2999-01-01T00-00-00-000Z.jsonl");
    expect(entries).toContain("crew-node-audit.jsonl");
  });
});
