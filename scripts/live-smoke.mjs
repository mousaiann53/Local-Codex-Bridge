import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = fileURLToPath(new URL("../dist/src/index.js", import.meta.url));
const smokeCwd = process.env.SMOKE_CWD || projectRoot;

if (!process.env.CODEX_EXE) {
  throw new Error("Set CODEX_EXE to a Codex executable before running the live smoke test.");
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class Session {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.child = spawn(process.execPath, [entry], {
      cwd: projectRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8_000);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const key = `${typeof message.id}:${String(message.id)}`;
      const waiter = this.pending.get(key);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.pending.delete(key);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = 180_000) {
    const id = this.nextId++;
    const key = `number:${id}`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for MCP ${method}`)),
        timeoutMs,
      );
      this.pending.set(key, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "local-codex-bridge-live-smoke", version: "1.0.0" },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  async call(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") throw new Error(`${name} returned no text content`);
    const parsed = JSON.parse(text);
    if (result.isError) throw new Error(`${name}: ${parsed.error || text}`);
    return parsed;
  }

  async close() {
    if (this.child.exitCode !== null) return this.child.exitCode;
    this.child.stdin.end();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill();
        reject(new Error(`Local Codex Bridge did not exit after stdin EOF. stderr: ${this.stderr}`));
      }, 8_000);
      this.child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}

async function observeToTerminal(session, threadId, initialCursor = 0, onObserved = null) {
  let cursor = initialCursor;
  let eventCount = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const observed = await session.call("codex_observe", {
      thread_id: threadId,
      cursor,
      limit: 100,
    });
    eventCount += observed.events.length;
    cursor = observed.next_cursor;
    if (onObserved) await onObserved(observed);
    if (observed.terminal) return { observed, eventCount };
    await delay(400);
  }
  throw new Error(`Timed out observing ${threadId}`);
}

function lastPersistedAgentMessage(readResult) {
  const turns = Array.isArray(readResult?.thread?.turns) ? readResult.thread.turns : [];
  const items = Array.isArray(turns.at(-1)?.items) ? turns.at(-1).items : [];
  return items
    .filter((item) => item?.type === "agentMessage" && typeof item.text === "string")
    .at(-1)?.text ?? null;
}

const summary = {};
let first;
try {
  first = new Session();
  await first.initialize();
  const startedAt = Date.now();
  const started = await first.call("codex_turn", {
    cwd: smokeCwd,
    sandbox: "read-only",
    approval_policy: "untrusted",
    text: "Read-only smoke: inspect package.json without modifying anything. If a command approval is declined, do not retry it; finish with exactly BRIDGE_SMOKE_OK.",
  });
  const acceptedMs = Date.now() - startedAt;
  const immediate = await first.call("codex_observe", {
    thread_id: started.thread_id,
    cursor: 0,
    limit: 100,
  });
  if (immediate.terminal) {
    throw new Error("codex_turn did not demonstrably return before terminal completion");
  }
  const firstResponses = new Set();
  const finished = await observeToTerminal(first, started.thread_id, 0, async (observed) => {
    for (const request of observed.pending_requests) {
      if (!request.method.toLowerCase().includes("approval")) continue;
      const key = `${typeof request.request_id}:${String(request.request_id)}`;
      if (firstResponses.has(key)) continue;
      firstResponses.add(key);
      await first.call("codex_respond", {
        request_id: request.request_id,
        thread_id: request.thread_id,
        turn_id: request.turn_id,
        method: request.method,
        decision: "decline",
      });
    }
  });
  if (!String(finished.observed.terminal.final_result).includes("BRIDGE_SMOKE_OK")) {
    throw new Error("First live turn did not produce BRIDGE_SMOKE_OK");
  }
  summary.first_turn = {
    thread_id: started.thread_id,
    turn_id: started.turn_id,
    accepted_ms: acceptedMs,
    returned_before_completion: true,
    observed_events: finished.eventCount,
    terminal_status: finished.observed.terminal.status,
  };
  if ((await first.close()) !== 0) throw new Error("First Bridge process exited nonzero");
  first = null;

  const second = new Session();
  try {
    await second.initialize();
    const listed = await second.call("codex_threads", {
      cwd: smokeCwd,
      limit: 100,
    });
    if (!listed.data.some((thread) => thread.id === started.thread_id)) {
      throw new Error("Restarted app-server thread/list did not find the smoke thread");
    }
    const read = await second.call("codex_threads", {
      thread_id: started.thread_id,
      include_turns: true,
    });
    if (!String(lastPersistedAgentMessage(read)).includes("BRIDGE_SMOKE_OK")) {
      throw new Error("Restarted app-server thread/read did not recover the stored final answer");
    }
    const recovered = await second.call("codex_observe", {
      thread_id: started.thread_id,
      limit: 20,
    });
    if (recovered.runtime_available !== false || recovered.live_state_reconstructable !== false) {
      throw new Error("Restart recovery did not use the thread/read fallback");
    }
    if (!String(recovered.terminal?.final_result).includes("BRIDGE_SMOKE_OK")) {
      throw new Error("Restart recovery did not recover the stored final answer");
    }
    summary.restart_recovery = {
      runtime_available: recovered.runtime_available,
      live_state_reconstructable: recovered.live_state_reconstructable,
      source: recovered.source,
      terminal_status: recovered.terminal.status,
      listed_after_restart: true,
      read_after_restart: true,
    };

    const staged = await second.call("codex_turn", {
      cwd: smokeCwd,
      sandbox: "read-only",
      approval_policy: "untrusted",
      text: "Read-only staged smoke: request a harmless command, but if approval is declined do not retry it. Wait for steering before finishing.",
    });
    let stagedState = null;
    let pendingApproval = null;
    let commandObserved = false;
    let stagedCursor = 0;
    const commandDeadline = Date.now() + 8_000;
    while (Date.now() < commandDeadline && !commandObserved) {
      stagedState = await second.call("codex_observe", {
        thread_id: staged.thread_id,
        cursor: stagedCursor,
        limit: 100,
      });
      if (stagedState.terminal) {
        throw new Error("Staged turn completed before a command was observable");
      }
      stagedCursor = stagedState.next_cursor;
      pendingApproval = stagedState.pending_requests.find(
        (request) => request.method === "item/commandExecution/requestApproval",
      );
      commandObserved = Boolean(pendingApproval) || stagedState.events.some(
        (event) => event.method.includes("commandExecution") ||
          (event.method === "item/started" && event.data?.item?.type === "commandExecution"),
      );
      if (!commandObserved) await delay(150);
    }
    const steered = await second.call("codex_steer", {
      thread_id: staged.thread_id,
      expected_turn_id: staged.turn_id,
      text: "For this same active turn, do not run a command and finish with exactly BRIDGE_STEERED_OK. Do not modify files.",
    });
    if (steered.turn_id !== staged.turn_id) {
      throw new Error("turn/steer changed the turn id");
    }
    if (!pendingApproval) {
      const approvalDeadline = Date.now() + 2_000;
      while (Date.now() < approvalDeadline && !pendingApproval) {
        const afterSteer = await second.call("codex_observe", {
          thread_id: staged.thread_id,
          cursor: stagedCursor,
          limit: 100,
        });
        stagedCursor = afterSteer.next_cursor;
        pendingApproval = afterSteer.pending_requests.find(
          (request) => request.method === "item/commandExecution/requestApproval",
        );
        if (!pendingApproval) await delay(100);
      }
    }
    let approvalResponded = false;
    const respondedApprovals = new Set();
    if (pendingApproval) {
      await second.call("codex_respond", {
        request_id: pendingApproval.request_id,
        thread_id: pendingApproval.thread_id,
        turn_id: pendingApproval.turn_id,
        method: pendingApproval.method,
        decision: "decline",
      });
      approvalResponded = true;
      respondedApprovals.add(`${typeof pendingApproval.request_id}:${String(pendingApproval.request_id)}`);
    }
    const steerFinished = await observeToTerminal(
      second,
      staged.thread_id,
      0,
      async (observed) => {
        for (const request of observed.pending_requests) {
          if (
            request.method !== "item/commandExecution/requestApproval" &&
            request.method !== "execCommandApproval"
          ) continue;
          const key = `${typeof request.request_id}:${String(request.request_id)}`;
          if (respondedApprovals.has(key)) continue;
          respondedApprovals.add(key);
          await second.call("codex_respond", {
            request_id: request.request_id,
            thread_id: request.thread_id,
            turn_id: request.turn_id,
            method: request.method,
            decision: "decline",
          });
          approvalResponded = true;
        }
      },
    );
    if (!String(steerFinished.observed.terminal.final_result).includes("BRIDGE_STEERED_OK")) {
      throw new Error("Steered turn did not produce BRIDGE_STEERED_OK");
    }
    summary.steer = {
      thread_id: staged.thread_id,
      start_turn_id: staged.turn_id,
      steer_turn_id: steered.turn_id,
      same_turn: true,
      observed_events: steerFinished.eventCount,
      terminal_status: steerFinished.observed.terminal.status,
      staged_command_observed: commandObserved,
      approval_responded: approvalResponded,
    };
  } finally {
    if ((await second.close()) !== 0) throw new Error("Second Bridge process exited nonzero");
  }
} finally {
  if (first) await first.close();
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
