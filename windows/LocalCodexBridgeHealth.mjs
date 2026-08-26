import { spawn } from "node:child_process";

const entryPoint = process.argv[2];
if (!entryPoint) {
  console.error("BRIDGE_HEALTH_FAIL: built entry point argument is required");
  process.exit(1);
}

const child = spawn(process.execPath, [entryPoint], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  shell: false,
});
const expectedTools = new Set([
  "codex_threads",
  "codex_projects",
  "codex_turn",
  "codex_observe",
  "codex_steer",
  "codex_respond",
  "codex_interrupt",
  "codex_checkpoint",
]);
let buffer = "";
let completed = false;

function fail(message) {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  console.error(`BRIDGE_HEALTH_FAIL: ${message}`);
  child.kill();
  process.exitCode = 1;
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

const timeout = setTimeout(() => fail("timed out waiting for MCP initialization"), 10000);
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail("Bridge stdout was not JSON-RPC");
      return;
    }
    if (message.id === 1) {
      if (!message.result) {
        fail("initialize did not return a result");
        return;
      }
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      continue;
    }
    if (message.id === 2) {
      const names = new Set((message.result?.tools ?? []).map((tool) => tool?.name));
      if (names.size !== expectedTools.size || [...expectedTools].some((name) => !names.has(name))) {
        fail("tools/list did not expose exactly the eight public tools");
        return;
      }
      completed = true;
      clearTimeout(timeout);
      console.log("BRIDGE_HEALTH_OK");
      child.kill();
    }
  }
});
child.once("error", (error) => fail(`Bridge process failed to start: ${error.message}`));
child.once("exit", (code, signal) => {
  if (completed) process.exit(0);
  fail(`Bridge exited before health completed (code=${code}, signal=${signal})`);
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "local-control-health", version: "1.0" },
  },
});
