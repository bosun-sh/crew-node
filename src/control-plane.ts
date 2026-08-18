import { Config } from "./config.js";
import { discoverRepositories } from "./discovery.js";
import { toNodeError } from "./errors.js";
import { executeAuditedTool } from "./executor.js";
import { readJobResult, removeJobResult, StoredJobResult, writeJobResult } from "./job-store.js";
import { decodeBootstrap, decodeJob, NodeControlJob, retryDelay, RuntimeSession } from "./protocol.js";
import { executeTool } from "./tools.js";
import { which } from "./runtime.js";
import { readFileSync } from "node:fs";

const MAX_RESPONSE_BYTES = 1_000_000;
export const HEARTBEAT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

export type ControlPlaneHealth = { hasSession: boolean; authFailed: boolean; lastHeartbeatAt: number | undefined };

let health: ControlPlaneHealth = { hasSession: false, authFailed: false, lastHeartbeatAt: undefined };

export function getControlPlaneHealth(): ControlPlaneHealth {
  return { ...health };
}

function updateHealth(patch: Partial<ControlPlaneHealth>): void {
  health = { ...health, ...patch };
}

export type ControlPlane = { stop(): Promise<void> };
export type ControlPlaneDependencies = {
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  discover?: typeof discoverRepositories;
  execute?: typeof executeTool;
  onError?: (message: string) => void;
};

export function startControlPlane(config: Config, dependencies: ControlPlaneDependencies = {}): ControlPlane {
  const controller = new AbortController();
  const running = run(config, controller.signal, dependencies);
  return {
    async stop() {
      controller.abort();
      await running;
    },
  };
}

async function run(config: Config, signal: AbortSignal, dependencies: ControlPlaneDependencies): Promise<void> {
  const fetchFn = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const discover = dependencies.discover ?? discoverRepositories;
  const execute = dependencies.execute ?? executeTool;
  let runtime: RuntimeSession | undefined;
  let registeredSession = "";
  let heartbeatAt = 0;
  let failures = 0;

  while (!signal.aborted) {
    try {
      if (!runtime || now() >= runtime.expiresAt - 30_000) {
        runtime = await bootstrap(config, fetchFn, signal);
        registeredSession = "";
      }
      const headers = authHeaders(runtime.session);
      const repositories = now() >= heartbeatAt || !registeredSession ? discover(config.workspaceRoot) : undefined;
      if (!registeredSession) {
        await requestJson(fetchFn, `${runtime.runnerUrl}/v1/node/register`, { method: "POST", headers, body: JSON.stringify({ capabilities: capabilities(config), repositories }) }, signal);
        registeredSession = runtime.session;
        updateHealth({ hasSession: true, authFailed: false });
      }
      if (repositories) {
        const body = JSON.stringify({ capabilities: capabilities(config), repositories });
        await requestJson(fetchFn, `${runtime.runnerUrl}/v1/node/heartbeat`, { method: "POST", headers, body }, signal);
        await requestJson(fetchFn, `${runtime.dashboardUrl}/api/node/heartbeat`, { method: "POST", headers, body }, signal);
        heartbeatAt = now() + HEARTBEAT_MS;
        updateHealth({ lastHeartbeatAt: now() });
      }
      const envelope = await requestJson(fetchFn, `${runtime.runnerUrl}/v1/node/jobs/next`, { headers }, signal);
      let job: NodeControlJob | undefined;
      try {
        job = decodeJob(envelope);
      } catch (error) {
        // The envelope itself arrived fine, so this is a permanent, job-shaped problem, not a
        // connectivity failure: retrying the whole cycle would just re-fetch and re-decode the
        // same malformed job forever. Report it failed (best effort) and move on instead.
        const jobId = extractJobId(envelope);
        if (jobId) {
          await requestJson(fetchFn, `${runtime.runnerUrl}/v1/node/jobs/${encodeURIComponent(jobId)}/result`, {
            method: "POST", headers, body: JSON.stringify({ error: toNodeError(error).message }),
          }, signal).catch(() => undefined);
        }
        dependencies.onError?.(`Crew Node received a malformed job envelope${jobId ? ` (${jobId})` : ""}: ${toNodeError(error).message}`);
        failures = 0;
        await delay(0, signal);
        continue;
      }
      if (job) {
        let stored = readJobResult(config.stateDir, job.id);
        if (!stored) {
          stored = await executeJob(config, job, execute);
          try {
            writeJobResult(config.stateDir, job.id, stored);
          } catch (error) {
            // Deterministic given this job's input (e.g. the result exceeds the durable size
            // limit): retrying without a persisted record would re-execute the tool identically
            // forever. Report the failure once instead of leaving the job to be redelivered.
            stored = { error: `Could not persist job result: ${toNodeError(error).message}` };
          }
        }
        await requestJson(fetchFn, `${runtime.runnerUrl}/v1/node/jobs/${encodeURIComponent(job.id)}/result`, {
          method: "POST", headers, body: JSON.stringify(stored),
        }, signal);
        removeJobResult(config.stateDir, job.id);
      }
      failures = 0;
      await delay(job ? 0 : 1_000, signal);
    } catch (error) {
      if (signal.aborted) break;
      if (isHttpError(error) && (error.status === 401 || error.status === 403)) {
        runtime = undefined;
        updateHealth({ hasSession: false, authFailed: true });
      }
      dependencies.onError?.(safeError(error));
      await delay(retryDelay(failures++, random()), signal);
    }
  }
}

function extractJobId(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const job = (envelope as Record<string, unknown>).job;
  if (!job || typeof job !== "object") return undefined;
  const id = (job as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 && id.length <= 128 ? id : undefined;
}

async function bootstrap(config: Config, fetchFn: typeof fetch, signal: AbortSignal): Promise<RuntimeSession> {
  const value = await requestJson(fetchFn, `${config.dashboardUrl}/api/node/bootstrap`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}` },
  }, signal);
  return decodeBootstrap(value);
}

async function executeJob(config: Config, job: NodeControlJob, execute: typeof executeTool): Promise<StoredJobResult> {
  try {
    return { result: await executeAuditedTool(config, job, execute) };
  } catch (error) {
    return { error: toNodeError(error).message };
  }
}

async function requestJson(fetchFn: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const response = await fetchFn(url, { ...init, redirect: "error", signal: requestSignal });
  if (!response.ok) throw httpError(response.status);
  const declared = response.headers.get("content-length");
  if (declared && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new Error("control-plane response exceeded size limit");
  }
  const bytes = await readBoundedResponse(response);
  return bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {};
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("control-plane response exceeded size limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function capabilities(config: Config): Record<string, unknown> {
  const allowedCommands = [...config.allowedCommands].sort();
  return {
    workspaceRoot: config.workspaceRoot,
    allowedCommands,
    availableCommands: allowedCommands.filter((command) => Boolean(which(command))),
    version: packageVersion(),
  };
}

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "dev";
  }
}

function authHeaders(session: string): Record<string, string> {
  return { authorization: `Bearer ${session}`, "content-type": "application/json" };
}

function safeError(error: unknown): string {
  return isHttpError(error) ? `Crew Node control-plane request failed (${error.status})` : "Crew Node control-plane request failed";
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  });
}

type HttpError = Error & { status: number };

function httpError(status: number): HttpError {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function isHttpError(error: unknown): error is HttpError {
  return error instanceof Error && typeof (error as Partial<HttpError>).status === "number";
}
