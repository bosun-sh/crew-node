import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Config, loadConfig } from "./config.js";
import { ControlPlaneHealth, getControlPlaneHealth, HEARTBEAT_MS, startControlPlane } from "./control-plane.js";
import { serveHttp, StartedServer, which } from "./runtime.js";

export type NodeService = { stop(): Promise<void> };

export function createHandler(config: Config, health?: () => ControlPlaneHealth): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/healthz") return json({ ok: true, service: "crew-node" });
    if (request.method === "GET" && path === "/readyz") {
      const report = readiness(config, health);
      return json(report, report.ok ? 200 : 503);
    }
    return json({ ok: false, error: { code: "not_found", message: "Not found" } }, 404);
  };
}

export function startServer(): NodeService {
  const config = loadConfig();
  const controlPlane = startControlPlane(config, { onError: (message) => console.error(message) });
  const server = serveHttp(config.port, "127.0.0.1", createHandler(config, getControlPlaneHealth));
  console.log(`Crew Node health listening on http://127.0.0.1:${server.port}`);
  console.log(`Crew Node connecting outbound to ${config.dashboardUrl}`);
  return service(server, controlPlane);
}

function service(server: StartedServer, controlPlane: NodeService): NodeService {
  let stopped = false;
  const result = {
    async stop() {
      if (stopped) return;
      stopped = true;
      await Promise.all([controlPlane.stop(), server.stop()]);
    },
  };
  process.once("SIGTERM", () => void result.stop());
  process.once("SIGINT", () => void result.stop());
  return result;
}

export function readiness(config: Config, health?: () => ControlPlaneHealth) {
  const workspaceRoot = checkDirectory(config.workspaceRoot);
  const auditDir = checkWritable(config.auditDir);
  const stateDir = checkWritable(config.stateDir);
  const available: string[] = [];
  const missing: string[] = [];
  for (const command of [...config.allowedCommands].sort()) (which(command) ? available : missing).push(command);
  const git = which("git");
  const controlPlane = health ? checkControlPlane(health()) : undefined;
  return {
    ok: workspaceRoot.ok && auditDir.ok && stateDir.ok && Boolean(git) && missing.length === 0 && (controlPlane?.ok ?? true),
    checks: {
      workspaceRoot,
      git: { ok: Boolean(git), command: "git", path: git },
      allowedCommands: { ok: missing.length === 0, available, missing },
      auditDir,
      stateDir,
      ...(controlPlane ? { controlPlane } : {}),
    },
  };
}

function checkControlPlane(health: ControlPlaneHealth) {
  const stale = health.lastHeartbeatAt === undefined || Date.now() - health.lastHeartbeatAt > HEARTBEAT_MS;
  return {
    ok: health.hasSession && !health.authFailed && !stale,
    hasSession: health.hasSession,
    authFailed: health.authFailed,
    lastHeartbeatAt: health.lastHeartbeatAt ?? null,
  };
}

function checkDirectory(path: string) {
  try {
    const directory = statSync(path).isDirectory();
    return { ok: directory, path, exists: true, directory };
  } catch (error) {
    return { ok: false, path, exists: existsSync(path), directory: false, error: error instanceof Error ? error.message : "unavailable" };
  }
}

function checkWritable(path: string) {
  const probe = join(path, `.crew-ready-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, "ready", { encoding: "utf8", mode: 0o600, flag: "wx" });
    unlinkSync(probe);
    return { ok: true, path, writable: true };
  } catch (error) {
    try { unlinkSync(probe); } catch {}
    return { ok: false, path, writable: false, error: error instanceof Error ? error.message : "not writable" };
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
