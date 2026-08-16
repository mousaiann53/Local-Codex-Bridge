import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { RuntimeStore } from "../src/runtime.js";
import {
  AtomicUxProjection,
  createUxProjectionFromEnvironment,
  type UxProjectionDocument,
} from "../src/ux-projection.js";

const testRoot = join(process.cwd(), "_test_tmp", "ux-projection");

function readProjection(path: string): UxProjectionDocument {
  return JSON.parse(readFileSync(path, "utf8")) as UxProjectionDocument;
}

test.beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(testRoot, { recursive: true });
});

test.after(() => rmSync(join(process.cwd(), "_test_tmp"), { recursive: true, force: true }));

test("projection is opt-in, atomic-shaped, bounded, monotonic, and content-free", () => {
  assert.equal(createUxProjectionFromEnvironment({}), undefined);
  const path = join(testRoot, "projection.json");
  const projection = new AtomicUxProjection(path, 2);
  const runtime = new RuntimeStore(8, projection);

  runtime.markTurnAccepted("thread-secret", "turn-1");
  runtime.recordServerRequest("approval-1", "item/commandExecution/requestApproval", {
    threadId: "thread-secret",
    turnId: "turn-1",
    command: "DO_NOT_PROJECT_COMMAND",
    prompt: "DO_NOT_PROJECT_PROMPT",
  });
  runtime.recordServerRequest("approval-1", "item/commandExecution/requestApproval", {
    threadId: "thread-secret",
    turnId: "turn-1",
  });
  runtime.recordServerRequest("input-1", "item/tool/requestUserInput", {
    threadId: "thread-secret",
    turnId: "turn-1",
    questions: ["DO_NOT_PROJECT_QUESTION"],
  });
  runtime.recordNotification("turn/completed", {
    threadId: "thread-secret",
    turn: {
      id: "turn-1",
      status: "completed",
      items: [{ type: "agentMessage", text: "DO_NOT_PROJECT_RESULT" }],
    },
  });

  const raw = readFileSync(path, "utf8");
  const document = readProjection(path);
  assert.equal(document.sequence, 4);
  assert.deepEqual(document.signals.map((signal) => signal.sequence), [3, 4]);
  assert.deepEqual(document.signals.map((signal) => signal.kind), ["waiting_user_input", "terminal"]);
  assert.deepEqual(document.counts, { active: 0, waiting: 0, terminal: 1 });
  assert.doesNotMatch(raw, /DO_NOT_PROJECT/);
  assert.deepEqual(Object.keys(document).sort(), ["counts", "generation", "schema_version", "sequence", "signals"]);
  assert.equal(document.generation.pid, process.pid);
  assert.match(document.generation.id, /^[0-9a-f-]{36}$/);
  projection.close();
  assert.throws(() => readFileSync(path));
});
