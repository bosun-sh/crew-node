import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../src/redact.js";
import { AuditRecord, buildAuditRecord, writeAudit } from "../src/audit.js";
import { testConfig } from "./helpers.js";

describe("redactSecrets", () => {
  test("redacts KEY=VALUE style secrets while keeping the key name visible", () => {
    expect(redactSecrets("export TOKEN=abcdef123456")).toBe("export TOKEN=[redacted]");
    expect(redactSecrets("DB_PASSWORD=hunter2 ready")).toBe("DB_PASSWORD=[redacted] ready");
  });

  test("redacts bearer tokens and provider-shaped keys", () => {
    expect(redactSecrets("Authorization: Bearer abcdefgh12345678")).toBe("Authorization: Bearer [redacted]");
    expect(redactSecrets("key is sk-abcdefghijklmnopqrstuvwx")).toBe("key is [redacted:openai-key]");
    expect(redactSecrets("token ghp_abcdefghijklmnopqrstuvwx012345")).toBe("token [redacted:github-token]");
  });

  test("leaves ordinary text untouched", () => {
    expect(redactSecrets("hello world, no secrets here")).toBe("hello world, no secrets here");
  });
});

describe("audit log redaction", () => {
  function readLastAuditLine(auditDir: string): Record<string, unknown> {
    const content = readFileSync(join(auditDir, "crew-node-audit.jsonl"), "utf8").trim().split("\n").pop();
    expect(content).toBeTruthy();
    return JSON.parse(content!);
  }

  test("redacts a quoted generic secret in failureReason that JSON.stringify would otherwise unmask", () => {
    const config = testConfig();
    const record: AuditRecord = {
      requestId: "req-1",
      tool: "run-command",
      root: ".",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: "failure",
      failureReason: `export TOKEN="abcdef123456"`,
    };

    writeAudit(config, record);

    const line = readFileSync(join(config.auditDir, "crew-node-audit.jsonl"), "utf8");
    expect(line).not.toContain("abcdef123456");
    expect(readLastAuditLine(config.auditDir).failureReason).toBe("export TOKEN=[redacted]");
  });

  test("redacts secrets nested in mutatingDiff.preview and inside touchedPaths array entries", () => {
    const config = testConfig();
    const result = {
      diff: `--- a\n+++ b\n+API_KEY="deadbeef00112233"`,
      touchedPaths: [`config file for SECRET="topsecretvalue"`],
    };

    const record = buildAuditRecord(
      config,
      {
        requestId: "req-2",
        tool: "git-diff",
        root: ".",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        status: "success",
      },
      result,
    );
    writeAudit(config, record);

    const raw = readFileSync(join(config.auditDir, "crew-node-audit.jsonl"), "utf8");
    expect(raw).not.toContain("deadbeef00112233");
    expect(raw).not.toContain("topsecretvalue");

    const parsed = readLastAuditLine(config.auditDir);
    expect((parsed.mutatingDiff as { preview: string }).preview).toContain("API_KEY=[redacted]");
    expect((parsed.touchedPaths as string[])[0]).toContain("SECRET=[redacted]");
  });

  test("leaves non-string fields like exitCode intact after redaction", () => {
    const config = testConfig();
    const record: AuditRecord = {
      requestId: "req-3",
      tool: "run-command",
      root: ".",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: "success",
      exitCode: 0,
    };

    writeAudit(config, record);
    expect(readLastAuditLine(config.auditDir).exitCode).toBe(0);
  });
});
