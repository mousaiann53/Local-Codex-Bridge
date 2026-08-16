import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import type { AppServerManager } from "../src/app-server.js";
import {
  MAX_OBSERVE_WAIT_MS,
  RuntimeStore,
  sanitizeForTransport,
  type RuntimeObservation,
} from "../src/runtime.js";
import {
  ControlSurface,
  TOOL_DEFINITIONS,
  validateWindowsCwd,
} from "../src/tools.js";
import {
  ALLOWED_ROOTS_ENV,
  WorkspaceRootPolicy,
} from "../src/workspace-roots.js";

async function within<T>(promise: Promise<T>, milliseconds = 150): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Promise did not settle within ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function controlFor(runtime: RuntimeStore): ControlSurface {
  const appServer = {
    runtime,
    request: async (method: string): Promise<unknown> => {
      assert.equal(method, "thread/read");
      return { thread: { id: "stored-thread", turns: [] } };
    },
  } as unknown as AppServerManager;
  return new ControlSurface(appServer);
}

test("sanitizer redacts obvious secrets and bounds strings", () => {
  const result = sanitizeForTransport(
    {
      api_key: "abc123",
      OPENAI_API_KEY: "prefixed-secret",
      GITHUB_TOKEN: "prefixed-token",
      nested: { authorization: "Bearer secret-value", token_count: 42 },
      text: `Bearer abcdefghijklmnop OPENAI_API_KEY=also-secret ${"x".repeat(100)}`,
    },
    { maxStringChars: 30, totalCharBudget: 500 },
  ) as Record<string, unknown>;
  assert.equal(result.api_key, "[REDACTED]");
  assert.equal(result.OPENAI_API_KEY, "[REDACTED]");
  assert.equal(result.GITHUB_TOKEN, "[REDACTED]");
  assert.deepEqual((result.nested as Record<string, unknown>).token_count, 42);
  assert.equal((result.nested as Record<string, unknown>).authorization, "[REDACTED]");
  assert.match(result.text as string, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(result.text as string, /also-secret/);
  assert.match(result.text as string, /truncated/);
});

test("cwd check accepts drive paths and rejects UNC/device/relative paths", () => {
  assert.equal(validateWindowsCwd("D:/Bridge/project"), "D:\\Bridge\\project");
  assert.throws(() => validateWindowsCwd("relative\\path"), /drive-letter/);
  assert.throws(() => validateWindowsCwd("\\\\server\\share"), /UNC or Windows device/);
  assert.throws(() => validateWindowsCwd("\\\\?\\D:\\Bridge"), /UNC or Windows device/);
});

test("workspace roots canonicalize real directories and reject traversal and reparse escapes", () => {
  const testDirectory = mkdtempSync(join(tmpdir(), "local-codex-bridge-roots-"));
  try {
    const allowedRoot = join(testDirectory, "Allowed");
    const inside = join(allowedRoot, "inside");
    const outside = join(testDirectory, "Allowed-neighbor");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside);

    const policy = new WorkspaceRootPolicy([allowedRoot]);
    assert.equal(
      policy.authorizeCwd(inside.toUpperCase()),
      realpathSync.native(inside),
      "Windows authorization must be case-insensitive and return the canonical path",
    );
    assert.equal(
      policy.authorizeCwd(`${inside}\\..\\inside`),
      realpathSync.native(inside),
    );
    assert.throws(
      () => policy.authorizeCwd(`${allowedRoot}\\..\\Allowed-neighbor`),
      /outside the configured allowed roots/,
    );
    assert.throws(
      () => policy.authorizeCwd(outside),
      /outside the configured allowed roots/,
      "a neighboring path with the same prefix must not be authorized",
    );

    const insideJunction = join(allowedRoot, "inside-junction");
    symlinkSync(inside, insideJunction, "junction");
    assert.equal(policy.authorizeCwd(insideJunction), realpathSync.native(inside));

    const escapingJunction = join(allowedRoot, "escape-junction");
    symlinkSync(outside, escapingJunction, "junction");
    assert.equal(lstatSync(escapingJunction).isSymbolicLink(), true);
    const outsideChild = join(outside, "child");
    mkdirSync(outsideChild);
    assert.throws(
      () => policy.authorizeCwd(join(escapingJunction, "child")),
      /outside the configured allowed roots/,
    );

    const filePath = join(allowedRoot, "not-a-directory.txt");
    writeFileSync(filePath, "fixture", "utf8");
    assert.throws(
      () => policy.authorizeCwd(filePath),
      /must resolve to an existing local directory/,
    );
    assert.throws(
      () => policy.authorizeCwd(join(allowedRoot, "missing")),
      /must resolve to an existing local directory/,
    );

    const fromEnvironment = WorkspaceRootPolicy.fromEnvironment({
      [ALLOWED_ROOTS_ENV]: `${allowedRoot};${outside}`,
    });
    assert.equal(fromEnvironment.authorizeCwd(outside), realpathSync.native(outside));
    for (const emptyValue of [undefined, "", "   ", "; ;"]) {
      const environment: NodeJS.ProcessEnv = {};
      if (emptyValue !== undefined) {
        environment[ALLOWED_ROOTS_ENV] = emptyValue;
      }
      assert.throws(
        () => WorkspaceRootPolicy.fromEnvironment(environment).authorizeCwd(inside),
        new RegExp(ALLOWED_ROOTS_ENV),
      );
    }
    assert.throws(
      () => new WorkspaceRootPolicy([join(testDirectory, "missing-root")]),
      /must resolve to an existing local directory/,
    );

    const replacedRoot = join(testDirectory, "replaced-root");
    const movedRoot = join(testDirectory, "moved-root");
    mkdirSync(replacedRoot);
    const replacementPolicy = new WorkspaceRootPolicy([replacedRoot]);
    renameSync(replacedRoot, movedRoot);
    mkdirSync(replacedRoot);
    assert.throws(
      () => replacementPolicy.authorizeCwd(replacedRoot),
      /configured allowed root changed or became unavailable/,
    );
  } finally {
    rmSync(testDirectory, { recursive: true, force: true });
  }
});

test("codex_turn fails closed without roots and authorizes persisted resume cwd before mutation", async () => {
  const testDirectory = mkdtempSync(join(tmpdir(), "local-codex-bridge-turn-roots-"));
  try {
    const allowedRoot = join(testDirectory, "allowed");
    const allowedCwd = join(allowedRoot, "workspace");
    const outsideCwd = join(testDirectory, "outside");
    mkdirSync(allowedCwd, { recursive: true });
    mkdirSync(outsideCwd);

    const blockedCalls: string[] = [];
    const blockedManager = {
      runtime: new RuntimeStore(),
      request: async (method: string): Promise<unknown> => {
        blockedCalls.push(method);
        throw new Error("unexpected native request");
      },
    } as unknown as AppServerManager;
    const blocked = new ControlSurface(
      blockedManager,
      undefined,
      new WorkspaceRootPolicy([]),
    );
    await assert.rejects(
      blocked.call("codex_turn", { text: "blocked", cwd: allowedCwd }),
      new RegExp(ALLOWED_ROOTS_ENV),
    );
    await assert.rejects(
      blocked.call("codex_turn", { text: "blocked resume", thread_id: "stored-thread" }),
      new RegExp(ALLOWED_ROOTS_ENV),
    );
    assert.deepEqual(blockedCalls, []);

    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let persistedCwd = allowedCwd;
    const manager = {
      runtime: new RuntimeStore(),
      request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        calls.push({ method, params });
        if (method === "thread/read") {
          return { thread: { id: "stored-thread", cwd: persistedCwd } };
        }
        if (method === "thread/resume") {
          return { thread: { id: "stored-thread" } };
        }
        if (method === "thread/start") {
          return { thread: { id: "new-thread" } };
        }
        if (method === "turn/start") {
          return { turn: { id: "turn-1", status: "inProgress" } };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as AppServerManager;
    const control = new ControlSurface(
      manager,
      undefined,
      new WorkspaceRootPolicy([allowedRoot]),
    );

    const started = await control.call("codex_turn", {
      text: "resume safely",
      thread_id: "stored-thread",
    }) as Record<string, unknown>;
    assert.equal(started.accepted, true);
    assert.deepEqual(calls.map((call) => call.method), [
      "thread/read",
      "thread/resume",
      "turn/start",
    ]);
    const canonicalCwd = realpathSync.native(allowedCwd);
    assert.equal(calls[0]?.params.threadId, "stored-thread");
    assert.equal(calls[0]?.params.includeTurns, false);
    assert.equal(calls[1]?.params.cwd, canonicalCwd);
    assert.equal(calls[2]?.params.cwd, canonicalCwd);

    calls.length = 0;
    const explicitResume = await control.call("codex_turn", {
      text: "resume with an explicit safe cwd",
      thread_id: "stored-thread",
      cwd: allowedCwd,
    }) as Record<string, unknown>;
    assert.equal(explicitResume.accepted, true);
    assert.deepEqual(calls.map((call) => call.method), ["thread/resume", "turn/start"]);
    assert.equal(calls[0]?.params.cwd, canonicalCwd);
    assert.equal(calls[1]?.params.cwd, canonicalCwd);

    calls.length = 0;
    const newThread = await control.call("codex_turn", {
      text: "start inside the allowed root",
      cwd: allowedCwd,
    }) as Record<string, unknown>;
    assert.equal(newThread.accepted, true);
    assert.deepEqual(calls.map((call) => call.method), ["thread/start", "turn/start"]);
    assert.equal(calls[0]?.params.cwd, canonicalCwd);
    assert.equal(calls[1]?.params.cwd, canonicalCwd);

    calls.length = 0;
    await assert.rejects(
      control.call("codex_turn", {
        text: "reject unsafe override",
        thread_id: "stored-thread",
        cwd: outsideCwd,
      }),
      /outside the configured allowed roots/,
    );
    assert.equal(calls.length, 0);

    await assert.rejects(
      control.call("codex_turn", { text: "reject unsafe new thread", cwd: outsideCwd }),
      /outside the configured allowed roots/,
    );
    assert.equal(calls.length, 0);

    calls.length = 0;
    persistedCwd = outsideCwd;
    await assert.rejects(
      control.call("codex_turn", {
        text: "reject unsafe resume",
        thread_id: "stored-thread",
      }),
      /outside the configured allowed roots/,
    );
    assert.deepEqual(calls.map((call) => call.method), ["thread/read"]);
  } finally {
    rmSync(testDirectory, { recursive: true, force: true });
  }
});

test("runtime ring uses monotonic cursors, scopes pending raw ids, and captures terminal output", () => {
  const runtime = new RuntimeStore(2);
  runtime.markTurnAccepted("thread-1", "turn-1");
  runtime.recordNotification("turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress" },
  });
  runtime.recordServerRequest("raw-7", "item/fileChange/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    password: "secret",
  });
  const pending = runtime.takePending("raw-7", {
    threadId: "thread-1",
    turnId: "turn-1",
    method: "item/fileChange/requestApproval",
  });
  assert.equal(pending.rawId, "raw-7");
  assert.throws(
    () => runtime.takePending(7, {
      threadId: "thread-1",
      method: "item/fileChange/requestApproval",
    }),
    /No pending/,
  );
  runtime.recordNotification("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "agentMessage", text: "DONE" },
  });
  runtime.recordNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
      items: [{ type: "agentMessage", text: "DONE" }],
    },
  });
  const observed = runtime.observe("thread-1", 0, 10)!;
  assert.equal(observed.cursor_lost, true);
  assert.equal(observed.events.length, 2);
  assert.equal(observed.terminal?.final_result, "DONE");
  assert.equal(observed.runtime_status, "completed");
});

test("observe wait defaults to immediate and buffered events bypass waiting", async () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-immediate", "turn-immediate");
  const control = controlFor(runtime);

  const immediate = await within(control.call("codex_observe", {
    thread_id: "thread-immediate",
    cursor: 0,
  }));
  assert.deepEqual((immediate as Record<string, unknown>).events, []);

  runtime.recordNotification("item/started", {
    threadId: "thread-immediate",
    turnId: "turn-immediate",
    item: { type: "commandExecution", id: "command-buffered" },
  });
  const buffered = await within(control.call("codex_observe", {
    thread_id: "thread-immediate",
    cursor: 0,
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  const events = (buffered as Record<string, unknown>).events as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.method, "item/started");
});

test("active observe wait wakes on an injected runtime event and otherwise times out", async () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-wait", "turn-wait");
  const control = controlFor(runtime);

  const waiting = control.call("codex_observe", {
    thread_id: "thread-wait",
    cursor: 0,
    wait_ms: 1_000,
  });
  runtime.recordNotification("item/started", {
    threadId: "thread-wait",
    turnId: "turn-wait",
    item: { type: "commandExecution", id: "command-wakeup" },
  });
  const woken = await within(waiting);
  const wokenEvents = (woken as Record<string, unknown>).events as Array<Record<string, unknown>>;
  assert.equal(wokenEvents.length, 1);
  assert.equal(wokenEvents[0]?.method, "item/started");

  const startedAt = performance.now();
  const timedOut = await within(control.call("codex_observe", {
    thread_id: "thread-wait",
    cursor: runtime.currentCursor("thread-wait"),
    wait_ms: 40,
  }), 500);
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed >= 25, `observe returned too early after ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 500, `observe exceeded its bounded deadline: ${elapsed.toFixed(1)} ms`);
  assert.deepEqual((timedOut as Record<string, unknown>).events, []);
});

test("cancelling one same-thread observe wait leaves the other waiter intact", async () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-cancel-one", "turn-cancel-one");
  const control = controlFor(runtime);
  const firstController = new AbortController();
  const secondController = new AbortController();

  const first = control.call("codex_observe", {
    thread_id: "thread-cancel-one",
    cursor: 0,
    wait_ms: 1_000,
  }, firstController.signal);
  const second = control.call("codex_observe", {
    thread_id: "thread-cancel-one",
    cursor: 0,
    wait_ms: 1_000,
  }, secondController.signal);

  firstController.abort();
  await assert.rejects(within(first), /MCP request cancelled/);

  runtime.recordNotification("item/started", {
    threadId: "thread-cancel-one",
    turnId: "turn-cancel-one",
    item: { type: "commandExecution", id: "command-after-cancel" },
  });
  const observed = await within(second);
  const events = (observed as Record<string, unknown>).events as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.method, "item/started");
});

test("observe cancellation before waiter registration settles immediately", async () => {
  const controller = new AbortController();
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-cancel-before-register", "turn-cancel-before-register");
  const control = controlFor(runtime);
  controller.abort();

  await assert.rejects(
    within(control.call("codex_observe", {
      thread_id: "thread-cancel-before-register",
      cursor: 0,
      wait_ms: 1_000,
    }, controller.signal)),
    /MCP request cancelled/,
  );
});

test("observe wait handoff cannot lose a mutation between snapshot and registration", async () => {
  class HandoffRuntimeStore extends RuntimeStore {
    #injected = false;

    override observe(
      threadId: string,
      cursor: number | undefined,
      limit: number,
    ): RuntimeObservation | null {
      const snapshot = super.observe(threadId, cursor, limit);
      if (!this.#injected && snapshot?.active_turn_id) {
        this.#injected = true;
        this.recordNotification("item/started", {
          threadId,
          turnId: snapshot?.active_turn_id,
          item: { type: "commandExecution", id: "command-handoff" },
        });
      }
      return snapshot;
    }
  }

  const runtime = new HandoffRuntimeStore();
  runtime.markTurnAccepted("thread-handoff", "turn-handoff");
  const observed = await within(
    runtime.observeWithWait("thread-handoff", 0, 10, 1_000),
  );
  assert.equal(observed?.events.length, 1);
  assert.equal(observed?.events[0]?.method, "item/started");
});

test("completed, pending, inactive, and unavailable observe states do not wait", async () => {
  const completedRuntime = new RuntimeStore();
  completedRuntime.markTurnAccepted("thread-completed", "turn-completed");
  completedRuntime.recordNotification("turn/completed", {
    threadId: "thread-completed",
    turn: { id: "turn-completed", status: "completed", items: [] },
  });
  const completed = await within(controlFor(completedRuntime).call("codex_observe", {
    thread_id: "thread-completed",
    cursor: completedRuntime.currentCursor("thread-completed"),
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  assert.equal(
    ((completed as Record<string, unknown>).terminal as Record<string, unknown>).status,
    "completed",
  );

  const pendingRuntime = new RuntimeStore();
  pendingRuntime.markTurnAccepted("thread-pending", "turn-pending");
  pendingRuntime.recordServerRequest(7, "item/fileChange/requestApproval", {
    threadId: "thread-pending",
    turnId: "turn-pending",
  });
  const pending = await within(controlFor(pendingRuntime).call("codex_observe", {
    thread_id: "thread-pending",
    cursor: pendingRuntime.currentCursor("thread-pending"),
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  assert.equal(
    ((pending as Record<string, unknown>).pending_requests as unknown[]).length,
    1,
  );

  const inactiveRuntime = new RuntimeStore();
  inactiveRuntime.ensureThread("thread-inactive");
  const inactive = await within(controlFor(inactiveRuntime).call("codex_observe", {
    thread_id: "thread-inactive",
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  assert.equal((inactive as Record<string, unknown>).active_turn_id, null);

  const unavailable = await within(controlFor(new RuntimeStore()).call("codex_observe", {
    thread_id: "thread-unavailable",
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  assert.equal((unavailable as Record<string, unknown>).runtime_available, false);
});

test("observe wait schema and validation preserve bounded optional semantics", async () => {
  const observeTool = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_observe");
  const properties = (observeTool?.inputSchema.properties ?? {}) as Record<string, unknown>;
  assert.deepEqual(properties.wait_ms, {
    type: "integer",
    minimum: 0,
    maximum: MAX_OBSERVE_WAIT_MS,
    default: 0,
    description:
      "Optional per-call wait for the next live runtime change when nothing useful is ready; 0 returns immediately. This is event-driven waiting, not stall detection.",
  });
  assert.match(observeTool?.description ?? "", /Optional wait_ms performs one bounded event-driven wait/);
  assert.match(observeTool?.description ?? "", /absence of new command activity alone is not evidence of a stall/);
  assert.match(observeTool?.description ?? "", /repeated bounded-wait observe calls until terminal.*one snapshot is inProgress/);
  assert.match(observeTool?.description ?? "", /After every wake or deadline return, inspect the newly available events\/state.*before starting the next bounded wait/);

  const runtime = new RuntimeStore();
  runtime.ensureThread("thread-validation");
  const control = controlFor(runtime);
  for (const waitMs of [-1, MAX_OBSERVE_WAIT_MS + 1, 1.5]) {
    await assert.rejects(
      control.call("codex_observe", {
        thread_id: "thread-validation",
        wait_ms: waitMs,
      }),
      /wait_ms must be an integer from 0 to 10000/,
    );
  }
  await within(control.call("codex_observe", {
    thread_id: "thread-validation",
    wait_ms: 0,
  }));
  await within(control.call("codex_observe", {
    thread_id: "thread-validation",
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
});
