import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

type RpcId = string | number;

class TestClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, (message: Record<string, unknown>) => void>();
  #buffer = "";

  constructor() {
    const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
    this.child = spawn(process.execPath, [entry], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        const id = message.id;
        if (typeof id !== "string" && typeof id !== "number") continue;
        const key = `${typeof id}:${String(id)}`;
        this.#pending.get(key)?.(message);
        this.#pending.delete(key);
      }
    });
  }

  request(id: RpcId, method: string, params: unknown): Promise<Record<string, unknown>> {
    const key = `${typeof id}:${String(id)}`;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 3_000);
      this.#pending.set(key, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill();
        reject(new Error("MCP server did not exit after stdin EOF"));
      }, 3_000);
      this.child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}

test("MCP repeated initialize accepts clientInfo metadata refresh for the same client name", async () => {
  const client = new TestClient();
  try {
    const first = await client.request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: { roots: { listChanged: true } },
      clientInfo: {
        name: "chatgpt-host",
        title: "ChatGPT Host",
        version: "1",
      },
    });
    assert.equal(first.error, undefined);

    const refreshed = await client.request(2, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: { roots: { listChanged: true } },
      clientInfo: {
        name: "chatgpt-host",
        title: "ChatGPT Host (refreshed)",
        version: "2",
        build: "new-metadata-is-descriptive",
      },
    });
    assert.equal(refreshed.error, undefined);
    assert.deepEqual(refreshed.result, first.result);

    const differentClient = await client.request(3, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: { roots: { listChanged: true } },
      clientInfo: {
        name: "different-host",
        version: "2",
      },
    });
    const error = differentClient.error as Record<string, unknown>;
    assert.equal(error.code, -32602);
    assert.match(error.message as string, /clientInfo differs/);
  } finally {
    assert.equal(await client.close(), 0);
  }
});
