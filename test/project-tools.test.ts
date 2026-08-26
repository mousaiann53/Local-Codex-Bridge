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
import { ControlSurface, validateWindowsCwd } from "../src/tools.js";

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
    const projectC = join(root, "project-c");
    const guessedProject = join(root, "guessed-project");
    initializeGitRepository(projectA);
    initializeGitRepository(projectB);
    initializeGitRepository(projectC);
    initializeGitRepository(guessedProject);
    const projectACwd = join(projectA, "packages", "app");
    mkdirSync(projectACwd, { recursive: true });

    const registryPath = join(root, "state", "projects.json");
    const registry = new ProjectRegistry({ filePath: registryPath, environment: {} });
    const enabledProject = registry.add(projectA, { discoveredFrom: "test" });
    const enabledProjectWithoutThreads = registry.add(projectC, {
      displayName: "Enabled Without Threads",
      discoveredFrom: "test",
    });
    const threadCwds = new Map<string, string>([
      ["thread-a", projectACwd],
      ["thread-a-duplicate", projectACwd.toUpperCase()],
      ["thread-b", projectB],
      ["unsupported-thread", "\\\\server\\share\\private"],
      ["stale-thread", join(root, "removed-project")],
    ]);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const runtime = new RuntimeStore();
    const manager = {
      runtime,
      request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        calls.push({ method, params });
        if (method === "thread/list") {
          const entries = [...threadCwds].map(([id, cwd]) => ({
            id,
            cwd,
            sourceKind: id === "thread-a" ? "exec" : "cli",
          }));
          if (params.limit === 100 && params.archived === false && params.cursor === undefined) {
            return {
              data: entries.slice(0, 1),
              nextCursor: "project-count-page-2",
              backwardsCursor: null,
            };
          }
          if (params.limit === 100 && params.archived === false) {
            return {
              data: entries.slice(1),
              nextCursor: null,
              backwardsCursor: null,
            };
          }
          return {
            data: entries,
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
    const authorizationCalls = new Map<string, number>();
    const ownershipCalls = new Map<string, number>();
    const persistedAuthorizationCalls = new Map<string, number>();
    const discoveryCalls = new Map<string, number>();
    let enabledProjectListCalls = 0;
    const count = (callsByCwd: Map<string, number>, value: string): void => {
      const key = validateWindowsCwd(value).toLocaleLowerCase("en-US");
      callsByCwd.set(key, (callsByCwd.get(key) ?? 0) + 1);
    };
    const control = new ControlSurface(manager, undefined, {
      requireConfigured: () => registry.requireConfigured(),
      authorizeCwd: (value) => {
        count(authorizationCalls, value);
        return registry.authorizeCwd(value);
      },
      authorizeTargetPath: (value, cwd) => registry.authorizeTargetPath(value, cwd),
      discoverCwd: (value, source) => {
        count(discoveryCalls, value);
        return registry.discoverCwd(value, source);
      },
      projectForCwd: (value, enabledOnly) => {
        count(ownershipCalls, value);
        return registry.projectForCwd(value, enabledOnly);
      },
      projectById: (projectId) => registry.projectById(projectId),
      listEnabledProjects: () => {
        enabledProjectListCalls += 1;
        return registry.listEnabledProjects();
      },
      authorizePersistedCwd: (value, source) => {
        count(persistedAuthorizationCalls, value);
        return registry.authorizePersistedCwd(value, source);
      },
    });

    const listed = await control.call("codex_threads", {}) as Record<string, unknown>;
    const visible = listed.data as Array<Record<string, unknown>>;
    assert.deepEqual(visible.map((thread) => thread.id), ["thread-a", "thread-a-duplicate"]);
    assert.equal(visible[0]?.project_id, enabledProject.project_id);
    assert.equal(runtime.authorizedWorkspace("thread-a-duplicate"), realpathSync.native(projectACwd));
    const projectACacheKey = validateWindowsCwd(projectACwd).toLocaleLowerCase("en-US");
    assert.equal(persistedAuthorizationCalls.get(projectACacheKey), 1);
    assert.equal(discoveryCalls.get(projectACacheKey), undefined);
    assert.equal(authorizationCalls.get(projectACacheKey), undefined);
    assert.equal(ownershipCalls.get(projectACacheKey), undefined);
    assert.equal(calls[0]?.params.archived, false);
    assert.equal(calls[0]?.params.useStateDbOnly, true);
    assert.deepEqual(calls[0]?.params.sourceKinds, [
      "cli",
      "vscode",
      "exec",
      "appServer",
      "subAgent",
      "subAgentReview",
      "subAgentCompact",
      "subAgentThreadSpawn",
      "subAgentOther",
      "unknown",
    ]);
    const pending = registry.projectForCwd(projectB, false);
    assert.equal(pending?.enabled, false);
    assert.equal(pending?.discovered_from, "codex_thread");

    calls.length = 0;
    authorizationCalls.clear();
    ownershipCalls.clear();
    persistedAuthorizationCalls.clear();
    const listedWithLegacyLimit = await control.call("codex_threads", {
      limit: 100,
    }) as Record<string, unknown>;
    assert.deepEqual(
      (listedWithLegacyLimit.data as Array<Record<string, unknown>>).map((thread) => thread.id),
      ["thread-a"],
    );
    assert.equal(calls[0]?.params.limit, 100);

    calls.length = 0;
    authorizationCalls.clear();
    ownershipCalls.clear();
    persistedAuthorizationCalls.clear();
    const projects = await control.call("codex_projects", {
      limit: 100,
    }) as Record<string, unknown>;
    assert.equal(projects.source, "local_codex_bridge_project_registry");
    assert.equal(projects.mode, "projects");
    assert.equal(projects.nextCursor, null);
    assert.deepEqual(projects.data, [
      {
        project_id: enabledProject.project_id,
        cwd: enabledProject.canonical_root,
        display_name: enabledProject.display_name,
        canonical_root: enabledProject.canonical_root,
        git_root: enabledProject.git_root,
        enabled: true,
        thread_count: 2,
      },
      {
        project_id: enabledProjectWithoutThreads.project_id,
        cwd: enabledProjectWithoutThreads.canonical_root,
        display_name: "Enabled Without Threads",
        canonical_root: enabledProjectWithoutThreads.canonical_root,
        git_root: enabledProjectWithoutThreads.git_root,
        enabled: true,
        thread_count: 0,
      },
    ].sort((left, right) => left.project_id.localeCompare(right.project_id)));
    assert.equal(JSON.stringify(projects).includes(projectB), false);
    assert.equal(JSON.stringify(projects).includes("private"), false);
    assert.equal(JSON.stringify(projects).includes("removed-project"), false);
    assert.equal(enabledProjectListCalls, 1);
    assert.equal(persistedAuthorizationCalls.get(projectACacheKey), 1);
    assert.equal(ownershipCalls.get(projectACacheKey), undefined);
    assert.deepEqual(
      calls.map((call) => [call.method, call.params.archived, call.params.cursor]),
      [
        ["thread/list", false, undefined],
        ["thread/list", false, "project-count-page-2"],
        ["thread/list", true, undefined],
      ],
    );
    await assert.rejects(
      control.call("codex_threads", { mode: "projects" }),
      /Unknown argument field: mode/,
    );

    const filtered = await control.call("codex_threads", {
      project_id: enabledProject.project_id,
    }) as Record<string, unknown>;
    assert.deepEqual(
      (filtered.data as Array<Record<string, unknown>>).map((thread) => thread.id),
      ["thread-a", "thread-a-duplicate"],
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
    const fastCallsBeforeRawCwd = persistedAuthorizationCalls.get(
      validateWindowsCwd(guessedProject).toLocaleLowerCase("en-US"),
    );
    await assert.rejects(
      control.call("codex_turn", { cwd: guessedProject, text: "must remain pending-free" }),
      /enabled project/,
    );
    assert.equal(calls.length, 0);
    assert.equal(registry.listProjects().length, beforeGuess);
    assert.equal(
      persistedAuthorizationCalls.get(
        validateWindowsCwd(guessedProject).toLocaleLowerCase("en-US"),
      ),
      fastCallsBeforeRawCwd,
    );
    assert.equal(
      authorizationCalls.get(validateWindowsCwd(guessedProject).toLocaleLowerCase("en-US")),
      1,
    );

    const started = await control.call("codex_turn", {
      cwd: projectACwd,
      text: "start in the enabled project",
    }) as Record<string, unknown>;
    assert.equal(started.project_id, enabledProject.project_id);
    assert.equal(runtime.authorizedWorkspace("new-thread"), realpathSync.native(projectACwd));

    new ProjectRegistry({ filePath: registryPath, environment: {} })
      .disable(enabledProject.project_id);
    const afterDisable = await control.call("codex_threads", { limit: 100 }) as {
      data: unknown[];
    };
    assert.deepEqual(afterDisable.data, []);
    await assert.rejects(
      control.call("codex_observe", { thread_id: "new-thread", cursor: 0 }),
      /No enabled projects|enabled project/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
