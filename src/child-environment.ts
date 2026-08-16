const CHILD_ENV_ALLOWLIST = new Set([
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "CODEX_HOME",
  "RUST_LOG",
]);

export function childEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(environment)) {
    const normalized = name.toUpperCase();
    if (value !== undefined && CHILD_ENV_ALLOWLIST.has(normalized) && !seen.has(normalized)) {
      child[name] = value;
      seen.add(normalized);
    }
  }
  return child;
}
