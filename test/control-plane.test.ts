import { expect, test } from "bun:test";
import { startControlPlane } from "../src/control-plane.js";
import { readJobResult } from "../src/job-store.js";
import { testConfig } from "./helpers.js";

test("control plane retries a durable result without executing a redelivered job twice", async () => {
  const config = testConfig();
  let executions = 0;
  let deliveries = 0;
  let control: ReturnType<typeof startControlPlane>;
  let delivered!: () => void;
  const completed = new Promise<void>((resolve) => { delivered = resolve; });
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/api/node/bootstrap")) return response({
      dashboardUrl: "http://127.0.0.1:3000",
      runnerUrl: "http://127.0.0.1:3777",
      session: "session",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    if (url.endsWith("/v1/node/jobs/next")) return response({ job: {
      id: "job-1", root: ".", tool: "list-repo-files", input: {},
    } });
    if (url.endsWith("/result")) {
      deliveries += 1;
      if (deliveries === 1) return response({}, 500);
      delivered();
      queueMicrotask(() => void control.stop());
      return response({ ok: true });
    }
    return response({ ok: true });
  };

  control = startControlPlane(config, {
    fetch: fetchFn as typeof fetch,
    discover: () => [],
    execute: async () => { executions += 1; return { done: true }; },
    random: () => 0,
  });
  await completed;
  await control.stop();

  expect(deliveries).toBe(2);
  expect(executions).toBe(1);
  expect(readJobResult(config.stateDir, "job-1")).toBeUndefined();
});

test("control plane rejects oversized chunked responses before JSON parsing", async () => {
  let control: ReturnType<typeof startControlPlane>;
  let message = "";
  let failed!: () => void;
  const failure = new Promise<void>((resolve) => { failed = resolve; });
  control = startControlPlane(testConfig(), {
    fetch: (async () => new Response(new Uint8Array(1_000_001))) as unknown as typeof fetch,
    onError: (value: string) => { message = value; failed(); },
    random: () => 0,
  });
  await failure;
  await control.stop();
  expect(message).toBe("Crew Node control-plane request failed");
});

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
