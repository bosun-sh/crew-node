import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { tempDir } from "./helpers.js";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  test("loads required configuration and defaults", () => {
    const root = tempDir();
    const dashboard = "https://dashboard.example.com";
    const key = `crew_node_key_v2.${Buffer.from(dashboard).toString("base64url")}.${Buffer.alloc(32, 1).toString("base64url")}`;
    const config = loadConfig({
      CREW_NODE_API_KEY: key,
      CREW_WORKSPACE_ROOT: root,
    });

    expect(config.apiKey).toBe(key);
    expect(config.dashboardUrl).toBe(dashboard);
    expect(config.workspaceRoot).toBe(root);
    expect(config.port).toBe(4321);
    expect(config.commandTimeoutSeconds).toBe(30);
    expect(config.outputMaxBytes).toBe(65_536);
    expect([...config.allowedCommands]).toContain("git");
  });

  test("creates private state and audit directories for standard setup", () => {
    const root = tempDir();
    const dashboard = "http://127.0.0.1:3000";
    const key = `crew_node_key_v2.${Buffer.from(dashboard).toString("base64url")}.${Buffer.alloc(32, 1).toString("base64url")}`;
    const config = loadConfig({
      CREW_NODE_API_KEY: key,
      CREW_WORKSPACE_ROOT: root,
    });

    expect(config.apiKey).toBe(key);
    expect(config.workspaceRoot).toBe(root);
    expect(config.auditDir).toBe(`${homedir()}/.crew-node/audit`);
    expect(config.stateDir).toBe(`${homedir()}/.crew-node/audit/state`);
    expect([...config.allowedCommands]).toContain("npm");
  });

  test("v2 install key discovers Dashboard without a Runner URL", () => {
    const dashboard = "https://dashboard.example.com";
    const key = `crew_node_key_v2.${Buffer.from(dashboard).toString("base64url")}.${Buffer.alloc(32, 1).toString("base64url")}`;
    const config = loadConfig({ CREW_NODE_API_KEY: key, CREW_WORKSPACE_ROOT: tempDir() });
    expect(config.dashboardUrl).toBe(dashboard);
  });

  test("requires a v2 api key", () => {
    expect(() => loadConfig({ CREW_WORKSPACE_ROOT: tempDir() })).toThrow("CREW_NODE_API_KEY is required");
    expect(() =>
      loadConfig({
        CREW_NODE_API_KEY: "legacy-token",
        CREW_WORKSPACE_ROOT: tempDir(),
      }),
    ).toThrow("v2 install key");
  });

  test("creates audit directory when configured", () => {
    const root = tempDir();
    const auditDir = `${root}/audit`;
    const config = loadConfig({
      CREW_NODE_API_KEY: `crew_node_key_v2.${Buffer.from("http://127.0.0.1:3000").toString("base64url")}.${Buffer.alloc(32, 1).toString("base64url")}`,
      CREW_WORKSPACE_ROOT: root,
      CREW_AUDIT_DIR: auditDir,
    });

    expect(config.auditDir).toBe(auditDir);
  });

  test("uses an explicit state directory exactly and rejects unsafe limits", () => {
    const root = tempDir();
    const key = `crew_node_key_v2.${Buffer.from("http://127.0.0.1:3000").toString("base64url")}.${Buffer.alloc(32, 1).toString("base64url")}`;
    const stateDir = `${root}/durable-results`;
    expect(loadConfig({ CREW_NODE_API_KEY: key, CREW_WORKSPACE_ROOT: root, CREW_STATE_DIR: stateDir }).stateDir).toBe(stateDir);
    expect(() => loadConfig({ CREW_NODE_API_KEY: key, CREW_WORKSPACE_ROOT: root, CREW_PORT: "65536" })).toThrow("between 1 and 65535");
    expect(() => loadConfig({ CREW_NODE_API_KEY: key, CREW_WORKSPACE_ROOT: root, CREW_ALLOWED_COMMANDS: "git,/bin/sh" })).toThrow("binary names");
  });

  test("rejects malformed key material and credential-bearing URLs", () => {
    const encoded = Buffer.from("https://user:secret@dashboard.example.com").toString("base64url");
    expect(() => loadConfig({ CREW_NODE_API_KEY: `crew_node_key_v2.${encoded}.${Buffer.alloc(32).toString("base64url")}`, CREW_WORKSPACE_ROOT: tempDir() })).toThrow("must not contain credentials");
    expect(() => loadConfig({ CREW_NODE_API_KEY: `crew_node_key_v2.${encoded}.short`, CREW_WORKSPACE_ROOT: tempDir() })).toThrow("malformed");
  });

  test("defaults CREW_ALLOW_WRITES to true and parses explicit values", () => {
    const key = `crew_node_key_v2.${Buffer.from("http://127.0.0.1:3000").toString("base64url")}.${Buffer.alloc(32, 1).toString("base64url")}`;
    const root = tempDir();
    expect(loadConfig({ CREW_NODE_API_KEY: key, CREW_WORKSPACE_ROOT: root }).allowWrites).toBe(true);
    expect(loadConfig({ CREW_NODE_API_KEY: key, CREW_WORKSPACE_ROOT: root, CREW_ALLOW_WRITES: "false" }).allowWrites).toBe(false);
    expect(loadConfig({ CREW_NODE_API_KEY: key, CREW_WORKSPACE_ROOT: root, CREW_ALLOW_WRITES: "true" }).allowWrites).toBe(true);
    expect(() => loadConfig({ CREW_NODE_API_KEY: key, CREW_WORKSPACE_ROOT: root, CREW_ALLOW_WRITES: "nope" })).toThrow('must be "true" or "false"');
  });
});
