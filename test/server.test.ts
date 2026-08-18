import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHandler } from "../src/server.js";
import { execute, tempDir, testConfig } from "./helpers.js";
import { spawnSync } from "node:child_process";

describe("server", () => {
  test("healthz is public", async () => {
    const handler = createHandler(testConfig());
    const response = await handler(new Request("http://crew-node.test/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "crew-node" });
  });

  test("readyz reports workspace, git, allowlisted binaries, and audit dir state", async () => {
    const root = tempDir();
    const auditDir = join(root, "audit");
    mkdirSync(auditDir);
    const handler = createHandler(testConfig({ workspaceRoot: root, auditDir }));

    const response = await handler(new Request("http://crew-node.test/readyz"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      checks: {
        workspaceRoot: { ok: true, path: root, exists: true, directory: true },
        git: { ok: true, command: "git" },
        allowedCommands: { ok: true, available: [], missing: [] },
        auditDir: { ok: true, path: auditDir, writable: true },
      },
    });
  });

  test("readyz fails when an allowed binary is missing and the audit dir is not writable", async () => {
    const root = tempDir();
    const auditPath = join(root, "audit-probe.txt");
    writeFileSync(auditPath, "not a directory", "utf8");
    const handler = createHandler(testConfig({ workspaceRoot: root, auditDir: auditPath, allowedCommands: new Set(["definitely-not-a-real-command"]) }));

    const response = await handler(new Request("http://crew-node.test/readyz"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      checks: {
        allowedCommands: { ok: false, missing: ["definitely-not-a-real-command"] },
        auditDir: { ok: false, path: auditPath, writable: false },
      },
    });
  });

  test("readyz reflects a stale or failed control-plane health stub when one is wired in", async () => {
    const root = tempDir();
    const auditDir = join(root, "audit");
    mkdirSync(auditDir);
    const config = testConfig({ workspaceRoot: root, auditDir });

    const healthy = createHandler(config, () => ({ hasSession: true, authFailed: false, lastHeartbeatAt: Date.now() }));
    const healthyResponse = await healthy(new Request("http://crew-node.test/readyz"));
    expect(healthyResponse.status).toBe(200);
    expect((await healthyResponse.json()).checks.controlPlane).toMatchObject({ ok: true });

    const failed = createHandler(config, () => ({ hasSession: false, authFailed: true, lastHeartbeatAt: undefined }));
    const failedResponse = await failed(new Request("http://crew-node.test/readyz"));
    expect(failedResponse.status).toBe(503);
    expect((await failedResponse.json()).checks.controlPlane).toMatchObject({ ok: false, authFailed: true });

    const stale = createHandler(config, () => ({ hasSession: true, authFailed: false, lastHeartbeatAt: Date.now() - 60_000 }));
    const staleResponse = await stale(new Request("http://crew-node.test/readyz"));
    expect(staleResponse.status).toBe(503);
    expect((await staleResponse.json()).checks.controlPlane).toMatchObject({ ok: false });
  });

  test("does not expose inbound execution or node protocol endpoints", async () => {
    const handler = createHandler(testConfig());
    const execution = await handler(new Request("http://crew-node.test/v1/tools/execute", { method: "POST" }));
    const heartbeat = await handler(new Request("http://crew-node.test/v1/node/heartbeat", { method: "POST" }));
    expect(execution.status).toBe(404);
    expect(heartbeat.status).toBe(404);
  });
});

describe("tools", () => {
  test("Runner file tools return raw backend shapes", async () => {
    const root = tempDir();
    const config = testConfig({ workspaceRoot: root });

    const write = await execute(config, {
      requestId: "write-1",
      root: ".",
      policy: { allowWrites: true },
      tool: "write-repo-file",
      input: { path: "src/example.txt", content: "alpha\nbeta\nalpha" },
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({ kind: "write", path: "src/example.txt", bytesWritten: 16, existedBefore: false });
    expect(readFileSync(join(root, "src/example.txt"), "utf8")).toBe("alpha\nbeta\nalpha");

    const read = await execute(config, {
      root: ".",
      tool: "read-repo-file",
      input: { path: "src/example.txt" },
    });
    expect(await read.json()).toMatchObject({ path: "src/example.txt", content: "alpha\nbeta\nalpha", truncated: false });

    const search = await execute(config, {
      root: ".",
      tool: "search-repo",
      input: { query: "alpha" },
    });
    const body = await search.json();
    expect(body.matches).toContain("src/example.txt:1:alpha");
    expect(body.exitCode).toBe(0);

    const list = await execute(config, {
      root: ".",
      tool: "list-repo-files",
      input: { maxFiles: 10 },
    });
    expect(await list.json()).toEqual(["src/example.txt"]);

    const range = await execute(config, {
      root: ".",
      tool: "read-file-range",
      input: { path: "src/example.txt", startLine: 2, endLine: 3 },
    });
    expect(await range.json()).toMatchObject({ content: "beta\nalpha", startLine: 2, endLine: 3, totalLines: 3 });
  });

  test("rejects path traversal", async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
    const config = testConfig({ workspaceRoot: root });

    const response = await execute(config, {
      root: ".",
      tool: "read-repo-file",
      input: { path: "../secret.txt" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "policy_denied" } });
  });

  test("rejects symlink escape", async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    const config = testConfig({ workspaceRoot: root });

    const response = await execute(config, {
      root: ".",
      tool: "read-repo-file",
      input: { path: "link.txt" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "policy_denied" } });
  });

  test("refuses to overwrite a final symlink", async () => {
    const root = tempDir();
    const outside = tempDir();
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "keep", "utf8");
    symlinkSync(secret, join(root, "write.txt"));
    const response = await execute(testConfig({ workspaceRoot: root }), {
      root: ".",
      policy: { allowWrites: true },
      tool: "write-repo-file",
      input: { path: "write.txt", content: "overwrite" },
    });
    expect(response.status).toBe(403);
    expect(readFileSync(secret, "utf8")).toBe("keep");
  });

  test("request output limits cannot broaden the host ceiling", async () => {
    const root = tempDir();
    writeFileSync(join(root, "large.txt"), "abcdefghij", "utf8");
    const response = await execute(testConfig({ workspaceRoot: root, outputMaxBytes: 4 }), {
      root: ".",
      tool: "read-repo-file",
      input: { path: "large.txt", maxBytes: 1_000_000 },
    });
    expect(await response.json()).toMatchObject({ content: "abcd\n\n[truncated]", truncated: true });
  });

  test("a request policy asking for writes cannot broaden a host with writes disabled", async () => {
    const root = tempDir();
    const response = await execute(testConfig({ workspaceRoot: root, allowWrites: false }), {
      root: ".",
      policy: { allowWrites: true },
      tool: "write-repo-file",
      input: { path: "write.txt", content: "hello" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "policy_denied" } });
  });

  test("refuses sensitive reads and redacts command output", async () => {
    const root = tempDir();
    writeFileSync(join(root, ".env"), "OPENAI_API_KEY=sk-secretsecretsecretsecret\n", "utf8");
    const config = testConfig({ workspaceRoot: root, allowedCommands: new Set(["printf"]) });

    const read = await execute(config, {
      root: ".",
      tool: "read-repo-file",
      input: { path: ".env" },
    });
    expect(read.status).toBe(403);

    const command = await execute(config, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: ["printf"] },
      tool: "run-command",
      input: { argv: ["printf", "OPENAI_API_KEY=sk-secretsecretsecretsecret"] },
    });
    const body = await command.json();
    expect(body.stdout).toContain("OPENAI_API_KEY=[redacted]");
  });

  test("denies commands by default", async () => {
    const config = testConfig();
    const response = await execute(config, {
      root: ".",
      tool: "run-command",
      input: { argv: ["echo", "hello"] },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ allowed: false, exitCode: 1 });
  });

  test("general executables require explicit write permission", async () => {
    const response = await execute(testConfig({ allowedCommands: new Set(["printf"]) }), {
      root: ".",
      policy: { allowedCommands: ["printf"] },
      tool: "run-command",
      input: { argv: ["printf", "hello"] },
    });
    expect(await response.json()).toMatchObject({ allowed: false, reason: "printf requires write permission." });
  });

  test("runs allowed commands and prevents request policy broadening", async () => {
    const config = testConfig({ allowedCommands: new Set(["printf"]) });
    const allowed = await execute(config, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: ["printf"] },
      tool: "run-command",
      input: { argv: ["printf", "hello"] },
    });
    const allowedBody = await allowed.json();
    expect(allowed.status).toBe(200);
    expect(allowedBody.stdout).toBe("hello");

    const broaden = await execute(config, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: ["git"] },
      tool: "run-command",
      input: { argv: ["git", "--version"] },
    });
    expect(broaden.status).toBe(403);
  });

  test("denies risky subcommands and runtime eval flags", async () => {
    const config = testConfig({ allowedCommands: new Set(["git", "node"]) });
    const git = await execute(config, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: ["git"] },
      tool: "run-command",
      input: { argv: ["git", "reset", "--hard"] },
    });
    expect(await git.json()).toMatchObject({ allowed: false });

    const node = await execute(config, {
      root: ".",
      policy: { allowedCommands: ["node"] },
      tool: "run-command",
      input: { argv: ["node", "-e", "console.log(1)"] },
    });
    expect(await node.json()).toMatchObject({ allowed: false });

    const globalConfig = await execute(config, {
      root: ".",
      policy: { allowedCommands: ["git"] },
      tool: "run-command",
      input: { argv: ["git", "-c", "core.fsmonitor=/tmp/evil", "status"] },
    });
    expect(await globalConfig.json()).toMatchObject({ allowed: false, reason: "git global option is denied: -c" });

    const normalSubcommandFlag = await execute(config, {
      root: ".",
      policy: { allowedCommands: ["git"] },
      tool: "run-command",
      input: { argv: ["git", "status", "--short"] },
    });
    expect(await normalSubcommandFlag.json()).toMatchObject({ allowed: true });
  });

  test("enforces command output cap", async () => {
    const config = testConfig({ allowedCommands: new Set(["printf"]), outputMaxBytes: 2 });
    const response = await execute(config, {
      root: ".",
      policy: { allowWrites: true },
      tool: "run-command",
      input: { argv: ["printf", "hello"] },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stdoutTruncated: true });
  });

  test("enforces command timeout", async () => {
    const config = testConfig({ allowedCommands: new Set(["sleep"]), commandTimeoutSeconds: 1 });
    const response = await execute(config, {
      root: ".",
      policy: { allowWrites: true },
      tool: "run-command",
      input: { argv: ["sleep", "2"] },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ timedOut: true, exitCode: 124 });
  });

  test("git status requires git allowlist", async () => {
    const root = tempDir();
    writeFileSync(join(root, "file.txt"), "hello", "utf8");
    const deniedConfig = testConfig({ workspaceRoot: root });
    const denied = await execute(deniedConfig, {
      root: ".",
      tool: "git-status",
      input: {},
    });
    expect(await denied.json()).toMatchObject({ exitCode: 1 });

    const allowedConfig = testConfig({ workspaceRoot: root, allowedCommands: new Set(["git"]) });
    await execute(allowedConfig, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: ["git"] },
      tool: "run-command",
      input: { argv: ["git", "init"] },
    });
    const allowed = await execute(allowedConfig, {
      root: ".",
      policy: { allowedCommands: ["git"] },
      tool: "git-status",
      input: {},
    });
    expect(allowed.status).toBe(200);
  });

  test("git diff requires git allowlist", async () => {
    const root = tempDir();
    const config = testConfig({ workspaceRoot: root });
    const denied = await execute(config, {
      root: ".",
      tool: "git-diff",
      input: {},
    });
    expect(await denied.json()).toMatchObject({ exitCode: 1 });
  });

  test("writes bounded audit JSONL metadata when configured", async () => {
    const root = tempDir();
    const auditDir = join(root, "audit");
    mkdirSync(auditDir);
    const withAudit = testConfig({
      workspaceRoot: root,
      auditDir,
      allowedCommands: new Set(["printf", "git"]),
      outputMaxBytes: 10,
    });

    await execute(withAudit, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: ["printf"] },
      tool: "run-command",
      input: { argv: ["printf", "hello"] },
    });
    let auditLine = readFileSync(join(auditDir, "crew-node-audit.jsonl"), "utf8").trim().split("\n").pop();
    expect(auditLine).toBeTruthy();
    expect(JSON.parse(auditLine!)).toMatchObject({
      status: "success",
      exitCode: 0,
      stdout: { bytes: 5, truncated: false },
      stderr: { bytes: 0, truncated: false },
    });

    await execute(withAudit, {
      root: ".",
      policy: { allowWrites: true },
      tool: "write-repo-file",
      input: { path: "a.txt", content: "hello" },
    });

    auditLine = readFileSync(join(auditDir, "crew-node-audit.jsonl"), "utf8").trim().split("\n").pop();
    expect(auditLine).toBeTruthy();
    expect(JSON.parse(auditLine!)).toMatchObject({
      status: "success",
      touchedPaths: ["a.txt"],
    });

    git(root, ["init"]);
    git(root, ["config", "user.name", "Tester"]);
    git(root, ["config", "user.email", "tester@example.test"]);
    writeFileSync(join(root, "long-diff.txt"), "alpha\nbeta\n", "utf8");
    git(root, ["add", "long-diff.txt"]);
    git(root, ["commit", "-m", "initial"]);
    writeFileSync(join(root, "long-diff.txt"), "alpha\nbeta\ngamma\ndelta\n", "utf8");

    await execute(withAudit, {
      root: ".",
      tool: "read-cumulative-diff",
      input: { baseRef: "HEAD" },
    });

    auditLine = readFileSync(join(auditDir, "crew-node-audit.jsonl"), "utf8").trim().split("\n").pop();
    expect(auditLine).toBeTruthy();
    const parsed = JSON.parse(auditLine!);
    expect(parsed).toMatchObject({
      status: "success",
      mutatingDiff: {
        bytes: expect.any(Number),
        truncated: true,
      },
    });
    expect(parsed.mutatingDiff.preview.length).toBeLessThanOrEqual(10);
  });

  test("workspace prepare, cumulative diff, safety findings, and finalize", async () => {
    const root = tempDir();
    git(root, ["init"]);
    git(root, ["config", "user.name", "Tester"]);
    git(root, ["config", "user.email", "tester@example.test"]);
    writeFileSync(join(root, "README.md"), "# project\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "initial"]);

    const config = testConfig({ workspaceRoot: root, allowedCommands: new Set(["git"]) });
    const prepare = await execute(config, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: ["git"] },
      tool: "prepare-workspace",
      input: { runId: "run-1" },
    });
    expect(prepare.status).toBe(200);
    const prepared = await prepare.json();
    expect(prepared.workspace.branch).toBe("crew/run-1");

    await execute(config, {
      root: ".",
      policy: { allowWrites: true },
      tool: "write-repo-file",
      input: { path: "Dockerfile", content: "FROM scratch\n" },
    });

    const cumulative = await execute(config, {
      root: ".",
      tool: "read-cumulative-diff",
      input: { baseRef: prepared.workspace.baseSha },
    });
    expect((await cumulative.json()).diff).toContain("+++ b/Dockerfile (untracked)");

    const safety = await execute(config, {
      root: ".",
      tool: "collect-safety-findings",
      input: { baseRef: prepared.workspace.baseSha, allowedChangeGlobs: ["src/**"] },
    });
    const safetyBody = await safety.json();
    expect(safetyBody.changedFiles).toContain("Dockerfile");
    expect(safetyBody.findings.map((finding: { kind: string }) => finding.kind)).toContain("high-risk-path");
    expect(safetyBody.findings.map((finding: { kind: string }) => finding.kind)).toContain("unrelated-change");

    const finalize = await execute(config, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: ["git"] },
      tool: "finalize-workspace",
      input: {
        workspace: prepared.workspace,
        outcome: "complete",
        goal: "ship node",
        runId: "run-1",
      },
    });
    expect(finalize.status).toBe(200);
    expect(await finalize.json()).toMatchObject({ committed: true });
  });

  test("workspace tools honor the request Git allowlist and reject unsafe restore branches", async () => {
    const root = tempDir();
    git(root, ["init"]);
    git(root, ["config", "user.name", "Tester"]);
    git(root, ["config", "user.email", "tester@example.test"]);
    writeFileSync(join(root, "README.md"), "# project\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "initial"]);
    const config = testConfig({ workspaceRoot: root, allowedCommands: new Set(["git"] ) });

    const denied = await execute(config, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: [] },
      tool: "prepare-workspace",
      input: { runId: "denied" },
    });
    expect(denied.status).toBe(403);

    const unsafe = await execute(config, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: ["git"] },
      tool: "finalize-workspace",
      input: {
        workspace: {
          root,
          branch: "crew/safe",
          baseSha: "a".repeat(40),
          baseBranch: "--upload-pack=malicious",
          createdAt: new Date().toISOString(),
        },
        outcome: "complete",
        goal: "reject unsafe metadata",
        runId: "safe",
      },
    });
    expect(unsafe.status).toBe(400);
  });

  test("denies git grep's pager-exec flag even under read-only", async () => {
    const config = testConfig({ allowedCommands: new Set(["git"]) });
    const response = await execute(config, {
      root: ".",
      policy: { allowedCommands: ["git"] },
      tool: "run-command",
      input: { argv: ["git", "grep", "--open-files-in-pager=/bin/sh", "pattern"] },
    });
    expect(await response.json()).toMatchObject({ allowed: false });
  });

  test("rejects writing inside .git/ as a sensitive path", async () => {
    const root = tempDir();
    const response = await execute(testConfig({ workspaceRoot: root }), {
      root: ".",
      policy: { allowWrites: true },
      tool: "write-repo-file",
      input: { path: ".git/config", content: "[core]\n\tfsmonitor = /tmp/evil\n" },
    });
    expect(response.status).toBe(403);
  });

  test("rejects an unsafe baseRef on git-diff, read-cumulative-diff, and collect-safety-findings", async () => {
    const root = tempDir();
    git(root, ["init"]);
    git(root, ["config", "user.name", "Tester"]);
    git(root, ["config", "user.email", "tester@example.test"]);
    writeFileSync(join(root, "README.md"), "# project\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "initial"]);
    const config = testConfig({ workspaceRoot: root, allowedCommands: new Set(["git"]) });

    const diff = await execute(config, { root: ".", policy: { allowedCommands: ["git"] }, tool: "git-diff", input: { baseRef: "--output=/tmp/evil" } });
    expect(diff.status).toBe(400);

    const cumulative = await execute(config, { root: ".", tool: "read-cumulative-diff", input: { baseRef: "--upload-pack=/bin/sh" } });
    expect(cumulative.status).toBe(400);

    const safety = await execute(config, { root: ".", tool: "collect-safety-findings", input: { baseRef: "--upload-pack=/bin/sh" } });
    expect(safety.status).toBe(400);
  });

  test("finalize-workspace publish requires explicit publish permission; run-command git push is always denied", async () => {
    const root = tempDir();
    git(root, ["init"]);
    git(root, ["config", "user.name", "Tester"]);
    git(root, ["config", "user.email", "tester@example.test"]);
    writeFileSync(join(root, "README.md"), "# project\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "initial"]);
    const config = testConfig({ workspaceRoot: root, allowedCommands: new Set(["git"]) });

    const prepare = await execute(config, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: ["git"] },
      tool: "prepare-workspace",
      input: { runId: "pub-1" },
    });
    const prepared = await prepare.json();
    await execute(config, { root: ".", policy: { allowWrites: true }, tool: "write-repo-file", input: { path: "a.txt", content: "x" } });

    const finalize = await execute(config, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: ["git"] },
      tool: "finalize-workspace",
      input: { workspace: prepared.workspace, outcome: "complete", goal: "publish test", runId: "pub-1", publishRemote: true },
    });
    expect(finalize.status).toBe(403);

    const push = await execute(config, {
      root: ".",
      policy: { allowWrites: true, allowedCommands: ["git"], allowPublish: true },
      tool: "run-command",
      input: { argv: ["git", "push", "origin", "HEAD:refs/heads/crew/pub-1"] },
    });
    expect(await push.json()).toMatchObject({ allowed: false });
  });
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}
