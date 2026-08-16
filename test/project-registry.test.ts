import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  ProjectRegistry,
  buildProjectRegistryGitEnvironment,
  inspectGitProject,
  resolveProjectRegistryPath,
} from "../src/project-registry.js";
import {
  isSupportedPersistedCwd,
  validateTrustedContainerRepository,
} from "../src/project-registry-cli.js";
import { ALLOWED_ROOTS_ENV } from "../src/workspace-roots.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initializeRepository(parent: string, name: string): string {
  const repository = path.join(parent, name);
  mkdirSync(repository, { recursive: true });
  git(repository, "init", "--quiet");
  return repository;
}

function temporaryRegistry(
  directory: string,
  options: {
    environment?: NodeJS.ProcessEnv;
    now?: () => Date;
  } = {},
): ProjectRegistry {
  return new ProjectRegistry({
    filePath: path.join(directory, "state", "projects.json"),
    ...options,
  });
}

test("default registry path shares the existing LocalCodexBridge state directory", () => {
  assert.equal(
    resolveProjectRegistryPath({ LOCALAPPDATA: "D:\\LocalState" }),
    "D:\\LocalState\\LocalCodexBridge\\projects.json",
  );
  assert.equal(
    resolveProjectRegistryPath({ USERPROFILE: "C:\\People\\Mousai" }),
    "C:\\People\\Mousai\\AppData\\Local\\LocalCodexBridge\\projects.json",
  );
});

test("Git inspection receives a minimal environment without inherited secrets or overrides", () => {
  const environment = buildProjectRegistryGitEnvironment({
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Tools",
    TEMP: "C:\\Temp",
    SYNTHETIC_API_TOKEN: "must-not-cross",
    GIT_CONFIG_GLOBAL: "C:\\private\\gitconfig",
    GIT_SSH_COMMAND: "private-helper",
  });
  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.PATH, "C:\\Tools");
  assert.equal(environment.TEMP, "C:\\Temp");
  assert.equal(environment.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(environment.SYNTHETIC_API_TOKEN, undefined);
  assert.equal(environment.GIT_CONFIG_GLOBAL, undefined);
  assert.equal(environment.GIT_SSH_COMMAND, undefined);
});

test("Git inspection resolves a child cwd to its canonical worktree root", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "project-registry-inspect-"));
  try {
    const repository = initializeRepository(directory, "ExampleProject");
    const child = path.join(repository, "src", "nested");
    mkdirSync(child, { recursive: true });
    const metadata = inspectGitProject(child);
    assert.equal(metadata.canonical_root, metadata.git_root);
    assert.equal(
      metadata.canonical_root.toLocaleLowerCase("en-US"),
      repository.toLocaleLowerCase("en-US"),
    );
    assert.match(metadata.worktree_identity, /^worktree_[a-f0-9]{64}$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("linked worktrees retain the common repository root and a distinct worktree identity", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "project-registry-worktree-"));
  try {
    const repository = initializeRepository(directory, "main");
    git(repository, "config", "user.name", "Registry Test");
    git(repository, "config", "user.email", "registry-test@example.invalid");
    writeFileSync(path.join(repository, "fixture.txt"), "synthetic fixture\n", "utf8");
    git(repository, "add", "fixture.txt");
    git(repository, "commit", "--quiet", "-m", "fixture");
    const linked = path.join(directory, "linked");
    git(repository, "worktree", "add", "--quiet", "-b", "registry-linked", linked);

    const mainMetadata = inspectGitProject(repository);
    const linkedMetadata = inspectGitProject(linked);
    assert.equal(
      linkedMetadata.git_root.toLocaleLowerCase("en-US"),
      repository.toLocaleLowerCase("en-US"),
    );
    assert.equal(
      linkedMetadata.canonical_root.toLocaleLowerCase("en-US"),
      linked.toLocaleLowerCase("en-US"),
    );
    assert.notEqual(linkedMetadata.worktree_identity, mainMetadata.worktree_identity);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("discovery is pending, persists atomically, and explicit add enables the project", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "project-registry-persist-"));
  try {
    const repository = initializeRepository(directory, "pending-project");
    const instants = [
      new Date("2026-08-16T01:00:00.000Z"),
      new Date("2026-08-16T02:00:00.000Z"),
    ];
    const registry = temporaryRegistry(directory, {
      now: () => instants.shift() ?? new Date("2026-08-16T03:00:00.000Z"),
    });
    const pending = registry.discover(repository, "codex_thread_cwd");
    assert.equal(pending.enabled, false);
    assert.equal(pending.discovered_from, "codex_thread_cwd");
    assert.equal(pending.created_at, "2026-08-16T01:00:00.000Z");
    assert.throws(
      () => registry.authorizeCwd(repository),
      /enabled project/,
    );

    const enabled = registry.add(repository, { displayName: "Pending Project" });
    assert.equal(enabled.project_id, pending.project_id);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.display_name, "Pending Project");
    assert.equal(enabled.created_at, pending.created_at);
    assert.equal(enabled.last_seen_at, "2026-08-16T02:00:00.000Z");
    assert.deepEqual(registry.listEnabledProjects(), [enabled]);

    const reloaded = new ProjectRegistry({ filePath: registry.filePath });
    assert.deepEqual(reloaded.list(), [enabled]);
    assert.equal(
      readdirSync(path.dirname(registry.filePath)).filter((entry) => entry.endsWith(".tmp")).length,
      0,
    );
    const document = JSON.parse(readFileSync(registry.filePath, "utf8")) as {
      schema_version: unknown;
    };
    assert.equal(document.schema_version, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("authorization is project-scoped and enable, disable, and remove are persistent", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "project-registry-auth-"));
  try {
    const first = initializeRepository(directory, "first");
    const firstChild = path.join(first, "packages", "one");
    mkdirSync(firstChild, { recursive: true });
    const sibling = initializeRepository(directory, "first-private");
    const registry = temporaryRegistry(directory);
    const firstRecord = registry.add(first);
    registry.add(sibling);

    const authorization = registry.authorizeProjectCwd(firstChild);
    assert.equal(authorization.project.project_id, firstRecord.project_id);
    assert.equal(
      authorization.canonical_cwd.toLocaleLowerCase("en-US"),
      firstChild.toLocaleLowerCase("en-US"),
    );
    assert.equal(
      registry.authorizeTargetPath("new-file.txt", firstChild),
      path.join(firstChild, "new-file.txt"),
    );
    assert.throws(
      () => registry.authorizeTargetPath(path.join(sibling, "escape.txt"), firstChild),
      /outside the configured allowed roots/,
    );
    assert.equal(registry.discoverCwd(directory, "project_scan"), null);

    registry.disable(firstRecord.project_id);
    assert.throws(() => registry.authorizeCwd(firstChild), /enabled project/);
    assert.equal(registry.enable(firstRecord.project_id).enabled, true);
    assert.equal(
      registry.authorizeProjectCwd(firstChild).project.project_id,
      firstRecord.project_id,
    );
    const externalCli = new ProjectRegistry({ filePath: registry.filePath });
    externalCli.disable(firstRecord.project_id);
    assert.throws(() => registry.authorizeCwd(firstChild), /enabled project/);
    externalCli.enable(firstRecord.project_id);
    assert.equal(registry.authorizeCwd(firstChild), authorization.canonical_cwd);
    assert.equal(registry.remove(firstRecord.project_id).project_id, firstRecord.project_id);
    assert.equal(registry.get(firstRecord.project_id), null);
    assert.throws(() => registry.authorizeCwd(firstChild), /enabled project/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persisted cwd authorization avoids known-project writes and discovers only unknown Git cwd", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "project-registry-persisted-cwd-"));
  try {
    const known = initializeRepository(directory, "known");
    const knownChild = path.join(known, "packages", "app");
    mkdirSync(knownChild, { recursive: true });
    const unknown = initializeRepository(directory, "unknown");
    const registry = temporaryRegistry(directory, {
      now: () => new Date("2026-08-16T01:00:00.000Z"),
    });
    const enabled = registry.add(known, { discoveredFrom: "test" });
    const before = readFileSync(registry.filePath, "utf8");

    const authorization = registry.authorizePersistedCwd(knownChild, "codex_thread");
    assert.equal(authorization?.project.project_id, enabled.project_id);
    assert.equal(authorization?.canonical_cwd, realpathSync.native(knownChild));
    assert.equal(readFileSync(registry.filePath, "utf8"), before);
    assert.equal(registry.get(enabled.project_id)?.last_seen_at, enabled.last_seen_at);

    assert.equal(registry.authorizePersistedCwd(unknown, "codex_thread"), null);
    const pending = registry.projectForCwd(unknown, false);
    assert.equal(pending?.enabled, false);
    assert.equal(pending?.discovered_from, "codex_thread");

    registry.disable(enabled.project_id);
    assert.equal(registry.authorizePersistedCwd(knownChild, "codex_thread"), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an optional static ceiling constrains enable and authorization without hiding pending discovery", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "project-registry-ceiling-"));
  try {
    const trustedContainer = path.join(directory, "trusted");
    const outsideContainer = path.join(directory, "outside");
    mkdirSync(trustedContainer);
    mkdirSync(outsideContainer);
    const inside = initializeRepository(trustedContainer, "inside");
    const outside = initializeRepository(outsideContainer, "outside");
    const environment = {
      [ALLOWED_ROOTS_ENV]: trustedContainer,
    };
    const registry = temporaryRegistry(directory, { environment });
    assert.equal(registry.hasStaticCeiling, true);

    const insidePending = registry.discover(inside, "project_scan");
    const outsidePending = registry.discover(outside, "project_scan");
    assert.equal(insidePending.enabled, false);
    assert.equal(outsidePending.enabled, false);
    assert.equal(registry.enable(insidePending.project_id).enabled, true);
    assert.throws(
      () => registry.enable(outsidePending.project_id),
      /outside the configured allowed roots/,
    );
    assert.throws(
      () => registry.add(outside),
      /outside the configured allowed roots/,
    );
    assert.equal(
      registry.authorizeProjectCwd(inside).project.project_id,
      insidePending.project_id,
    );
    assert.throws(
      () => registry.authorizeCwd(outside),
      /enabled project/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid persisted state fails closed", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "project-registry-invalid-"));
  try {
    const registry = temporaryRegistry(directory);
    mkdirSync(path.dirname(registry.filePath), { recursive: true });
    assert.equal(existsSync(registry.filePath), false);
    const invalid = path.join(path.dirname(registry.filePath), "projects.json");
    // Use the registry writer path without introducing a second fixture location.
    assert.equal(invalid, registry.filePath);
    writeFileSync(invalid, "{not-json", "utf8");
    assert.throws(() => registry.list(), /not valid JSON/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tampered and duplicate Git identity fields fail closed", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "project-registry-tamper-"));
  try {
    const first = initializeRepository(directory, "first");
    const second = initializeRepository(directory, "second");
    const registry = temporaryRegistry(directory);
    registry.add(first);
    const original = JSON.parse(readFileSync(registry.filePath, "utf8")) as {
      projects: Array<Record<string, unknown>>;
      trusted_containers: unknown[];
    };

    const tampered = structuredClone(original);
    tampered.projects[0]!.git_root = second;
    writeFileSync(registry.filePath, `${JSON.stringify(tampered)}\n`, "utf8");
    assert.equal(registry.projectForCwd(first), null);
    assert.throws(() => registry.authorizeCwd(first), /enabled project/);
    assert.throws(() => registry.listEnabledProjects(), /Git identity changed/);
    assert.throws(
      () => registry.authorizePersistedCwd(first, "codex_thread"),
      /Persisted project metadata does not match/,
    );

    const duplicateIdentity = structuredClone(original);
    duplicateIdentity.projects.push({
      ...duplicateIdentity.projects[0],
      project_id: "project_11111111111111111111111111111111",
      canonical_root: second,
      git_root: second,
    });
    writeFileSync(registry.filePath, `${JSON.stringify(duplicateIdentity)}\n`, "utf8");
    assert.throws(() => registry.list(), /duplicate worktree_identity/);

    const duplicateRoot = structuredClone(original);
    duplicateRoot.projects.push({
      ...duplicateRoot.projects[0],
      project_id: "project_22222222222222222222222222222222",
      worktree_identity: "worktree_synthetic-distinct-identity",
    });
    writeFileSync(registry.filePath, `${JSON.stringify(duplicateRoot)}\n`, "utf8");
    assert.throws(() => registry.list(), /duplicate canonical_root/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cross-process mutations serialize without losing either project", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "project-registry-concurrent-"));
  try {
    const first = initializeRepository(directory, "first");
    const second = initializeRepository(directory, "second");
    const registry = temporaryRegistry(directory);
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "dist", "src", "project-registry.js"),
    ).href;
    const program = [
      `import { ProjectRegistry } from ${JSON.stringify(moduleUrl)};`,
      "const registry = new ProjectRegistry({ filePath: process.argv[1] });",
      "registry.add(process.argv[2]);",
    ].join("\n");
    const children = [first, second].map((repository) =>
      spawn(process.execPath, ["--input-type=module", "-e", program, registry.filePath, repository], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const exits = await Promise.all(children.map(async (child) => {
      const [code] = await once(child, "exit") as [number | null];
      return code;
    }));
    assert.deepEqual(exits, [0, 0]);
    assert.equal(registry.list().length, 2);
    assert.equal(existsSync(`${registry.filePath}.lock`), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lock retries are bounded and a stale orphan lock is safely reclaimed", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "project-registry-lock-"));
  try {
    const repository = initializeRepository(directory, "project");
    const registry = new ProjectRegistry({
      filePath: path.join(directory, "state", "projects.json"),
      lockRetryCount: 1,
      lockRetryDelayMs: 1,
      staleLockMs: 5,
    });
    mkdirSync(path.dirname(registry.filePath), { recursive: true });
    const lockPath = `${registry.filePath}.lock`;
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      token: "11111111-1111-4111-8111-111111111111",
      created_at: "2000-01-01T00:00:00.000Z",
    }));
    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(lockPath, old, old);
    assert.throws(() => registry.add(repository), /lock retry limit exceeded/);

    writeFileSync(lockPath, "invalid stale orphan lock", "utf8");
    utimesSync(lockPath, old, old);
    assert.equal(registry.add(repository).enabled, true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("trusted containers persist but never grant project authorization", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "project-registry-container-"));
  try {
    const containerPath = path.join(directory, "projects");
    mkdirSync(containerPath);
    const repository = initializeRepository(containerPath, "child-project");
    const registry = temporaryRegistry(directory);
    const container = registry.addContainer(containerPath, "Development Projects");
    assert.equal(container.enabled, true);
    assert.equal(container.display_name, "Development Projects");
    assert.deepEqual(registry.listContainers(true), [container]);
    assert.throws(() => registry.authorizeCwd(repository), /No enabled projects/);

    assert.equal(registry.disableContainer(container.container_id).enabled, false);
    assert.deepEqual(registry.listContainers(true), []);
    assert.equal(registry.enableContainer(container.container_id).enabled, true);
    assert.equal(registry.removeContainer(container.container_id).container_id, container.container_id);
    assert.equal(registry.containerById(container.container_id), null);
    assert.throws(
      () => registry.addContainer(path.parse(directory).root),
      /drive root/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("project scan skips unsupported cwd shapes and rejects container Git redirection", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "project-registry-scan-guard-"));
  try {
    assert.equal(isSupportedPersistedCwd("C:\\code\\project"), true);
    assert.equal(isSupportedPersistedCwd("\\\\server\\share\\project"), false);
    assert.equal(isSupportedPersistedCwd("\\\\?\\C:\\code\\project"), false);
    assert.equal(isSupportedPersistedCwd("/mnt/c/code/project"), false);
    assert.equal(isSupportedPersistedCwd("relative\\project"), false);

    const containerRoot = path.join(directory, "container");
    mkdirSync(containerRoot);
    const registry = temporaryRegistry(directory);
    const container = registry.addContainer(containerRoot);
    const inside = initializeRepository(containerRoot, "inside");
    assert.equal(
      validateTrustedContainerRepository(container, inside),
      realpathSync.native(inside),
    );

    const outside = initializeRepository(directory, "outside");
    execFileSync("git", ["-C", outside, "config", "core.worktree", outside], {
      stdio: "ignore",
      windowsHide: true,
    });
    const redirected = path.join(containerRoot, "redirected");
    mkdirSync(redirected);
    writeFileSync(
      path.join(redirected, ".git"),
      `gitdir: ${path.join(outside, ".git")}\n`,
      "utf8",
    );
    assert.throws(
      () => validateTrustedContainerRepository(container, redirected),
      /resolves outside its scanned directory/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
