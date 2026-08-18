import { describe, expect, test } from "bun:test";
import { effectivePolicy, checkCommandAllowed, checkPublishAllowed } from "../src/policy.js";
import { testConfig } from "./helpers.js";

describe("host policy ceiling", () => {
  test("Cloud limits can only narrow Node limits", () => {
    const config = testConfig({
      commandTimeoutSeconds: 30,
      outputMaxBytes: 1_024,
      allowedCommands: new Set(["git"]),
    });
    const policy = effectivePolicy(config, {
      allowedCommands: ["git"],
      commandTimeoutMs: 120_000,
      maxOutputBytes: 80_000,
    });
    expect(policy.timeoutMs).toBe(30_000);
    expect(policy.outputMaxBytes).toBe(1_024);
    expect(() => effectivePolicy(config, { allowedCommands: ["node"] })).toThrow("not allowed by node policy");
  });

  test("read-only jobs cannot invoke general executables or mutating Git", () => {
    const policy = effectivePolicy(testConfig({ allowedCommands: new Set(["git", "node", "cat"]) }), {
      allowedCommands: ["git", "node", "cat"],
      allowWrites: false,
    });
    expect(checkCommandAllowed(policy, ["cat", "README.md"]).allowed).toBe(true);
    expect(checkCommandAllowed(policy, ["git", "status", "--short"]).allowed).toBe(true);
    expect(checkCommandAllowed(policy, ["git", "checkout", "main"]).allowed).toBe(false);
    expect(checkCommandAllowed(policy, ["node", "script.js"]).allowed).toBe(false);
  });

  test("screens Git arguments after the subcommand against an allowlist of option names", () => {
    const policy = effectivePolicy(testConfig({ allowedCommands: new Set(["git"]) }), {
      allowedCommands: ["git"],
      allowWrites: true,
    });
    expect(checkCommandAllowed(policy, ["git", "grep", "--open-files-in-pager=/bin/sh", "pattern"]).allowed).toBe(false);
    expect(checkCommandAllowed(policy, ["git", "grep", "-O", "pattern"]).allowed).toBe(false);
    expect(checkCommandAllowed(policy, ["git", "diff", "--output=/tmp/evil"]).allowed).toBe(false);
    expect(checkCommandAllowed(policy, ["git", "status", "--porcelain"]).allowed).toBe(true);
    expect(checkCommandAllowed(policy, ["git", "diff", "--name-only", "--no-ext-diff", "--", "."]).allowed).toBe(true);
  });

  test("push is never reachable through the general allowlist", () => {
    const policy = effectivePolicy(testConfig({ allowedCommands: new Set(["git"]) }), {
      allowedCommands: ["git"],
      allowWrites: true,
      allowPublish: true,
    });
    expect(checkCommandAllowed(policy, ["git", "push", "origin", "HEAD:refs/heads/crew/x"]).allowed).toBe(false);
  });

  test("publishing requires both write and explicit publish permission", () => {
    const base = testConfig({ allowedCommands: new Set(["git"]) });
    expect(checkPublishAllowed(effectivePolicy(base, { allowedCommands: ["git"] })).allowed).toBe(false);
    expect(checkPublishAllowed(effectivePolicy(base, { allowedCommands: ["git"], allowWrites: true })).allowed).toBe(false);
    expect(checkPublishAllowed(effectivePolicy(base, { allowedCommands: ["git"], allowWrites: true, allowPublish: true })).allowed).toBe(true);
  });

  test("a host with writes disabled ignores a request policy asking for write access", () => {
    const config = testConfig({ allowedCommands: new Set(["git"]), allowWrites: false });
    const policy = effectivePolicy(config, { allowedCommands: ["git"], allowWrites: true });
    expect(policy.allowWrites).toBe(false);
    expect(checkCommandAllowed(policy, ["git", "checkout", "main"]).allowed).toBe(false);
  });

  test("a host with writes enabled still requires the request to opt in", () => {
    const config = testConfig({ allowedCommands: new Set(["git"]), allowWrites: true });
    const policy = effectivePolicy(config, { allowedCommands: ["git"] });
    expect(policy.allowWrites).toBe(false);
  });
});
