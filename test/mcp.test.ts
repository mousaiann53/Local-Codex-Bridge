import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { CHECKPOINT_DIRECTORY_ENV } from "../src/checkpoint.js";
import { ALLOWED_ROOTS_ENV } from "../src/workspace-roots.js";

type RpcId = string | number;

class TestClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: Array<Record<string, unknown>> = [];
  readonly #pending = new Map<string, (message: Record<string, unknown>) => void>();
  #buffer = "";

  constructor(environment: NodeJS.ProcessEnv = process.env, cwd?: string) {
    const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
    this.child = spawn(process.execPath, [entry], {
      ...(cwd ? { cwd } : {}),
      env: environment,
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
        this.messages.push(message);
        const id = message.id;
        if (typeof id === "string" || typeof id === "number") {
          this.#pending.get(`${typeof id}:${String(id)}`)?.(message);
          this.#pending.delete(`${typeof id}:${String(id)}`);
        }
      }
    });
  }

  request(id: RpcId, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
    const response = this.expect(id, method);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  expect(id: RpcId, label = "response"): Promise<Record<string, unknown>> {
    const key = `${typeof id}:${String(id)}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 3_000);
      this.#pending.set(key, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  writeRaw(value: string): void {
    this.child.stdin.write(value);
  }

  responseCount(id: RpcId): number {
    return this.messages.filter((message) => message.id === id && typeof message.id === typeof id).length;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toolPayload(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result as Record<string, unknown>;
  const content = result.content as Array<Record<string, unknown>>;
  assert.equal(content.length, 1);
  assert.equal(content[0]?.type, "text");
  assert.equal(typeof content[0]?.text, "string");
  return JSON.parse(content[0]?.text as string) as Record<string, unknown>;
}

async function initialize(client: TestClient, id: RpcId): Promise<void> {
  const response = await client.request(id, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(response.error, undefined);
}

test("MCP stdio initializes idempotently and lists exactly seven fully annotated tools", async () => {
  const client = new TestClient();
  try {
    const initializeLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {
          roots: { listChanged: true },
          sampling: {},
        },
        clientInfo: { name: "test", version: "1" },
      },
    });
    const initializeResponse = client.expect(1, "fragmented initialize");
    client.writeRaw(initializeLine.slice(0, 35));
    client.writeRaw(`${initializeLine.slice(35)}\n`);
    const initialized = await initializeResponse;
    assert.equal(
      (initialized.result as Record<string, unknown>).protocolVersion,
      "2025-03-26",
    );
    assert.deepEqual(
      (initialized.result as Record<string, unknown>).serverInfo,
      {
        name: "local-codex-bridge",
        title: "Local Codex Bridge",
        version: "2.1.1",
      },
    );

    // A second initialize reuses the first negotiated result with its own response id.
    const repeated = await client.request(0, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
      },
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(initialized.id, 1);
    assert.equal(repeated.id, 0);
    assert.equal(initialized.error, undefined);
    assert.equal(repeated.error, undefined);
    assert.deepEqual(repeated.result, initialized.result);

    const reordered = await client.request(2, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {
        sampling: {},
        roots: { listChanged: true },
      },
      clientInfo: { version: "1", name: "test" },
    });
    assert.equal(reordered.error, undefined);
    assert.deepEqual(reordered.result, initialized.result);

    client.writeRaw(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const pingPromise = client.expect(3, "batched ping");
    const listPromise = client.expect(4, "batched tools/list");
    client.writeRaw(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: {} })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })}\n`,
    );
    const [ping, listed] = await Promise.all([pingPromise, listPromise]);
    assert.deepEqual(ping.result, {});
    const tools = (listed.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    assert.deepEqual(tools.map((tool) => tool.name), [
      "codex_threads",
      "codex_turn",
      "codex_observe",
      "codex_steer",
      "codex_respond",
      "codex_interrupt",
      "codex_checkpoint",
    ]);
    for (const tool of tools) {
      assert.equal(typeof tool.title, "string");
      assert.equal(typeof tool.description, "string");
      assert.equal((tool.inputSchema as Record<string, unknown>).type, "object");
      const annotations = tool.annotations as Record<string, unknown>;
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        assert.equal(typeof annotations[hint], "boolean", `${String(tool.name)} ${hint}`);
      }
    }
    const respondTool = tools.find((tool) => tool.name === "codex_respond");
    assert.equal(
      (respondTool?.annotations as Record<string, unknown>).idempotentHint,
      false,
    );
    assert.doesNotMatch(respondTool?.description as string, /permissions|elicitation|future request/i);
    const respondProperties = (respondTool?.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
    assert.match(respondProperties.response?.description as string, /known item\/tool\/requestUserInput method/);
    const checkpointTool = tools.find((tool) => tool.name === "codex_checkpoint");
    assert.match(
      checkpointTool?.description as string,
      /Initialization is not tied to crossing a ChatGPT window or round/,
    );
    assert.match(checkpointTool?.description as string, /Do not use for one-shot work/);
    assert.match(
      checkpointTool?.description as string,
      /Before final acceptance of a checkpointed task, read it once/,
    );
  } finally {
    assert.equal(await client.close(), 0);
  }
});

test("MCP rejects a duplicate active typed id without disturbing cancellation, cleanup, or reuse", async () => {
  const fakeDirectory = mkdtempSync(join(tmpdir(), "local-codex-bridge-mcp-duplicate-"));
  const fakeCodex = fileURLToPath(new URL("../../test/fake-codex.mjs", import.meta.url));
  writeFileSync(
    join(fakeDirectory, "app-server"),
    `process.argv.splice(2, 0, "app-server");\nvoid import(${JSON.stringify(pathToFileURL(fakeCodex).href)});\n`,
    "utf8",
  );
  const client = new TestClient({
    ...process.env,
    CODEX_EXE: process.execPath,
    [ALLOWED_ROOTS_ENV]: fakeDirectory,
  }, fakeDirectory);
  try {
    await initialize(client, 1);
    const started = toolPayload(await client.request(2, "tools/call", {
      name: "codex_turn",
      arguments: {
        text: "test: hold bounded observe",
        cwd: fakeDirectory,
        sandbox: "read-only",
        approval_policy: "never",
      },
    }));
    assert.equal(started.accepted, true);

    client.writeRaw(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: {
        name: "codex_observe",
        arguments: {
          thread_id: started.thread_id,
          cursor: started.event_cursor,
          wait_ms: 1_000,
        },
      },
    })}\n`);
    await delay(25);
    assert.equal(client.responseCount(17), 0, "the original bounded observe must still be active");

    const duplicate = client.expect(17, "duplicate numeric id rejection");
    client.writeRaw(`${JSON.stringify({ jsonrpc: "2.0", id: 17, method: "ping", params: {} })}\n`);
    const duplicateResponse = await duplicate;
    assert.deepEqual(duplicateResponse.error, {
      code: -32600,
      message: "Duplicate request id is already active",
    });

    const distinctString = client.expect("17", "distinct string id response");
    client.writeRaw(`${JSON.stringify({ jsonrpc: "2.0", id: "17", method: "ping", params: {} })}\n`);
    const stringResponse = await distinctString;
    assert.deepEqual(stringResponse.result, {});

    client.writeRaw(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 17, reason: "deterministic duplicate lifecycle test" },
    })}\n`);
    await delay(1_100);
    assert.equal(
      client.responseCount(17),
      1,
      "the cancelled first request response must remain suppressed",
    );
    assert.equal(client.responseCount("17"), 1, "numeric and string ids must remain distinct");

    const reused = await client.request(17, "ping");
    assert.deepEqual(reused.result, {});
    await delay(25);
    assert.equal(
      client.responseCount(17),
      2,
      "finally cleanup must allow safe reuse of the same typed id",
    );
  } finally {
    assert.equal(await client.close(), 0);
    rmSync(fakeDirectory, { recursive: true, force: true });
  }
});

test("MCP rejects materially different repeated initialize identities", async () => {
  const client = new TestClient();
  try {
    const first = await client.request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(first.error, undefined);

    const mismatches: Array<[string, Record<string, unknown>]> = [
      ["protocolVersion", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }],
      ["capabilities", {
        protocolVersion: "2025-03-26",
        capabilities: { sampling: {} },
        clientInfo: { name: "test", version: "1" },
      }],
      ["clientInfo", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "other", version: "1" },
      }],
    ];
    for (const [field, params] of mismatches) {
      const response = await client.request(field, "initialize", params);
      const error = response.error as Record<string, unknown>;
      assert.equal(error.code, -32602);
      assert.match(error.message as string, new RegExp(field));
    }
  } finally {
    assert.equal(await client.close(), 0);
  }
});

test("MCP rejects codex_turn before app-server launch when allowed roots are unset", async () => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_EXE: "Z:\\definitely-missing\\codex.exe",
  };
  delete environment[ALLOWED_ROOTS_ENV];
  const client = new TestClient(environment);
  try {
    await initialize(client, 1);
    const response = await client.request(2, "tools/call", {
      name: "codex_turn",
      arguments: {
        text: "must remain blocked",
        cwd: process.cwd(),
      },
    });
    const result = response.result as Record<string, unknown>;
    assert.equal(result.isError, true);
    const content = result.content as Array<Record<string, unknown>>;
    assert.match(content[0]?.text as string, new RegExp(ALLOWED_ROOTS_ENV));
    assert.doesNotMatch(content[0]?.text as string, /Failed to spawn/);
  } finally {
    assert.equal(await client.close(), 0);
  }
});

test("checkpoint preserves immutable intent and bounded state across MCP process restart", async () => {
  const checkpointDirectory = mkdtempSync(join(tmpdir(), "local-codex-bridge-checkpoint-test-"));
  const environment = {
    ...process.env,
    [CHECKPOINT_DIRECTORY_ENV]: checkpointDirectory,
  };
  const threadId = randomUUID();
  let first: TestClient | undefined;
  let second: TestClient | undefined;

  try {
    first = new TestClient(environment);
    await initialize(first, 1);
    const missing = toolPayload(await first.request(2, "tools/call", {
      name: "codex_checkpoint",
      arguments: { action: "read", thread_id: threadId },
    }));
    assert.deepEqual(missing, {
      source: "local_codex_bridge_checkpoint",
      found: false,
      thread_id: threadId,
      checkpoint: null,
    });
    assert.deepEqual(readdirSync(checkpointDirectory), []);

    const initialized = toolPayload(await first.request(3, "tools/call", {
      name: "codex_checkpoint",
      arguments: {
        action: "update",
        thread_id: threadId,
        original_goal: "Deliver the narrow checkpoint capability.",
        original_constraints: "No database, task layer, monitoring, or production restart.",
        original_acceptance: "Immutable intent and bounded state survive a process restart.",
        current_understanding: "A second supervision round is required for focused validation.",
        current_decision: "Continue only with checkpoint tests.",
        acceptance_status: "Not accepted; persistence is not yet verified.",
        next_step: "Run the first update and restart the MCP process.",
      },
    }));
    assert.equal(initialized.operation, "initialized");
    const initialCheckpoint = initialized.checkpoint as Record<string, unknown>;
    assert.equal(initialCheckpoint.previous, null);

    const updated = toolPayload(await first.request(4, "tools/call", {
      name: "codex_checkpoint",
      arguments: {
        action: "update",
        thread_id: threadId,
        effective_goal: "Deliver the same checkpoint with explicit restart evidence.",
        current_amendment: "The user allows only this experimental checkpoint feature.",
        current_understanding: "The file write succeeded; restart recovery remains unverified.",
        current_decision: "Restart the test MCP process before acceptance.",
        acceptance_status: "Not accepted; restart read is pending.",
        next_step: "Close this process and read from a fresh process.",
      },
    }));
    assert.equal(updated.operation, "updated");
    const updatedCheckpoint = updated.checkpoint as Record<string, unknown>;
    assert.equal(
      (updatedCheckpoint.previous as Record<string, unknown>).current_understanding,
      "A second supervision round is required for focused validation.",
    );
    assert.equal(
      (updatedCheckpoint.current as Record<string, unknown>).current_understanding,
      "The file write succeeded; restart recovery remains unverified.",
    );

    const rejected = await first.request(5, "tools/call", {
      name: "codex_checkpoint",
      arguments: {
        action: "update",
        thread_id: threadId,
        original_goal: "Silently replace the original goal.",
        current_decision: "This update must be rejected.",
      },
    });
    assert.equal((rejected.result as Record<string, unknown>).isError, true);
    assert.match(toolPayload(rejected).error as string, /original_goal is immutable/);

    const firstExitCode = await first.close();
    first = undefined;
    assert.equal(firstExitCode, 0);

    second = new TestClient(environment);
    await initialize(second, 1);
    const recovered = toolPayload(await second.request(2, "tools/call", {
      name: "codex_checkpoint",
      arguments: { action: "read", thread_id: threadId },
    }));
    assert.equal(recovered.found, true);
    const recoveredCheckpoint = recovered.checkpoint as Record<string, unknown>;
    assert.equal(
      (recoveredCheckpoint.original as Record<string, unknown>).original_goal,
      "Deliver the narrow checkpoint capability.",
    );
    assert.equal(
      (recoveredCheckpoint.previous as Record<string, unknown>).current_understanding,
      "A second supervision round is required for focused validation.",
    );
    assert.equal(
      (recoveredCheckpoint.current as Record<string, unknown>).current_understanding,
      "The file write succeeded; restart recovery remains unverified.",
    );

    const rotated = toolPayload(await second.request(3, "tools/call", {
      name: "codex_checkpoint",
      arguments: {
        action: "update",
        thread_id: threadId,
        current_amendment: null,
        current_understanding: "Restart recovery is verified.",
        current_decision: "The checkpoint behavior is ready for acceptance review.",
        acceptance_status: "Acceptance review may proceed.",
        next_step: "Read once before final acceptance.",
      },
    }));
    const rotatedCheckpoint = rotated.checkpoint as Record<string, unknown>;
    assert.equal(
      (rotatedCheckpoint.previous as Record<string, unknown>).current_understanding,
      "The file write succeeded; restart recovery remains unverified.",
    );
    assert.equal(
      (rotatedCheckpoint.current as Record<string, unknown>).current_understanding,
      "Restart recovery is verified.",
    );
    assert.equal(
      (rotatedCheckpoint.current as Record<string, unknown>).current_amendment,
      null,
    );
    assert.deepEqual(Object.keys(rotatedCheckpoint).sort(), [
      "created_at",
      "current",
      "original",
      "previous",
      "schema_version",
      "thread_id",
      "updated_at",
    ]);

    const storedFiles = readdirSync(checkpointDirectory);
    assert.equal(storedFiles.length, 1);
    assert.match(storedFiles[0] ?? "", /^[a-f0-9]{64}\.json$/);
    const stored = JSON.parse(
      readFileSync(join(checkpointDirectory, storedFiles[0]!), "utf8"),
    ) as Record<string, unknown>;
    assert.equal("history" in stored, false);
    assert.equal("events" in stored, false);
  } finally {
    if (first) {
      await first.close();
    }
    if (second) {
      await second.close();
    }
    rmSync(checkpointDirectory, { recursive: true, force: true });
  }
});

test("MCP reports protocol errors and domain tool errors without stdout noise", async () => {
  const client = new TestClient();
  try {
    await client.request(1, "initialize", {
      protocolVersion: "2099-01-01",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const unknownMethod = await client.request(2, "missing/method");
    assert.equal((unknownMethod.error as Record<string, unknown>).code, -32601);
    const unknownTool = await client.request(3, "tools/call", { name: "not_a_tool", arguments: {} });
    assert.equal((unknownTool.error as Record<string, unknown>).code, -32602);
    const invalidTool = await client.request(4, "tools/call", {
      name: "codex_observe",
      arguments: {},
    });
    assert.equal((invalidTool.result as Record<string, unknown>).isError, true);
  } finally {
    assert.equal(await client.close(), 0);
  }
});
