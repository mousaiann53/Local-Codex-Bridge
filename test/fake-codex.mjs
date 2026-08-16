import readline from "node:readline";

if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") {
  process.exit(64);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let threadCounter = 0;
let turnCounter = 0;
let currentThread = "thread-1";
let currentTurn = "turn-1";
let threadlessParentId;
let unknownRequestResponseReceived = false;
const requestCounts = new Map();
const threadCwds = new Map();
const syntheticSecretPresent = Object.hasOwn(
  process.env,
  "LOCAL_CODEX_BRIDGE_TEST_SYNTHETIC_SECRET",
);
const rustLogPresent = Object.keys(process.env).some(
  (name) => name.toUpperCase() === "RUST_LOG",
);

const countedMethods = new Set([
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/list",
  "thread/read",
]);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (countedMethods.has(message.method)) {
    requestCounts.set(message.method, (requestCounts.get(message.method) ?? 0) + 1);
  }
  if (message.method === "initialize") {
    if (
      message.params?.clientInfo?.name !== "local-codex-bridge" ||
      message.params?.clientInfo?.title !== "Local Codex Bridge" ||
      message.params?.capabilities?.experimentalApi !== false ||
      Object.hasOwn(message.params?.capabilities ?? {}, "mcpServerOpenaiFormElicitation")
    ) {
      send({ id: message.id, error: { code: -32602, message: "unexpected public client identity" } });
      return;
    }
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "D:\\fake", platformFamily: "windows", platformOs: "windows" } });
    return;
  }
  if (message.method === "initialized") {
    if (Object.hasOwn(message, "params")) process.exit(65);
    return;
  }
  if (message.method === "configRequirements/read") {
    if (Object.hasOwn(message, "params") && message.params !== null) {
      send({ id: message.id, error: { code: -32602, message: "configRequirements/read params must be omitted or null" } });
      return;
    }
    send({
      id: message.id,
      result: {
        requirements: {
          allowedApprovalPolicies: ["untrusted", "on-request"],
          allowedSandboxModes: ["read-only", "workspace-write"],
        },
      },
    });
    return;
  }
  if (message.method === "thread/start") {
    if (message.params?.serviceName !== "local-codex-bridge") {
      send({ id: message.id, error: { code: -32602, message: "unexpected public service identity" } });
      return;
    }
    threadCounter += 1;
    currentThread = `thread-${threadCounter}`;
    threadCwds.set(currentThread, message.params.cwd);
    if (message.params?.testNoAcknowledgement === true) {
      return;
    }
    send({ id: message.id, result: { thread: { id: currentThread, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "thread/resume") {
    currentThread = message.params.threadId;
    if (message.params.cwd) {
      threadCwds.set(currentThread, message.params.cwd);
    }
    if (message.params?.testNoAcknowledgement === true) {
      return;
    }
    send({ id: message.id, result: { thread: { id: currentThread } } });
    return;
  }
  if (message.method === "turn/start") {
    turnCounter += 1;
    currentThread = message.params.threadId;
    currentTurn = `turn-${turnCounter}`;
    if (message.params?.testNoAcknowledgement === true) {
      return;
    }
    send({ id: message.id, result: { turn: { id: currentTurn, status: "inProgress", items: [] } } });
    if (message.params?.input?.[0]?.text === "test: hold bounded observe") {
      return;
    }
    setTimeout(() => {
      send({ method: "turn/started", params: { threadId: currentThread, turn: { id: currentTurn, status: "inProgress" } } });
      send({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: currentThread,
          turnId: currentTurn,
          itemId: "item-1",
          command: ["Get-ChildItem"],
          api_key: "must-redact",
        },
      });
    }, 10);
    return;
  }
  if (message.method === "turn/steer") {
    if (message.params?.testNoAcknowledgement === true) {
      return;
    }
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    return;
  }
  if (message.method === "turn/interrupt") {
    if (message.params?.testNoAcknowledgement === true) {
      return;
    }
    send({ id: message.id, result: {} });
    setTimeout(() => {
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted", items: [] } } });
    }, 5);
    return;
  }
  if (message.method === "thread/list") {
    if (message.params?.testNoAcknowledgement === true) {
      return;
    }
    send({ id: message.id, result: { data: [{ id: "stored-thread", cwd: "D:\\Bridge" }], nextCursor: null, backwardsCursor: null } });
    return;
  }
  if (message.method === "thread/read") {
    if (message.params?.testNoAcknowledgement === true) {
      return;
    }
    send({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          cwd: threadCwds.get(message.params.threadId) ?? process.cwd(),
          status: { type: "notLoaded" },
          turns: message.params.includeTurns
            ? [{ id: "stored-turn", status: "completed", items: [{ type: "agentMessage", text: "STORED_OK" }] }]
            : [],
        },
      },
    });
    return;
  }
  if (message.method === "test/request-counts") {
    send({ id: message.id, result: Object.fromEntries(requestCounts) });
    return;
  }
  if (message.method === "test/child-environment") {
    send({ id: message.id, result: { syntheticSecretPresent, rustLogPresent } });
    return;
  }
  if (message.method === "test/unknown-request") {
    send({
      id: "future-request-1",
      method: "future/tool/requestSomething",
      params: {
        threadId: "thread-future",
        turnId: "turn-future",
        api_key: "must-redact",
        visible: "keep-me",
      },
    });
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "test/duplicate-server-request") {
    send({
      id: "duplicate-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-dup-a", turnId: "turn-dup-a", cwd: process.cwd(), command: ["echo", "first"] },
    });
    send({
      id: "duplicate-approval",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-dup-b", turnId: "turn-dup-b", cwd: process.cwd(), changes: [] },
    });
    return;
  }
  if (message.method === "test/unknown-request-status") {
    send({ id: message.id, result: { responseReceived: unknownRequestResponseReceived } });
    return;
  }
  if (message.method === "test/exit") {
    process.exit(23);
  }
  if (message.method === "test/threadless") {
    threadlessParentId = message.id;
    send({
      id: "threadless-1",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: null },
    });
    return;
  }
  if (message.id === "threadless-1" && message.error) {
    send({
      id: threadlessParentId,
      result: { clientErrorId: message.id, clientError: message.error },
    });
    threadlessParentId = undefined;
    return;
  }
  if (message.id === "approval-1" && message.result) {
    send({ method: "serverRequest/resolved", params: { threadId: currentThread, turnId: currentTurn, requestId: "approval-1" } });
    send({ method: "item/completed", params: { threadId: currentThread, turnId: currentTurn, item: { type: "agentMessage", text: "FAKE_FINAL" } } });
    send({ method: "turn/completed", params: { threadId: currentThread, turn: { id: currentTurn, status: "completed", items: [{ type: "agentMessage", text: "FAKE_FINAL" }] } } });
    return;
  }
  if (message.id === "future-request-1") {
    unknownRequestResponseReceived = true;
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: `unknown ${message.method}` } });
  }
});

lines.on("close", () => process.exit(0));
