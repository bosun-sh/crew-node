import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { decodeBootstrap, decodeJob, retryDelay } from "../src/protocol.js";
import { NODE_TOOL_IDS } from "../src/types.js";
import contract from "../contracts/node-control.json" with { type: "json" };
import { readJobResult, removeJobResult, writeJobResult } from "../src/job-store.js";
import { tempDir } from "./helpers.js";

describe("outbound protocol", () => {
  test("accepts secure control-plane URLs and rejects insecure remote URLs", () => {
    expect(decodeBootstrap({
      dashboardUrl: "https://dashboard.example.com",
      runnerUrl: "https://runner.example.com",
      session: "session",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }).runnerUrl).toBe("https://runner.example.com");
    expect(() => decodeBootstrap({
      dashboardUrl: "http://dashboard.example.com",
      runnerUrl: "https://runner.example.com",
      session: "session",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toThrow("require HTTPS");
  });

  test("accepts only the hosted Runner tool vocabulary", () => {
    expect(decodeJob({ job: { id: "1", root: ".", tool: "read-repo-file", input: { path: "README.md" } } })?.tool).toBe("read-repo-file");
    expect(() => decodeJob({ job: { id: "1", root: ".", tool: "read", input: {} } })).toThrow("job tool is invalid");
  });

  test("keeps the published tool contract and runtime vocabulary identical", () => {
    expect(contract.version).toBe(2);
    expect(contract.tools).toEqual([...NODE_TOOL_IDS]);
  });

  test("validates policy fields at the network boundary", () => {
    expect(() => decodeJob({ job: { id: "job-1", tool: "git-status", input: {}, root: ".", policy: { allowWrites: "yes" } } })).toThrow("allowWrites is invalid");
    expect(() => decodeJob({ job: { id: "job-1", tool: "git-status", input: {}, root: ".", policy: { commandTimeoutMs: 0 } } })).toThrow("commandTimeoutMs is invalid");
  });

  test("rejects unrecognized policy fields instead of silently ignoring them", () => {
    expect(() => decodeJob({ job: { id: "job-1", tool: "git-status", input: {}, root: ".", policy: { maxTokens: 1_000 } } })).toThrow("unsupported field");
  });

  test("caps job ids so an encoded filename can never outgrow a safe length", () => {
    expect(decodeJob({ job: { id: "a".repeat(128), root: ".", tool: "git-status", input: {} } })?.id).toHaveLength(128);
    expect(() => decodeJob({ job: { id: "a".repeat(129), root: ".", tool: "git-status", input: {} } })).toThrow("job id is invalid");
  });

  test("bounds exponential retry jitter", () => {
    expect(retryDelay(0, 0)).toBe(400);
    expect(retryDelay(20, 1)).toBe(36_000);
  });
});

describe("durable job results", () => {
  test("round trips atomically with private permissions", () => {
    const state = tempDir();
    chmodSync(state, 0o700);
    writeJobResult(state, "org/job", { result: { ok: true } });
    expect(readJobResult(state, "org/job")).toEqual({ result: { ok: true } });
    const file = `${state}/${Buffer.from("org/job").toString("base64url")}.json`;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    removeJobResult(state, "org/job");
    expect(readJobResult(state, "org/job")).toBeUndefined();
  });

  test("quarantines a corrupt result file instead of crashing the control loop", () => {
    const state = tempDir();
    const path = `${state}/${Buffer.from("bad-job").toString("base64url")}.json`;
    writeFileSync(path, "not valid json", "utf8");
    expect(readJobResult(state, "bad-job")).toBeUndefined();
    expect(statSync(`${path}.corrupt`).isFile()).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
