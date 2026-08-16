import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

import {
  ALLOWED_ROOTS_ENV,
  WorkspaceRootPolicy,
  validateWindowsCwd,
} from "./workspace-roots.js";

export const PROJECT_REGISTRY_PATH_ENV = "LOCAL_CODEX_BRIDGE_PROJECT_REGISTRY";
export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;

const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 500;
const DEFAULT_LOCK_RETRY_COUNT = 80;
const DEFAULT_LOCK_RETRY_DELAY_MS = 25;
const DEFAULT_STALE_LOCK_MS = 120_000;

const GIT_ENVIRONMENT_ALLOWLIST = new Set([
  "APPDATA",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

export interface ProjectRecord {
  project_id: string;
  display_name: string;
  canonical_root: string;
  git_root: string;
  worktree_identity: string;
  enabled: boolean;
  discovered_from: string;
  created_at: string;
  last_seen_at: string;
}

export interface GitProjectMetadata {
  canonical_root: string;
  git_root: string;
  worktree_identity: string;
}

export interface AuthorizedProject {
  project: ProjectRecord;
  canonical_cwd: string;
}

export interface TrustedContainerRecord {
  container_id: string;
  display_name: string;
  canonical_root: string;
  enabled: boolean;
  created_at: string;
  last_seen_at: string;
}

export interface AddProjectOptions {
  displayName?: string;
  discoveredFrom?: string;
}

export interface ProjectRegistryOptions {
  filePath?: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  lockRetryCount?: number;
  lockRetryDelayMs?: number;
  staleLockMs?: number;
}

interface RegistryDocument {
  schema_version: 1;
  projects: ProjectRecord[];
  trusted_containers: TrustedContainerRecord[];
}

interface LockDocument {
  pid: number;
  token: string;
  created_at: string;
}

export function buildProjectRegistryGitEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: "0" };
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && GIT_ENVIRONMENT_ALLOWLIST.has(key.toLocaleUpperCase("en-US"))) {
      child[key] = value;
    }
  }
  return child;
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > MAX_TEXT_LENGTH) {
    throw new Error(`${label} exceeds ${MAX_TEXT_LENGTH} characters`);
  }
  return normalized;
}

function timestamp(value: unknown, label: string): string {
  const normalized = boundedString(value, label);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return normalized;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function sleepSynchronously(milliseconds: number): void {
  if (milliseconds <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function parseLockDocument(value: string): LockDocument | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.pid !== "number" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.token !== "string" ||
      !/^[a-f0-9-]{36}$/.test(record.token) ||
      typeof record.created_at !== "string" ||
      Number.isNaN(Date.parse(record.created_at))
    ) {
      return null;
    }
    return {
      pid: record.pid,
      token: record.token,
      created_at: record.created_at,
    };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function cloneRecord(record: ProjectRecord): ProjectRecord {
  return { ...record };
}

function parseRecord(value: unknown): ProjectRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("project registry entry must be an object");
  }
  const record = value as Record<string, unknown>;
  const projectId = boundedString(record.project_id, "project_id");
  if (!/^project_[a-f0-9]{32}$/.test(projectId)) {
    throw new Error("project_id is invalid");
  }
  if (typeof record.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  return {
    project_id: projectId,
    display_name: boundedString(record.display_name, "display_name"),
    canonical_root: validateWindowsCwd(
      boundedString(record.canonical_root, "canonical_root"),
    ),
    git_root: validateWindowsCwd(boundedString(record.git_root, "git_root")),
    worktree_identity: boundedString(record.worktree_identity, "worktree_identity"),
    enabled: record.enabled,
    discovered_from: boundedString(record.discovered_from, "discovered_from"),
    created_at: timestamp(record.created_at, "created_at"),
    last_seen_at: timestamp(record.last_seen_at, "last_seen_at"),
  };
}

function cloneContainer(container: TrustedContainerRecord): TrustedContainerRecord {
  return { ...container };
}

function parseContainer(value: unknown): TrustedContainerRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("trusted container entry must be an object");
  }
  const record = value as Record<string, unknown>;
  const containerId = boundedString(record.container_id, "container_id");
  if (!/^container_[a-f0-9]{32}$/.test(containerId)) {
    throw new Error("container_id is invalid");
  }
  if (typeof record.enabled !== "boolean") {
    throw new Error("trusted container enabled must be a boolean");
  }
  return {
    container_id: containerId,
    display_name: boundedString(record.display_name, "container display_name"),
    canonical_root: validateWindowsCwd(
      boundedString(record.canonical_root, "container canonical_root"),
    ),
    enabled: record.enabled,
    created_at: timestamp(record.created_at, "container created_at"),
    last_seen_at: timestamp(record.last_seen_at, "container last_seen_at"),
  };
}

function parseDocument(value: unknown): RegistryDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("project registry must be an object");
  }
  const document = value as Record<string, unknown>;
  if (document.schema_version !== PROJECT_REGISTRY_SCHEMA_VERSION) {
    throw new Error("Unsupported project registry schema_version");
  }
  if (!Array.isArray(document.projects)) {
    throw new Error("project registry projects must be an array");
  }
  const projects = document.projects.map(parseRecord);
  if (new Set(projects.map((project) => project.project_id)).size !== projects.length) {
    throw new Error("project registry contains duplicate project_id values");
  }
  if (
    new Set(projects.map((project) => project.worktree_identity)).size !== projects.length
  ) {
    throw new Error("project registry contains duplicate worktree_identity values");
  }
  if (
    new Set(projects.map((project) => windowsPathKey(project.canonical_root))).size !==
    projects.length
  ) {
    throw new Error("project registry contains duplicate canonical_root values");
  }
  const rawContainers = document.trusted_containers ?? [];
  if (!Array.isArray(rawContainers)) {
    throw new Error("project registry trusted_containers must be an array");
  }
  const trustedContainers = rawContainers.map(parseContainer);
  if (
    new Set(trustedContainers.map((container) => container.container_id)).size !==
    trustedContainers.length
  ) {
    throw new Error("project registry contains duplicate container_id values");
  }
  return {
    schema_version: 1,
    projects,
    trusted_containers: trustedContainers,
  };
}

function canonicalDirectory(value: string, label: string): string {
  const normalized = validateWindowsCwd(value);
  try {
    const canonical = validateWindowsCwd(realpathSync.native(normalized));
    if (!statSync(canonical).isDirectory()) {
      throw new Error("not a directory");
    }
    return canonical;
  } catch {
    throw new Error(`${label} must resolve to an existing local directory`);
  }
}

function windowsPathKey(value: string): string {
  return path.win32.normalize(value).toLocaleLowerCase("en-US");
}

function recordMatchesMetadata(
  record: ProjectRecord,
  metadata: GitProjectMetadata,
): boolean {
  return (
    windowsPathKey(record.canonical_root) === windowsPathKey(metadata.canonical_root) &&
    windowsPathKey(record.git_root) === windowsPathKey(metadata.git_root) &&
    record.worktree_identity === metadata.worktree_identity
  );
}

function gitPath(cwd: string, argument: string, safeDirectory = cwd): string {
  let output: string;
  try {
    output = execFileSync(
      "git",
      [
        "-c",
        `safe.directory=${safeDirectory}`,
        "-C",
        cwd,
        "rev-parse",
        "--path-format=absolute",
        argument,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: buildProjectRegistryGitEnvironment(),
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    throw new Error("cwd must belong to a real Git repository or worktree");
  }
  return canonicalDirectory(output.trim(), "Git metadata path");
}

function filesystemIdentity(value: string): string {
  const stats = statSync(value, { bigint: true });
  if (!stats.isDirectory() || stats.ino === 0n) {
    throw new Error("stable directory identity is unavailable");
  }
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

export function inspectGitProject(cwd: string): GitProjectMetadata {
  const canonicalCwd = canonicalDirectory(cwd, "cwd");
  const worktreeRoot = gitPath(canonicalCwd, "--show-toplevel");
  const commonGitDirectory = gitPath(
    canonicalCwd,
    "--git-common-dir",
    worktreeRoot,
  );
  const worktreeGitDirectory = gitPath(canonicalCwd, "--git-dir", worktreeRoot);
  const gitRoot = path.win32.basename(commonGitDirectory).toLocaleLowerCase("en-US") === ".git"
    ? canonicalDirectory(path.win32.dirname(commonGitDirectory), "Git repository root")
    : commonGitDirectory;
  const identityMaterial = [
    worktreeRoot.toLocaleLowerCase("en-US"),
    filesystemIdentity(worktreeRoot),
    commonGitDirectory.toLocaleLowerCase("en-US"),
    filesystemIdentity(commonGitDirectory),
    worktreeGitDirectory.toLocaleLowerCase("en-US"),
    filesystemIdentity(worktreeGitDirectory),
  ].join("\0");
  return {
    canonical_root: worktreeRoot,
    git_root: gitRoot,
    worktree_identity: `worktree_${createHash("sha256")
      .update(identityMaterial, "utf8")
      .digest("hex")}`,
  };
}

function projectId(metadata: GitProjectMetadata): string {
  return `project_${createHash("sha256")
    .update(metadata.worktree_identity, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function containerMetadata(containerPath: string): {
  canonicalRoot: string;
  containerId: string;
} {
  const normalized = validateWindowsCwd(containerPath);
  if (path.win32.dirname(normalized) === normalized) {
    throw new Error("A drive root cannot be registered as a trusted project container");
  }
  const canonicalRoot = canonicalDirectory(normalized, "trusted container");
  if (path.win32.dirname(canonicalRoot) === canonicalRoot) {
    throw new Error("A drive root cannot be registered as a trusted project container");
  }
  const identity = `${canonicalRoot.toLocaleLowerCase("en-US")}\0${filesystemIdentity(
    canonicalRoot,
  )}`;
  return {
    canonicalRoot,
    containerId: `container_${createHash("sha256")
      .update(identity, "utf8")
      .digest("hex")
      .slice(0, 32)}`,
  };
}

export function resolveProjectRegistryPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment[PROJECT_REGISTRY_PATH_ENV]?.trim();
  if (configured) {
    if (!path.win32.isAbsolute(configured)) {
      throw new Error(`${PROJECT_REGISTRY_PATH_ENV} must be an absolute Windows path`);
    }
    return path.win32.normalize(configured);
  }
  const localAppData = environment.LOCALAPPDATA?.trim();
  const userProfile = environment.USERPROFILE?.trim() || homedir();
  const base = localAppData || path.win32.join(userProfile, "AppData", "Local");
  if (!path.win32.isAbsolute(base)) {
    throw new Error("Unable to resolve an absolute LocalAppData directory");
  }
  return path.win32.join(base, "LocalCodexBridge", "projects.json");
}

export class ProjectRegistry {
  readonly filePath: string;
  readonly #now: () => Date;
  readonly #ceiling: WorkspaceRootPolicy | null;
  readonly #lockRetryCount: number;
  readonly #lockRetryDelayMs: number;
  readonly #staleLockMs: number;

  constructor(options: ProjectRegistryOptions = {}) {
    const environment = options.environment ?? process.env;
    const filePath = options.filePath ?? resolveProjectRegistryPath(environment);
    if (!path.win32.isAbsolute(filePath)) {
      throw new Error("Project registry path must be an absolute Windows path");
    }
    this.filePath = path.win32.normalize(filePath);
    this.#now = options.now ?? (() => new Date());
    this.#lockRetryCount = this.#boundedLockOption(
      options.lockRetryCount ?? DEFAULT_LOCK_RETRY_COUNT,
      "lockRetryCount",
      0,
      1_000,
    );
    this.#lockRetryDelayMs = this.#boundedLockOption(
      options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
      "lockRetryDelayMs",
      0,
      1_000,
    );
    this.#staleLockMs = this.#boundedLockOption(
      options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
      "staleLockMs",
      1,
      24 * 60 * 60 * 1_000,
    );
    const rawCeiling = environment[ALLOWED_ROOTS_ENV]?.trim();
    this.#ceiling = rawCeiling
      ? WorkspaceRootPolicy.fromEnvironment(environment)
      : null;
  }

  get hasStaticCeiling(): boolean {
    return this.#ceiling !== null;
  }

  list(): ProjectRecord[] {
    return this.#read().projects.map(cloneRecord);
  }

  listProjects(): ProjectRecord[] {
    return this.list();
  }

  listEnabledProjects(): ProjectRecord[] {
    return this.#read().projects
      .filter((project) => project.enabled)
      .map((project) => {
        const metadata = inspectGitProject(project.canonical_root);
        if (!recordMatchesMetadata(project, metadata)) {
          throw new Error("Enabled project Git identity changed; rediscover it before use");
        }
        this.#requireInsideCeiling(metadata.canonical_root);
        return cloneRecord(project);
      });
  }

  listContainers(enabledOnly = false): TrustedContainerRecord[] {
    return this.#read().trusted_containers
      .filter((container) => !enabledOnly || container.enabled)
      .map(cloneContainer);
  }

  containerById(rawContainerId: string): TrustedContainerRecord | null {
    const id = boundedString(rawContainerId, "container_id");
    const container = this.#read().trusted_containers.find(
      (candidate) => candidate.container_id === id,
    );
    return container ? cloneContainer(container) : null;
  }

  get(rawProjectId: string): ProjectRecord | null {
    const id = boundedString(rawProjectId, "project_id");
    const project = this.#read().projects.find((candidate) => candidate.project_id === id);
    return project ? cloneRecord(project) : null;
  }

  projectById(projectId: string): ProjectRecord | null {
    return this.get(projectId);
  }

  requireConfigured(): void {
    if (!this.#read().projects.some((project) => project.enabled)) {
      throw new Error("No enabled projects are configured; Codex execution is disabled");
    }
  }

  add(projectPath: string, options: AddProjectOptions = {}): ProjectRecord {
    const metadata = inspectGitProject(projectPath);
    this.#requireInsideCeiling(metadata.canonical_root);
    return this.#upsert(metadata, {
      enabled: true,
      ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
      discoveredFrom: options.discoveredFrom ?? "manual",
    });
  }

  discover(projectPath: string, discoveredFrom: string): ProjectRecord {
    const metadata = inspectGitProject(projectPath);
    return this.#upsert(metadata, {
      enabled: false,
      discoveredFrom,
    });
  }

  discoverCwd(projectPath: string, discoveredFrom: string): ProjectRecord | null {
    try {
      return this.discover(projectPath, discoveredFrom);
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "cwd must belong to a real Git repository or worktree",
          "cwd must resolve to an existing local directory",
        ].includes(error.message)
      ) {
        return null;
      }
      throw error;
    }
  }

  enable(rawProjectId: string): ProjectRecord {
    const id = boundedString(rawProjectId, "project_id");
    return this.#mutate((document) => {
      const index = document.projects.findIndex((project) => project.project_id === id);
      const existing = document.projects[index];
      if (!existing) {
        throw new Error("Unknown project_id");
      }
      const metadata = inspectGitProject(existing.canonical_root);
      if (!recordMatchesMetadata(existing, metadata)) {
        throw new Error("Project Git identity changed; rediscover it before enabling");
      }
      this.#requireInsideCeiling(metadata.canonical_root);
      const updated: ProjectRecord = {
        ...existing,
        enabled: true,
        last_seen_at: this.#timestamp(),
      };
      document.projects[index] = updated;
      return cloneRecord(updated);
    });
  }

  disable(rawProjectId: string): ProjectRecord {
    return this.#setEnabled(rawProjectId, false);
  }

  remove(rawProjectId: string): ProjectRecord {
    const id = boundedString(rawProjectId, "project_id");
    return this.#mutate((document) => {
      const index = document.projects.findIndex((project) => project.project_id === id);
      const removed = document.projects[index];
      if (!removed) {
        throw new Error("Unknown project_id");
      }
      document.projects.splice(index, 1);
      return cloneRecord(removed);
    });
  }

  addContainer(containerPath: string, displayName?: string): TrustedContainerRecord {
    const metadata = containerMetadata(containerPath);
    this.#requireInsideCeiling(metadata.canonicalRoot);
    return this.#mutate((document) => {
      const index = document.trusted_containers.findIndex(
        (container) => container.container_id === metadata.containerId,
      );
      const now = this.#timestamp();
      const existing = document.trusted_containers[index];
      if (existing) {
        const updated: TrustedContainerRecord = {
          ...existing,
          ...(displayName === undefined
            ? {}
            : { display_name: boundedString(displayName, "container display_name") }),
          enabled: true,
          last_seen_at: now,
        };
        document.trusted_containers[index] = updated;
        return cloneContainer(updated);
      }
      const created: TrustedContainerRecord = {
        container_id: metadata.containerId,
        display_name: displayName === undefined
          ? boundedString(path.win32.basename(metadata.canonicalRoot), "container display_name")
          : boundedString(displayName, "container display_name"),
        canonical_root: metadata.canonicalRoot,
        enabled: true,
        created_at: now,
        last_seen_at: now,
      };
      document.trusted_containers.push(created);
      document.trusted_containers.sort((left, right) =>
        left.container_id.localeCompare(right.container_id),
      );
      return cloneContainer(created);
    });
  }

  enableContainer(rawContainerId: string): TrustedContainerRecord {
    return this.#setContainerEnabled(rawContainerId, true);
  }

  disableContainer(rawContainerId: string): TrustedContainerRecord {
    return this.#setContainerEnabled(rawContainerId, false);
  }

  removeContainer(rawContainerId: string): TrustedContainerRecord {
    const id = boundedString(rawContainerId, "container_id");
    return this.#mutate((document) => {
      const index = document.trusted_containers.findIndex(
        (container) => container.container_id === id,
      );
      const removed = document.trusted_containers[index];
      if (!removed) {
        throw new Error("Unknown container_id");
      }
      document.trusted_containers.splice(index, 1);
      return cloneContainer(removed);
    });
  }

  projectForCwd(cwd: string, enabledOnly = true): ProjectRecord | null {
    let metadata: GitProjectMetadata;
    try {
      metadata = inspectGitProject(cwd);
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "cwd must belong to a real Git repository or worktree",
          "cwd must resolve to an existing local directory",
        ].includes(error.message)
      ) {
        return null;
      }
      throw error;
    }
    const project = this.#read().projects.find(
      (candidate) =>
        (!enabledOnly || candidate.enabled) &&
        recordMatchesMetadata(candidate, metadata),
    );
    if (project && enabledOnly && this.#ceiling) {
      try {
        this.#ceiling.authorizeCwd(metadata.canonical_root);
      } catch {
        return null;
      }
    }
    return project ? cloneRecord(project) : null;
  }

  authorizePersistedCwd(cwd: string, discoveredFrom: string): AuthorizedProject | null {
    let metadata: GitProjectMetadata;
    try {
      metadata = inspectGitProject(cwd);
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "cwd must belong to a real Git repository or worktree",
          "cwd must resolve to an existing local directory",
        ].includes(error.message)
      ) {
        return null;
      }
      throw error;
    }
    const projects = this.#read().projects;
    const id = projectId(metadata);
    const project = projects.find((candidate) =>
      candidate.project_id === id ||
      candidate.worktree_identity === metadata.worktree_identity ||
      windowsPathKey(candidate.canonical_root) === windowsPathKey(metadata.canonical_root)
    );
    if (!project) {
      this.#upsert(metadata, {
        enabled: false,
        discoveredFrom,
      });
      return null;
    }
    if (!recordMatchesMetadata(project, metadata)) {
      throw new Error("Persisted project metadata does not match the live Git worktree");
    }
    if (!project.enabled) {
      return null;
    }
    const canonicalCwd = new WorkspaceRootPolicy([
      project.canonical_root,
    ]).authorizeCwd(cwd);
    this.#requireInsideCeiling(metadata.canonical_root);
    return { project: cloneRecord(project), canonical_cwd: canonicalCwd };
  }

  authorizeProjectCwd(cwd: string): AuthorizedProject {
    this.requireConfigured();
    const projects = this.#read().projects.filter((candidate) => candidate.enabled);
    for (const project of projects) {
      try {
        const current = inspectGitProject(project.canonical_root);
        if (!recordMatchesMetadata(project, current)) continue;
        const canonicalCwd = new WorkspaceRootPolicy([
          project.canonical_root,
        ]).authorizeCwd(cwd);
        const metadata = inspectGitProject(canonicalCwd);
        if (!recordMatchesMetadata(project, metadata)) continue;
        this.#requireInsideCeiling(metadata.canonical_root);
        return { project: cloneRecord(project), canonical_cwd: canonicalCwd };
      } catch {
        continue;
      }
    }
    throw new Error("cwd does not belong to an enabled project");
  }

  authorizeCwd(cwd: string): string {
    return this.authorizeProjectCwd(cwd).canonical_cwd;
  }

  authorizeTargetPath(value: string, cwd?: string): string {
    if (!path.win32.isAbsolute(value) && cwd === undefined) {
      throw new Error("relative target path requires an authorized cwd");
    }
    this.requireConfigured();
    if (cwd !== undefined) {
      const authorization = this.authorizeProjectCwd(cwd);
      const projectPolicy = new WorkspaceRootPolicy([
        authorization.project.canonical_root,
      ]);
      const target = projectPolicy.authorizeTargetPath(value, authorization.canonical_cwd);
      if (this.#ceiling) {
        this.#ceiling.authorizeTargetPath(target, authorization.canonical_cwd);
      }
      return target;
    }
    for (const project of this.#read().projects.filter((candidate) => candidate.enabled)) {
      try {
        const current = inspectGitProject(project.canonical_root);
        if (!recordMatchesMetadata(project, current)) {
          continue;
        }
        const target = new WorkspaceRootPolicy([
          project.canonical_root,
        ]).authorizeTargetPath(value);
        if (this.#ceiling) {
          this.#ceiling.authorizeTargetPath(target);
        }
        return target;
      } catch {
        // Another enabled project may own this absolute target.
      }
    }
    throw new Error("target path is outside the enabled projects");
  }

  #upsert(
    metadata: GitProjectMetadata,
    input: {
      enabled: boolean;
      displayName?: string;
      discoveredFrom: string;
    },
  ): ProjectRecord {
    return this.#mutate((document) => {
      const id = projectId(metadata);
      const index = document.projects.findIndex((project) => project.project_id === id);
      const now = this.#timestamp();
      const existing = document.projects[index];
      if (existing) {
        if (!recordMatchesMetadata(existing, metadata)) {
          throw new Error("Persisted project metadata does not match the live Git worktree");
        }
        const updated: ProjectRecord = {
          ...existing,
          display_name: input.displayName === undefined
            ? existing.display_name
            : boundedString(input.displayName, "display_name"),
          enabled: existing.enabled || input.enabled,
          last_seen_at: now,
        };
        document.projects[index] = updated;
        return cloneRecord(updated);
      }
      const displayName = input.displayName === undefined
        ? path.win32.basename(metadata.canonical_root)
        : boundedString(input.displayName, "display_name");
      const created: ProjectRecord = {
        project_id: id,
        display_name: boundedString(displayName, "display_name"),
        canonical_root: metadata.canonical_root,
        git_root: metadata.git_root,
        worktree_identity: metadata.worktree_identity,
        enabled: input.enabled,
        discovered_from: boundedString(input.discoveredFrom, "discovered_from"),
        created_at: now,
        last_seen_at: now,
      };
      document.projects.push(created);
      document.projects.sort((left, right) => left.project_id.localeCompare(right.project_id));
      return cloneRecord(created);
    });
  }

  #setEnabled(rawProjectId: string, enabled: boolean): ProjectRecord {
    const id = boundedString(rawProjectId, "project_id");
    return this.#mutate((document) => {
      const index = document.projects.findIndex((project) => project.project_id === id);
      const existing = document.projects[index];
      if (!existing) {
        throw new Error("Unknown project_id");
      }
      const updated = { ...existing, enabled };
      document.projects[index] = updated;
      return cloneRecord(updated);
    });
  }

  #setContainerEnabled(
    rawContainerId: string,
    enabled: boolean,
  ): TrustedContainerRecord {
    const id = boundedString(rawContainerId, "container_id");
    return this.#mutate((document) => {
      const index = document.trusted_containers.findIndex(
        (container) => container.container_id === id,
      );
      const existing = document.trusted_containers[index];
      if (!existing) {
        throw new Error("Unknown container_id");
      }
      if (enabled) {
        const current = containerMetadata(existing.canonical_root);
        if (current.containerId !== existing.container_id) {
          throw new Error("Trusted container identity changed; add it again before enabling");
        }
        this.#requireInsideCeiling(current.canonicalRoot);
      }
      const updated = { ...existing, enabled };
      document.trusted_containers[index] = updated;
      return cloneContainer(updated);
    });
  }

  #boundedLockOption(
    value: number,
    label: string,
    minimum: number,
    maximum: number,
  ): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
  }

  #mutate<T>(operation: (document: RegistryDocument) => T): T {
    const token = this.#acquireLock();
    try {
      const document = this.#read();
      const result = operation(document);
      this.#assertLockOwnership(token);
      this.#write(document, token);
      return result;
    } finally {
      this.#releaseLock(token);
    }
  }

  #acquireLock(): string {
    mkdirSync(path.win32.dirname(this.filePath), { recursive: true });
    for (let attempt = 0; attempt <= this.#lockRetryCount; attempt += 1) {
      const token = randomUUID();
      const lock: LockDocument = {
        pid: process.pid,
        token,
        created_at: new Date().toISOString(),
      };
      try {
        writeFileSync(this.#lockPath(), `${JSON.stringify(lock)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        return token;
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw error;
        }
      }
      if (this.#reapStaleLock()) {
        continue;
      }
      if (attempt === this.#lockRetryCount) {
        throw new Error("Project registry is busy; lock retry limit exceeded");
      }
      sleepSynchronously(this.#lockRetryDelayMs);
    }
    throw new Error("Project registry is busy; lock retry limit exceeded");
  }

  #reapStaleLock(): boolean {
    const lockPath = this.#lockPath();
    let observedPayload: string;
    let modifiedAt: number;
    try {
      observedPayload = readFileSync(lockPath, "utf8");
      modifiedAt = statSync(lockPath).mtimeMs;
    } catch {
      return true;
    }
    if (Date.now() - modifiedAt <= this.#staleLockMs) {
      return false;
    }
    const observed = parseLockDocument(observedPayload);
    if (observed && processIsAlive(observed.pid)) {
      return false;
    }

    const quarantine = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
    try {
      renameSync(lockPath, quarantine);
    } catch {
      return true;
    }
    try {
      const movedPayload = readFileSync(quarantine, "utf8");
      if (movedPayload !== observedPayload) {
        try {
          renameSync(quarantine, lockPath);
        } catch {
          rmSync(quarantine, { force: true });
        }
        return false;
      }
      rmSync(quarantine, { force: true });
      return true;
    } finally {
      rmSync(quarantine, { force: true });
    }
  }

  #assertLockOwnership(token: string): void {
    let lock: LockDocument | null;
    try {
      lock = parseLockDocument(readFileSync(this.#lockPath(), "utf8"));
    } catch {
      lock = null;
    }
    if (!lock || lock.pid !== process.pid || lock.token !== token) {
      throw new Error("Project registry lock ownership was lost before commit");
    }
  }

  #releaseLock(token: string): void {
    try {
      const lock = parseLockDocument(readFileSync(this.#lockPath(), "utf8"));
      if (lock?.pid === process.pid && lock.token === token) {
        rmSync(this.#lockPath(), { force: true });
      }
    } catch {
      // A lost or already-reaped lock must never cause removal of another owner's lock.
    }
  }

  #lockPath(): string {
    return `${this.filePath}.lock`;
  }

  #timestamp(): string {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
      throw new Error("Project registry clock returned an invalid Date");
    }
    return value.toISOString();
  }

  #requireInsideCeiling(cwd: string): void {
    this.#ceiling?.authorizeCwd(cwd);
  }

  #read(): RegistryDocument {
    let payload: Buffer;
    try {
      const stats = statSync(this.filePath);
      if (!stats.isFile()) {
        throw new Error("Project registry path is not a regular file");
      }
      if (stats.size > MAX_REGISTRY_BYTES) {
        throw new Error("Project registry exceeds the bounded size limit");
      }
      payload = readFileSync(this.filePath);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return { schema_version: 1, projects: [], trusted_containers: [] };
      }
      throw error;
    }
    if (payload.byteLength > MAX_REGISTRY_BYTES) {
      throw new Error("Project registry exceeds the bounded size limit");
    }
    try {
      return parseDocument(JSON.parse(payload.toString("utf8")) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Project registry is not valid JSON");
      }
      throw error;
    }
  }

  #write(document: RegistryDocument, lockToken: string): void {
    const directory = path.win32.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_REGISTRY_BYTES) {
      throw new Error("Project registry exceeds the bounded size limit");
    }
    try {
      writeFileSync(temporary, payload, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      this.#assertLockOwnership(lockToken);
      renameSync(temporary, this.filePath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
