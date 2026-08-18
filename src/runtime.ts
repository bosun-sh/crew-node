import { createServer } from "node:http";
import { accessSync, constants } from "node:fs";
import { delimiter, sep } from "node:path";

export interface StartedServer {
  port: number;
  stop: () => Promise<void>;
}

export function serveHttp(port: number, host: string, handler: (request: Request) => Promise<Response>): StartedServer {
  const server = createServer(async (incoming, outgoing) => {
    const origin = `http://${incoming.headers.host ?? `127.0.0.1:${port}`}`;
    const url = new URL(incoming.url ?? "/", origin);
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else if (value !== undefined) {
        headers.set(key, value);
      }
    }

    const request = new Request(url, {
      method: incoming.method,
      headers,
      body: incoming.method === "GET" || incoming.method === "HEAD" ? undefined : incoming,
      duplex: "half",
    } as unknown as RequestInit);

    try {
      const response = await handler(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          outgoing.write(value);
        }
      }
      outgoing.end();
    } catch (error) {
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ ok: false, error: { code: "internal_error", message: String(error) } }));
    }
  });

  server.listen(port, host);
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    stop: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export function which(command: string): string | null {
  if (command.includes(sep)) {
    return canExecute(command) ? command : null;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const path = `${dir}${sep}${command}`;
    if (canExecute(path)) return path;
  }
  return null;
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function globMatches(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char ?? "");
    }
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
