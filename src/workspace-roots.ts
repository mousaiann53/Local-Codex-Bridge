import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const ALLOWED_ROOTS_ENV = "LOCAL_CODEX_BRIDGE_ALLOWED_ROOTS";

export function validateWindowsCwd(value: string): string {
  if (value.includes("\0")) {
    throw new Error("cwd contains a NUL character");
  }
  if (/^(?:\\\\|\/\/|\\\\[?.]\\|\\[?.]\\)/.test(value)) {
    throw new Error("cwd must not be a UNC or Windows device path");
  }
  if (!/^[A-Za-z]:[\\/]/.test(value) || !path.win32.isAbsolute(value)) {
    throw new Error("cwd must be an absolute Windows drive-letter path");
  }
  return path.win32.normalize(value);
}

interface CanonicalDirectory {
  path: string;
  identity: string;
}

function directoryIdentity(value: string): string {
  const stats = statSync(value, { bigint: true });
  if (!stats.isDirectory()) {
    throw new Error("not a directory");
  }
  if (stats.ino === 0n) {
    throw new Error("stable directory identity is unavailable");
  }
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

function canonicalDirectory(
  value: string,
  label: "cwd" | "allowed root",
): CanonicalDirectory {
  const normalized = validateWindowsCwd(value);
  try {
    const canonical = validateWindowsCwd(realpathSync.native(normalized));
    return { path: canonical, identity: directoryIdentity(canonical) };
  } catch {
    throw new Error(`${label} must resolve to an existing local directory`);
  }
}

function isWithinRoot(candidate: CanonicalDirectory, rootIdentity: string): boolean {
  let current = candidate.path;
  while (true) {
    if (directoryIdentity(current) === rootIdentity) {
      return true;
    }
    const parent = path.win32.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function canonicalTarget(value: string): { path: string; parent: CanonicalDirectory } {
  const normalized = validateWindowsCwd(value);
  if (normalized.slice(2).includes(":")) {
    throw new Error("target path must not use an alternate data stream");
  }
  const missingSegments: string[] = [];
  let existing = normalized;
  while (true) {
    try {
      const canonical = validateWindowsCwd(realpathSync.native(existing));
      const stats = statSync(canonical);
      const parentPath = stats.isDirectory() ? canonical : path.win32.dirname(canonical);
      const parent = canonicalDirectory(parentPath, "cwd");
      return {
        path: missingSegments.length === 0
          ? canonical
          : path.win32.join(canonical, ...missingSegments.reverse()),
        parent,
      };
    } catch {
      let existingButUnresolved = false;
      try {
        lstatSync(existing);
        existingButUnresolved = true;
      } catch {
        // A genuinely absent leaf may be authorized through its canonical existing ancestor.
      }
      if (existingButUnresolved) {
        throw new Error("target path exists but could not be canonicalized");
      }
      const parent = path.win32.dirname(existing);
      if (parent === existing) {
        throw new Error("target path has no verifiable existing ancestor");
      }
      missingSegments.push(path.win32.basename(existing));
      existing = parent;
    }
  }
}

export class WorkspaceRootPolicy {
  readonly #roots: readonly CanonicalDirectory[];

  constructor(roots: readonly string[]) {
    const canonicalRoots = roots.map((root) => canonicalDirectory(root, "allowed root"));
    this.#roots = [...new Map(
      canonicalRoots.map((root) => [root.identity, root] as const),
    ).values()];
  }

  static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
  ): WorkspaceRootPolicy {
    const raw = environment[ALLOWED_ROOTS_ENV]?.trim();
    const roots = raw
      ? raw.split(path.win32.delimiter).map((root) => root.trim()).filter(Boolean)
      : [];
    return new WorkspaceRootPolicy(roots);
  }

  requireConfigured(): void {
    if (this.#roots.length === 0) {
      throw new Error(`${ALLOWED_ROOTS_ENV} is not configured; codex_turn is disabled`);
    }
  }

  authorizeCwd(value: string): string {
    this.requireConfigured();
    const candidate = canonicalDirectory(value, "cwd");
    try {
      for (const root of this.#roots) {
        if (directoryIdentity(root.path) !== root.identity) {
          throw new Error("configured allowed root changed or became unavailable");
        }
      }
      if (!this.#roots.some((root) => isWithinRoot(candidate, root.identity))) {
        throw new Error("cwd is outside the configured allowed roots");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "cwd is outside the configured allowed roots",
          "configured allowed root changed or became unavailable",
        ].includes(error.message)
      ) {
        throw error;
      }
      throw new Error("cwd could not be verified against the configured allowed roots");
    }
    return candidate.path;
  }

  authorizeTargetPath(value: string, cwd?: string): string {
    this.requireConfigured();
    if (!path.win32.isAbsolute(value) && !cwd) {
      throw new Error("relative target path requires an authorized cwd");
    }
    const absolute = path.win32.isAbsolute(value)
      ? value
      : path.win32.resolve(cwd ? this.authorizeCwd(cwd) : "", value);
    const candidate = canonicalTarget(absolute);
    try {
      for (const root of this.#roots) {
        if (directoryIdentity(root.path) !== root.identity) {
          throw new Error("configured allowed root changed or became unavailable");
        }
      }
      if (!this.#roots.some((root) => isWithinRoot(candidate.parent, root.identity))) {
        throw new Error("target path is outside the configured allowed roots");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "target path is outside the configured allowed roots",
          "configured allowed root changed or became unavailable",
        ].includes(error.message)
      ) {
        throw error;
      }
      throw new Error("target path could not be verified against the configured allowed roots");
    }
    return candidate.path;
  }
}
