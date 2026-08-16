import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AppServerManager } from "../src/app-server.js";
import { ProjectRegistry } from "../src/project-registry.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface } from "../src/tools.js";

function initializeGitRepository(directory: string): void {
  mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "--quiet", directory], {
    windowsHide: true,
    stdio: "ignore",
  });
}

test("Project Registry gates every thread operation and annotates authorized threads", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-codex-bridge-project-tools-"));
  try {
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    const guessedProject = join(root, "guessed-project");
    initializeGitRepository(projectA);
    initializeGitRepository(projectB);
    initializeGitRepository(guessedProject);
    const projectACwd = join(projectA, "packages", "app");
    mkdirSync(projectACwd, { recursive: true });

    const registryPath = join(root, "state", "projects.json");
    const registry = new ProjectRegistry({ filePath: registryPath, environment: {} });
    const enabledProject = registry.add(projectA, { discoveredFrom: "test" });
    const threadCwds = new Map<string, string>([
      ["thread-a", projectACwd],
      ["thread-b", projectB],
    ]);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const runtime = new RuntimeStore();
    const manager = {
      runtime,
      request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        calls.push({ method, params });
        if (method === "thread/list") {
          return {
            data: [...threadCwds].map(([id, cwd]) => ({ id, cwd })),
            nextCursor: null,
            backwardsCursor: null,
          };
        }
        if (method === "thread/read") {
          const id = params.threadId as string;
          return { thread: { id, cwd: threadCwds.get(id), turns: [] } };
        }
        if (method === "thread/start") {
          threadCwds.set("new-thread", params.cwd as string);
          return { thread: { id: "new-thread", cwd: params.cwd } };
        }
        if (method === "turn/start") {
          return { turn: { id: "new-turn", status: "inProgress" } };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as AppServerManager;
    const control = new ControlSurface(manager, undefined, registry);

    const listed = await control.call("codex_threads", {}) as Record<string, unknown>;
    const visible = listed.data as Array<Record<string, unknown>>;
    assert.deepEqual(visible.map((thread) => thread.id), ["thread-a"]);
    assert.equal(visible[0]?.project_id, enabledProject.project_id);
    const pending = registry.projectForCwd(projectB, false);
    assert.equal(pending?.enabled, false);
    assert.equal(pending?.discovered_from, "codex_thread");

    const filtered = await control.call("codex_threads", {
      project_id: enabledProject.project_id,
    }) as Record<string, unknown>;
    assert.deepEqual(
      (filtered.data as Array<Record<string, unknown>>).map((thread) => thread.id),
      ["thread-a"],
    );

    calls.length = 0;
    await assert.rejects(
      control.call("codex_threads", { thread_id: "thread-b", include_turns: true }),
      /enabled project/,
    );
    assert.deepEqual(
      calls.map((call) => [call.method, call.params.includeTurns]),
      [["thread/read", false]],
    );

    const beforeGuess = registry.listProjects().length;
    calls.length = 0;
    await assert.rejects(
      control.call("codex_turn", { cwd: guessedProject, text: "must remain pending-free" }),
      /enabled project/,
    );
    assert.equal(calls.length, 0);
    assert.equal(registry.listProjects().length, beforeGuess);

    const started = await control.call("codex_turn", {
      cwd: projectACwd,
      text: "start in the enabled project",
    }) as Record<string, unknown>;
    assert.equal(started.project_id, enabledProject.project_id);
    assert.equal(runtime.authorizedWorkspace("new-thread"), realpathSync.native(projectACwd));

    new ProjectRegistry({ filePath: registryPath, environment: {} })
      .disable(enabledProject.project_id);
    await assert.rejects(
      control.call("codex_observe", { thread_id: "new-thread", cursor: 0 }),
      /No enabled projects|enabled project/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
