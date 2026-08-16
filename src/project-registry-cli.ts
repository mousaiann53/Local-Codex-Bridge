import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { AppServerManager } from "./app-server.js";
import {
  buildProjectRegistryGitEnvironment,
  inspectGitProject,
  ProjectRegistry,
  type ProjectRecord,
  type TrustedContainerRecord,
} from "./project-registry.js";
import { validateWindowsCwd } from "./workspace-roots.js";

const MAX_CONTAINER_DIRECTORIES = 20_000;
const MAX_CONTAINER_DEPTH = 12;
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".cache",
]);
const ALL_STABLE_THREAD_SOURCE_KINDS = [
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
] as const;

interface ThreadMetadata {
  id: string;
  cwd: string;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArgument(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function isWithin(container: string, candidate: string): boolean {
  const relative = path.win32.relative(container, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
}

export function isSupportedPersistedCwd(value: string): boolean {
  try {
    validateWindowsCwd(value);
    return true;
  } catch {
    return false;
  }
}

export function validateTrustedContainerRepository(
  container: TrustedContainerRecord,
  repository: string,
): string {
  const metadata = inspectGitProject(repository);
  const scannedRoot = realpathSync.native(repository);
  if (
    metadata.canonical_root.toLocaleLowerCase("en-US") !==
      scannedRoot.toLocaleLowerCase("en-US") ||
    !isWithin(container.canonical_root, metadata.canonical_root)
  ) {
    throw new Error("Trusted container repository resolves outside its scanned directory");
  }
  return metadata.canonical_root;
}

function discoverContainerRepositories(container: TrustedContainerRecord): string[] {
  const root = realpathSync.native(container.canonical_root);
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  const repositories: string[] = [];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited += 1;
    if (visited > MAX_CONTAINER_DIRECTORIES) {
      throw new Error(`Trusted container scan exceeded ${MAX_CONTAINER_DIRECTORIES} directories`);
    }
    const entries = readdirSync(current.directory, { withFileTypes: true });
    if (entries.some((entry) => entry.name.toLocaleLowerCase("en-US") === ".git")) {
      repositories.push(current.directory);
      continue;
    }
    if (current.depth >= MAX_CONTAINER_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORY_NAMES.has(entry.name.toLocaleLowerCase("en-US"))) {
        continue;
      }
      const child = path.win32.join(current.directory, entry.name);
      const stats = lstatSync(child);
      if (stats.isSymbolicLink()) continue;
      const canonical = realpathSync.native(child);
      if (!isWithin(root, canonical)) continue;
      queue.push({ directory: canonical, depth: current.depth + 1 });
    }
  }
  return repositories;
}

function discoverGitWorktrees(project: ProjectRecord): string[] {
  let output: string;
  try {
    output = execFileSync(
      "git",
      [
        "-c",
        `safe.directory=${project.canonical_root}`,
        "-C",
        project.canonical_root,
        "worktree",
        "list",
        "--porcelain",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: buildProjectRegistryGitEnvironment(),
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      },
    );
  } catch {
    return [];
  }
  return output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

async function persistedThreadMetadata(): Promise<ThreadMetadata[]> {
  const appServer = new AppServerManager();
  const threads = new Map<string, ThreadMetadata>();
  try {
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 10_000; pageIndex += 1) {
        const response = asRecord(await appServer.request("thread/list", {
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived,
          useStateDbOnly: true,
          sourceKinds: ALL_STABLE_THREAD_SOURCE_KINDS,
          ...(cursor ? { cursor } : {}),
        }), "thread/list response");
        if (!Array.isArray(response.data)) {
          throw new Error("thread/list response has no data array");
        }
        for (const value of response.data) {
          const thread = asRecord(value, "thread/list item");
          if (typeof thread.id === "string" && typeof thread.cwd === "string") {
            threads.set(thread.id, { id: thread.id, cwd: thread.cwd });
          }
        }
        cursor = typeof response.nextCursor === "string" && response.nextCursor.length > 0
          ? response.nextCursor
          : undefined;
        if (!cursor) break;
        if (pageIndex === 9_999) throw new Error("thread/list pagination exceeded its bound");
      }
    }
  } finally {
    await appServer.close();
  }
  return [...threads.values()];
}

function projectReport(
  registry: ProjectRegistry,
  threadCounts = new Map<string, number>(),
): unknown {
  return {
    registry_path: registry.filePath,
    projects: registry.listProjects().map((project) => ({
      ...project,
      thread_count: threadCounts.get(project.project_id) ?? 0,
    })),
    trusted_containers: registry.listContainers(),
  };
}

async function scan(registry: ProjectRegistry): Promise<unknown> {
  const threads = await persistedThreadMetadata();
  let threadDiscovered = 0;
  for (const thread of threads) {
    if (!isSupportedPersistedCwd(thread.cwd)) continue;
    if (registry.discoverCwd(thread.cwd, "codex_thread")) threadDiscovered += 1;
  }

  let worktreeDiscovered = 0;
  for (const project of registry.listProjects()) {
    for (const worktree of discoverGitWorktrees(project)) {
      if (registry.discoverCwd(worktree, "git_worktree")) worktreeDiscovered += 1;
    }
  }

  let containerDiscovered = 0;
  for (const container of registry.listContainers(true)) {
    for (const repository of discoverContainerRepositories(container)) {
      registry.add(validateTrustedContainerRepository(container, repository), {
        discoveredFrom: `trusted_container:${container.container_id}`,
      });
      containerDiscovered += 1;
    }
  }

  const threadCounts = new Map<string, number>();
  for (const thread of threads) {
    if (!isSupportedPersistedCwd(thread.cwd)) continue;
    const project = registry.projectForCwd(thread.cwd, false);
    if (project) {
      threadCounts.set(project.project_id, (threadCounts.get(project.project_id) ?? 0) + 1);
    }
  }
  return {
    ...projectReport(registry, threadCounts) as Record<string, unknown>,
    scan: {
      persisted_threads: threads.length,
      thread_projects_seen: threadDiscovered,
      worktrees_seen: worktreeDiscovered,
      trusted_container_repositories_seen: containerDiscovered,
    },
  };
}

async function main(): Promise<void> {
  const [action = "projects", value, ...flags] = process.argv.slice(2);
  const registry = new ProjectRegistry();
  let result: unknown;
  switch (action) {
    case "projects":
      result = projectReport(registry);
      break;
    case "project-add": {
      const target = requiredArgument(value, "project path");
      result = flags.includes("--container")
        ? registry.addContainer(target)
        : registry.add(target, { discoveredFrom: "manual" });
      break;
    }
    case "project-remove": {
      const id = requiredArgument(value, "project or container id");
      result = id.startsWith("container_")
        ? registry.removeContainer(id)
        : registry.remove(id);
      break;
    }
    case "project-enable": {
      const id = requiredArgument(value, "project or container id");
      result = id.startsWith("container_")
        ? registry.enableContainer(id)
        : registry.enable(id);
      break;
    }
    case "project-disable": {
      const id = requiredArgument(value, "project or container id");
      result = id.startsWith("container_")
        ? registry.disableContainer(id)
        : registry.disable(id);
      break;
    }
    case "project-scan":
      result = await scan(registry);
      break;
    default:
      throw new Error(`Unknown project registry action: ${action}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`local-codex-bridge-projects: ${message}\n`);
    process.exitCode = 1;
  });
}
