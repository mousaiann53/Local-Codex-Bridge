import { AppServerManager } from "./app-server.js";
import {
  CHECKPOINT_TEXT_LIMIT,
  CHECKPOINT_THREAD_ID_LIMIT,
  CheckpointStore,
} from "./checkpoint.js";
import {
  MAX_OBSERVE_WAIT_MS,
  sanitizeForTransport,
  type PendingServerRequest,
  type RpcId,
} from "./runtime.js";
import {
  WorkspaceRootPolicy,
  validateWindowsCwd,
} from "./workspace-roots.js";
import type { ProjectRecord } from "./project-registry.js";

export { validateWindowsCwd };

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const approvalPolicySchema = {
  type: "string",
  enum: ["untrusted", "on-request"],
  default: "untrusted",
  description: "Restricted Codex approval policy. Session-wide and never-ask policies are not exposed.",
};

const sandboxSchema = {
  type: "string",
  enum: ["read-only", "workspace-write"],
  default: "read-only",
  description: "Restricted Codex sandbox mode. Full filesystem access is not exposed.",
};

const SUPPORTED_RESPONSE_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "item/tool/requestUserInput",
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

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "codex_threads",
    title: "Codex Threads",
    description:
      "List/search/read persistent native Codex threads whose Git project is enabled in the Local Codex Bridge Project Registry. mode=projects directly lists enabled registry projects, including projects with no threads, with a persisted thread_count. Supports project_id and cwd filters in the default threads mode, and returns project_id for every visible thread. This does not reconstruct live Bridge events.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["threads", "projects"],
          default: "threads",
          description: "Use projects to list enabled Project Registry entries directly; omit for existing thread list/read behavior.",
        },
        thread_id: {
          type: "string",
          minLength: 1,
          description: "When supplied, read this exact Codex thread instead of listing threads.",
        },
        include_turns: {
          type: "boolean",
          default: false,
          description: "Include persisted turns when reading one thread.",
        },
        cwd: {
          type: "string",
          description: "Optional exact absolute Windows drive-letter cwd filter for thread/list.",
        },
        project_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional enabled Local Codex Bridge project id filter for thread/list.",
        },
        search_term: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional Codex title substring filter for thread/list.",
        },
        cursor: {
          type: "string",
          minLength: 1,
          description: "Opaque cursor returned by a prior thread/list call.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum threads in the returned page.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Codex Threads",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_turn",
    title: "Start or Continue Codex Turn",
    description:
      "Start a persistent Codex thread and turn, or resume an existing thread and start a turn. An enabled Local Codex Bridge Project Registry entry must authorize the effective cwd; LOCAL_CODEX_BRIDGE_ALLOWED_ROOTS, when configured, is only an additional static ceiling. Prefer continuing the same native thread when its context remains useful, but a fresh thread is allowed; thread_id is not a permanent task identity. Returns as soon as turn/start is accepted; observe separately for events and completion.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: 200000,
          description: "User text passed directly to Codex as one text input item.",
        },
        thread_id: {
          type: "string",
          minLength: 1,
          description: "Existing persistent Codex thread to resume. Omit to create a new thread.",
        },
        cwd: {
          type: "string",
          description: "Absolute Windows drive-letter cwd inside a configured allowed root. Required for a new thread; optional authorized override for resume.",
        },
        model: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optional model identifier passed through to app-server.",
        },
        effort: {
          type: "string",
          minLength: 1,
          maxLength: 32,
          description: "Optional reasoning effort passed through to turn/start.",
        },
        sandbox: sandboxSchema,
        approval_policy: approvalPolicySchema,
      },
      required: ["text"],
      anyOf: [{ required: ["thread_id"] }, { required: ["cwd"] }],
      additionalProperties: false,
    },
    annotations: {
      title: "Start or Continue Codex Turn",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_observe",
    title: "Observe Codex Turn",
    description:
      "Read bounded incremental sanitized Bridge runtime events, pending requests, and terminal output for a thread. Optional wait_ms performs one bounded event-driven wait only when the live turn is active and the current snapshot has nothing useful; it is not polling or stall detection. After Bridge process loss, falls back to persistent thread/read history and marks live state unreconstructable. A long interval with no new command or output can still mean Codex is actively reasoning; absence of new command activity alone is not evidence of a stall. When actively supervising an in-progress turn, use repeated bounded-wait observe calls until terminal unless the user explicitly pauses or stops; do not end supervision merely because one snapshot is inProgress. After every wake or deadline return, inspect the newly available events/state and decide whether steer, respond, or interruption is needed before starting the next bounded wait.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, description: "Codex thread to observe." },
        cursor: {
          type: "integer",
          minimum: 0,
          description: "Return runtime events with a cursor greater than this value.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 50,
          description: "Maximum runtime events to return.",
        },
        wait_ms: {
          type: "integer",
          minimum: 0,
          maximum: MAX_OBSERVE_WAIT_MS,
          default: 0,
          description:
            "Optional per-call wait for the next live runtime change when nothing useful is ready; 0 returns immediately. This is event-driven waiting, not stall detection.",
        },
      },
      required: ["thread_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Observe Codex Turn",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_steer",
    title: "Steer Active Codex Turn",
    description:
      "Append text to the same active Codex turn using turn/steer with an expected turn-id precondition. This does not create a new turn. Do not steer merely because reasoning is taking a long time or no new command has appeared; steer only for a semantic redirect or correction based on new evidence or changed user intent.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, description: "Active Codex thread." },
        expected_turn_id: {
          type: "string",
          minLength: 1,
          description: "Exact active turn id required by app-server.",
        },
        text: { type: "string", minLength: 1, maxLength: 200000, description: "Additional user text." },
      },
      required: ["thread_id", "expected_turn_id", "text"],
      additionalProperties: false,
    },
    annotations: {
      title: "Steer Active Codex Turn",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_respond",
    title: "Respond to Codex Request",
    description:
      "Answer one currently pending app-server request by its original raw JSON-RPC id and exact thread/method scope. Supports only command/file approval methods with concrete response contracts and item/tool/requestUserInput; unsupported methods remain pending and observable.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          oneOf: [{ type: "string", minLength: 1 }, { type: "integer" }],
          description: "Original app-server JSON-RPC request id, preserving string or integer type.",
        },
        thread_id: { type: "string", minLength: 1, description: "Exact pending-request thread scope." },
        turn_id: { type: "string", minLength: 1, description: "Exact turn scope when the pending request has one." },
        method: { type: "string", minLength: 1, description: "Exact app-server request method." },
        decision: {
          type: "string",
          enum: ["accept", "decline", "cancel"],
          description: "One-request command or file approval decision. Session-wide approval is not exposed.",
        },
        answers: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              answers: { type: "array", items: { type: "string" } },
            },
            required: ["answers"],
            additionalProperties: false,
          },
          description: "request_user_input question-id to answer-array mapping.",
        },
        response: {
          type: "object",
          additionalProperties: true,
          description: "Exact result object for the known item/tool/requestUserInput method.",
        },
      },
      required: ["request_id", "thread_id", "method"],
      anyOf: [
        { required: ["decision"] },
        { required: ["answers"] },
        { required: ["response"] },
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Respond to Codex Request",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_interrupt",
    title: "Interrupt Codex Turn",
    description:
      "Directly request turn/interrupt for the specified active Codex thread and turn. It does not stop or restart the Bridge or Codex app-server processes.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, description: "Active Codex thread." },
        turn_id: { type: "string", minLength: 1, description: "Active Codex turn to interrupt." },
      },
      required: ["thread_id", "turn_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Interrupt Codex Turn",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_checkpoint",
    title: "Checkpoint Codex Supervision",
    description:
      "Optional, bounded supervisor cognition memory keyed to one native Codex thread_id; the key is not a permanent task identity and does not require future work to remain on that thread. Use it to protect the original goal, constraints, and acceptance plus concise supervisor state during long or complex supervision when context dilution or goal drift makes an external anchor worthwhile. Initialization is not tied to crossing a ChatGPT window or round, starting another Codex turn, or switching native threads; initialize early when a task is already expected to be sufficiently long or complex for that protection. Do not use for one-shot work, and do not turn duration into a hard threshold: elapsed time, observe/poll count, token count, or mere silence are not automatic triggers. Later updates remain semantic-event driven and require a material change in understanding or root cause, constraint or scope interpretation, steering decision, user-authorized amendment or effective goal, or acceptance judgment or an explicit decision not to accept yet. Before final acceptance of a checkpointed task, read it once to re-anchor the original goal, constraints, acceptance, and current supervisor frame. This tool is optional and uncoupled from all other tools. Store concise supervisor summaries only; never prompts, transcripts, raw events, command output, final answers, or raw event streams. Updates preserve only immutable original plus bounded previous/current supervisor state.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "update"],
          description:
            "Read the checkpoint, or initialize/update it at a material supervisor decision point.",
        },
        thread_id: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_THREAD_ID_LIMIT,
          description: "Native Codex thread id; no second task identifier is created.",
        },
        original_goal: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Concise original user goal. Required only on initialization and immutable thereafter.",
        },
        original_constraints: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Concise original constraints. Required only on initialization and immutable thereafter.",
        },
        original_acceptance: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Concise original acceptance criteria. Required only on initialization and immutable thereafter.",
        },
        effective_goal: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Current effective goal after legitimate user amendments; defaults to original_goal on initialization.",
        },
        current_amendment: {
          oneOf: [
            { type: "string", minLength: 1, maxLength: CHECKPOINT_TEXT_LIMIT },
            { type: "null" },
          ],
          description:
            "Latest concise user-authorized requirement amendment, or null to clear it, without changing the immutable original.",
        },
        current_understanding: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description: "Current concise root-cause or task understanding.",
        },
        current_decision: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description: "Current supervisor decision and why it matters.",
        },
        acceptance_status: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Concise acceptance assessment, not a task lifecycle or job status.",
        },
        next_step: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description: "Single next supervision step.",
        },
      },
      required: ["action", "thread_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Checkpoint Codex Supervision",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] as const;

export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

function asObject(value: unknown, label = "arguments"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const extras = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(`Unknown argument field: ${extras[0]}`);
  }
}

function requiredString(args: Record<string, unknown>, key: string, max = 200_000): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new Error(`${key} exceeds ${max} characters`);
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  max = 200_000,
): string | undefined {
  if (args[key] === undefined) {
    return undefined;
  }
  return requiredString(args, key, max);
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function enumValue<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${key} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function normalizedCwdCacheKey(value: string): string {
  return validateWindowsCwd(value).toLocaleLowerCase("en-US");
}

function responseRecord(value: unknown, method: string): Record<string, unknown> {
  const record = asObject(value, `${method} response`);
  return record;
}

function extractThreadId(result: unknown, method: string): string {
  const thread = asObject(asObject(result, `${method} result`).thread, `${method} result.thread`);
  if (typeof thread.id !== "string" || thread.id.length === 0) {
    throw new Error(`${method} returned no thread id`);
  }
  return thread.id;
}

export interface WorkspaceAuthorizationPolicy {
  requireConfigured(): void;
  authorizeCwd(value: string): string;
  authorizeTargetPath(value: string, cwd?: string): string;
  discoverCwd?(value: string, source: string): ProjectRecord | null;
  projectForCwd?(value: string, enabledOnly?: boolean): ProjectRecord | null;
  projectById?(projectId: string): ProjectRecord | null;
  listEnabledProjects?(): ProjectRecord[];
  authorizePersistedCwd?(
    value: string,
    discoveredFrom: string,
  ): { project: ProjectRecord; canonical_cwd: string } | null;
}

function extractThreadCwd(result: unknown): string {
  const thread = asObject(asObject(result, "thread/read result").thread, "thread/read result.thread");
  if (typeof thread.cwd !== "string" || thread.cwd.length === 0) {
    throw new Error("thread/read returned no cwd");
  }
  return thread.cwd;
}

function extractTurnId(result: unknown, method: string): string {
  const turn = asObject(asObject(result, `${method} result`).turn, `${method} result.turn`);
  if (typeof turn.id !== "string" || turn.id.length === 0) {
    throw new Error(`${method} returned no turn id`);
  }
  return turn.id;
}

function storedTerminal(threadResult: unknown): unknown {
  const result = asObject(threadResult, "thread/read result");
  const thread = asObject(result.thread, "thread/read result.thread");
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const turn = turns.length > 0 ? asObject(turns.at(-1), "stored turn") : null;
  if (!turn || typeof turn.id !== "string") {
    return null;
  }
  const status = typeof turn.status === "string" ? turn.status : "unknown";
  if (!["completed", "failed", "interrupted"].includes(status)) {
    return null;
  }
  const items = Array.isArray(turn.items) ? turn.items : [];
  let finalResult: string | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "agentMessage" &&
      typeof (item as Record<string, unknown>).text === "string"
    ) {
      finalResult = (item as Record<string, unknown>).text as string;
      break;
    }
  }
  return sanitizeForTransport({
    turn_id: turn.id,
    status,
    completed_at: null,
    final_result: finalResult,
    error: turn.error ?? null,
    source: "codex_app_server_thread_read",
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("MCP request cancelled");
  }
}

export class ControlSurface {
  private checkpoints: CheckpointStore | undefined;

  constructor(
    private readonly appServer: AppServerManager,
    checkpoints?: CheckpointStore,
    private readonly workspaceRoots: WorkspaceAuthorizationPolicy = WorkspaceRootPolicy.fromEnvironment(),
  ) {
    this.checkpoints = checkpoints;
  }

  async call(name: string, rawArguments: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = asObject(rawArguments ?? {});
    switch (name) {
      case "codex_threads":
        return await this.#threads(args);
      case "codex_turn":
        return await this.#turn(args);
      case "codex_observe":
        return await this.#observe(args, signal);
      case "codex_steer":
        return await this.#steer(args);
      case "codex_respond":
        return await this.#respond(args);
      case "codex_interrupt":
        return await this.#interrupt(args);
      case "codex_checkpoint":
        return this.#checkpoint(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  #checkpoint(args: Record<string, unknown>): unknown {
    const fields = [
      "action",
      "thread_id",
      "original_goal",
      "original_constraints",
      "original_acceptance",
      "effective_goal",
      "current_amendment",
      "current_understanding",
      "current_decision",
      "acceptance_status",
      "next_step",
    ] as const;
    onlyKeys(args, fields);
    const action = enumValue(args, "action", ["read", "update"] as const);
    if (!action) {
      throw new Error("action is required");
    }
    const threadId = requiredString(args, "thread_id", CHECKPOINT_THREAD_ID_LIMIT).trim();
    if (action === "read") {
      onlyKeys(args, ["action", "thread_id"]);
      const checkpoint = this.#checkpointStore().read(threadId);
      return checkpoint === null
        ? {
            source: "local_codex_bridge_checkpoint",
            found: false,
            thread_id: threadId,
            checkpoint: null,
          }
        : {
            source: "local_codex_bridge_checkpoint",
            found: true,
            operation: "read",
            checkpoint,
          };
    }

    let currentAmendment: string | null | undefined;
    if (args.current_amendment === null) {
      currentAmendment = null;
    } else {
      currentAmendment = optionalString(
        args,
        "current_amendment",
        CHECKPOINT_TEXT_LIMIT,
      );
    }
    const result = this.#checkpointStore().update(threadId, {
      original_goal: optionalString(args, "original_goal", CHECKPOINT_TEXT_LIMIT),
      original_constraints: optionalString(
        args,
        "original_constraints",
        CHECKPOINT_TEXT_LIMIT,
      ),
      original_acceptance: optionalString(
        args,
        "original_acceptance",
        CHECKPOINT_TEXT_LIMIT,
      ),
      effective_goal: optionalString(args, "effective_goal", CHECKPOINT_TEXT_LIMIT),
      current_amendment: currentAmendment,
      current_understanding: optionalString(
        args,
        "current_understanding",
        CHECKPOINT_TEXT_LIMIT,
      ),
      current_decision: optionalString(args, "current_decision", CHECKPOINT_TEXT_LIMIT),
      acceptance_status: optionalString(
        args,
        "acceptance_status",
        CHECKPOINT_TEXT_LIMIT,
      ),
      next_step: optionalString(args, "next_step", CHECKPOINT_TEXT_LIMIT),
    });
    return {
      source: "local_codex_bridge_checkpoint",
      found: true,
      operation: result.operation,
      checkpoint: result.checkpoint,
    };
  }

  #checkpointStore(): CheckpointStore {
    this.checkpoints ??= new CheckpointStore();
    return this.checkpoints;
  }

  #discoverCwd(value: string, source: string): void {
    this.workspaceRoots.discoverCwd?.(value, source);
  }

  #projectForCwd(cwd: string): ProjectRecord | null {
    return this.workspaceRoots.projectForCwd?.(cwd, true) ?? null;
  }

  #authorizeProjectCwd(
    value: string,
    discoveredFrom?: string,
  ): { cwd: string; projectId: string | null } {
    if (discoveredFrom && this.workspaceRoots.authorizePersistedCwd) {
      const authorization = this.workspaceRoots.authorizePersistedCwd(
        value,
        discoveredFrom,
      );
      if (!authorization) {
        throw new Error("persisted cwd does not belong to an enabled project");
      }
      return {
        cwd: authorization.canonical_cwd,
        projectId: authorization.project.project_id,
      };
    }
    if (discoveredFrom) this.#discoverCwd(value, discoveredFrom);
    const cwd = this.workspaceRoots.authorizeCwd(value);
    const project = this.#projectForCwd(cwd);
    if (this.workspaceRoots.projectForCwd && !project) {
      throw new Error("cwd does not belong to an enabled project");
    }
    return { cwd, projectId: project?.project_id ?? null };
  }

  #enabledProject(projectId: string): ProjectRecord {
    if (!this.workspaceRoots.projectById) {
      throw new Error("project_id filtering requires the Local Codex Bridge Project Registry");
    }
    const project = this.workspaceRoots.projectById(projectId);
    if (!project || !project.enabled) {
      throw new Error("project_id does not identify an enabled project");
    }
    this.workspaceRoots.authorizeCwd(project.canonical_root);
    return project;
  }

  #bindAuthorizedThread(
    threadId: string,
    result: unknown,
  ): { cwd: string; projectId: string | null } {
    if (extractThreadId(result, "thread/read") !== threadId) {
      throw new Error("thread/read returned a different thread id");
    }
    const authorization = this.#authorizeProjectCwd(extractThreadCwd(result), "codex_thread");
    const cwd = authorization.cwd;
    this.appServer.runtime.bindAuthorizedWorkspace(threadId, cwd);
    return authorization;
  }

  async #readAuthorizedThread(
    threadId: string,
    includeTurns: boolean,
  ): Promise<Record<string, unknown>> {
    if (!this.workspaceRoots.discoverCwd) {
      this.workspaceRoots.requireConfigured();
    }
    const metadata = await this.appServer.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    this.#bindAuthorizedThread(threadId, metadata);
    if (!includeTurns) {
      return responseRecord(metadata, "thread/read");
    }
    const result = await this.appServer.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    this.#bindAuthorizedThread(threadId, result);
    return responseRecord(result, "thread/read");
  }

  #authorizeBoundLiveThread(threadId: string): boolean {
    this.workspaceRoots.requireConfigured();
    const boundCwd = this.appServer.runtime.authorizedWorkspace(threadId);
    if (!boundCwd || !this.appServer.runtime.hasThread(threadId)) {
      return false;
    }
    const authorizedCwd = this.#authorizeProjectCwd(boundCwd).cwd;
    if (authorizedCwd.toLowerCase() !== boundCwd.toLowerCase()) {
      throw new Error("live thread workspace binding no longer resolves to the authorized cwd");
    }
    this.appServer.runtime.bindAuthorizedWorkspace(threadId, authorizedCwd);
    return true;
  }

  async #authorizeControlThread(threadId: string): Promise<void> {
    if (!this.#authorizeBoundLiveThread(threadId)) {
      await this.#readAuthorizedThread(threadId, false);
    }
  }

  #guardApprovalAccept(
    method: string,
    pending: PendingServerRequest,
  ): void {
    const params = asObject(pending.params, "pending approval params");
    if (
      params.grantRoot !== undefined && params.grantRoot !== null ||
      params.networkApprovalContext !== undefined && params.networkApprovalContext !== null ||
      params.proposedExecpolicyAmendment !== undefined && params.proposedExecpolicyAmendment !== null ||
      params.proposedNetworkPolicyAmendments !== undefined && params.proposedNetworkPolicyAmendments !== null
    ) {
      throw new Error("Remote approval cannot grant roots, network access, or policy/session amendments");
    }

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "execCommandApproval"
    ) {
      throw new Error(
        "Remote command approval accept is disabled because shell text cannot prove workspace-only effects",
      );
    }

    const cwd = this.appServer.runtime.authorizedWorkspace(pending.threadId);
    if (!cwd) {
      throw new Error("Pending approval is not bound to an authorized workspace");
    }
    const paths: string[] = [];
    if (method === "item/fileChange/requestApproval") {
      throw new Error(
        "Current file approval accept is disabled because the request does not contain a complete path snapshot",
      );
    } else if (method === "applyPatchApproval") {
      const changes = asObject(params.fileChanges, "applyPatchApproval fileChanges");
      const entries = Object.entries(changes);
      if (entries.length === 0) {
        throw new Error("Legacy file approval has no structured file changes");
      }
      for (const [target, changeValue] of entries) {
        paths.push(target);
        const change = asObject(changeValue, "applyPatchApproval file change");
        if (change.type === "update" && typeof change.move_path === "string") {
          paths.push(change.move_path);
        }
      }
    } else {
      throw new Error(`Unsupported approval guard method: ${method}`);
    }
    for (const target of paths) {
      this.workspaceRoots.authorizeTargetPath(target, cwd);
    }
  }

  async #threads(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["mode", "thread_id", "include_turns", "cwd", "project_id", "search_term", "cursor", "limit"]);
    const mode = enumValue(args, "mode", ["threads", "projects"] as const) ?? "threads";
    if (mode === "projects") {
      onlyKeys(args, ["mode"]);
      return await this.#projects();
    }
    const threadId = optionalString(args, "thread_id", 200);
    if (threadId) {
      if (args.cwd !== undefined || args.project_id !== undefined || args.search_term !== undefined || args.cursor !== undefined || args.limit !== undefined) {
        throw new Error("thread_id cannot be combined with list/search fields");
      }
      const includeTurns = optionalBoolean(args, "include_turns") ?? false;
      const result = await this.#readAuthorizedThread(threadId, includeTurns);
      const thread = asObject(result.thread, "thread/read result.thread");
      const projectId = this.#projectForCwd(extractThreadCwd(result))?.project_id ?? null;
      return sanitizeForTransport({
        source: "codex_app_server",
        mode: "read",
        ...result,
        project_id: projectId,
        thread: { ...thread, project_id: projectId },
      });
    }
    if (args.include_turns !== undefined) {
      throw new Error("include_turns is valid only with thread_id");
    }
    if (!this.workspaceRoots.discoverCwd) {
      this.workspaceRoots.requireConfigured();
    }
    const projectId = optionalString(args, "project_id", 200);
    const projectFilter = projectId ? this.#enabledProject(projectId) : undefined;
    const cwdInput = optionalString(args, "cwd", 1_000);
    const cwdAuthorization = cwdInput
      ? this.#authorizeProjectCwd(cwdInput)
      : undefined;
    const cwd = cwdAuthorization?.cwd;
    if (
      projectFilter &&
      cwdAuthorization?.projectId &&
      cwdAuthorization.projectId !== projectFilter.project_id
    ) {
      throw new Error("cwd does not belong to the requested project_id");
    }
    const searchTerm = optionalString(args, "search_term", 500);
    const cursor = optionalString(args, "cursor", 10_000);
    const limit = optionalInteger(args, "limit", 1, 100) ?? 20;
    const result = await this.appServer.request("thread/list", {
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: true,
      sourceKinds: ALL_STABLE_THREAD_SOURCE_KINDS,
      ...(cwd ? { cwd } : {}),
      ...(searchTerm ? { searchTerm } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const page = responseRecord(result, "thread/list");
    if (!Array.isArray(page.data)) {
      throw new Error("thread/list returned no data array");
    }
    type CachedAuthorization =
      | { ok: true; value: { cwd: string; projectId: string | null } }
      | { ok: false; error: unknown };
    const authorizationCache = new Map<string, CachedAuthorization>();
    const authorizeThreadCwd = (value: string): { cwd: string; projectId: string | null } => {
      const key = normalizedCwdCacheKey(value);
      const cached = authorizationCache.get(key);
      if (cached) {
        if (!cached.ok) throw cached.error;
        return cached.value;
      }
      try {
        const authorization = this.#authorizeProjectCwd(value, "codex_thread");
        authorizationCache.set(key, { ok: true, value: authorization });
        return authorization;
      } catch (error) {
        authorizationCache.set(key, { ok: false, error });
        throw error;
      }
    };
    const visible = page.data.flatMap((value) => {
      try {
        const thread = asObject(value, "thread/list item");
        if (typeof thread.id !== "string" || thread.id.length === 0) {
          return [];
        }
        const authorization = authorizeThreadCwd(extractThreadCwd({ thread }));
        if (projectFilter && authorization.projectId !== projectFilter.project_id) {
          return [];
        }
        const authorizedCwd = authorization.cwd;
        this.appServer.runtime.bindAuthorizedWorkspace(thread.id, authorizedCwd);
        return [sanitizeForTransport({
          ...thread,
          project_id: authorization.projectId,
        }, {
          maxStringChars: 4_000,
          maxDepth: 6,
          maxArrayItems: 20,
          maxObjectKeys: 60,
          totalCharBudget: 12_000,
        })];
      } catch {
        return [];
      }
    });
    return {
      source: "codex_app_server",
      mode: "list",
      nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
      backwardsCursor: typeof page.backwardsCursor === "string" ? page.backwardsCursor : null,
      data: visible,
    };
  }

  async #projects(): Promise<unknown> {
    if (!this.workspaceRoots.listEnabledProjects) {
      throw new Error("Project listing requires the Local Codex Bridge Project Registry");
    }
    const projects = this.workspaceRoots.listEnabledProjects().sort((left, right) =>
      left.project_id.localeCompare(right.project_id),
    );
    const projectIds = new Set(projects.map((project) => project.project_id));
    const threadProjects = new Map<string, string>();
    const projectCache = new Map<string, string | null>();
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (let pageIndex = 0; pageIndex < 10_000; pageIndex += 1) {
        const result = await this.appServer.request("thread/list", {
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived,
          useStateDbOnly: true,
          sourceKinds: ALL_STABLE_THREAD_SOURCE_KINDS,
          ...(cursor ? { cursor } : {}),
        });
        const page = responseRecord(result, "thread/list");
        if (!Array.isArray(page.data)) {
          throw new Error("thread/list returned no data array");
        }
        for (const value of page.data) {
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            continue;
          }
          const thread = value as Record<string, unknown>;
          if (
            typeof thread.id !== "string" ||
            thread.id.length === 0 ||
            typeof thread.cwd !== "string"
          ) {
            continue;
          }
          let key: string;
          try {
            key = normalizedCwdCacheKey(thread.cwd);
          } catch {
            continue;
          }
          let projectId: string | null;
          if (projectCache.has(key)) {
            projectId = projectCache.get(key) ?? null;
          } else {
            if (this.workspaceRoots.authorizePersistedCwd) {
              const authorization = this.workspaceRoots.authorizePersistedCwd(
                thread.cwd,
                "codex_thread",
              );
              projectId = authorization?.project.project_id ?? null;
            } else {
              projectId = this.#projectForCwd(thread.cwd)?.project_id ?? null;
            }
            projectCache.set(key, projectId);
          }
          if (projectId && projectIds.has(projectId)) {
            threadProjects.set(thread.id, projectId);
          }
        }
        const nextCursor = typeof page.nextCursor === "string" && page.nextCursor.length > 0
          ? page.nextCursor
          : undefined;
        if (!nextCursor) break;
        if (seenCursors.has(nextCursor)) {
          throw new Error("thread/list returned a repeated cursor");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
        if (pageIndex === 9_999) {
          throw new Error("thread/list pagination exceeded its bound");
        }
      }
    }
    const threadCounts = new Map<string, number>();
    for (const projectId of threadProjects.values()) {
      threadCounts.set(projectId, (threadCounts.get(projectId) ?? 0) + 1);
    }
    return {
      source: "local_codex_bridge_project_registry",
      mode: "projects",
      nextCursor: null,
      backwardsCursor: null,
      data: projects.map((project) => ({
        project_id: project.project_id,
        display_name: project.display_name,
        canonical_root: project.canonical_root,
        git_root: project.git_root,
        enabled: true,
        thread_count: threadCounts.get(project.project_id) ?? 0,
      })),
    };
  }

  async #turn(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["text", "thread_id", "cwd", "model", "effort", "sandbox", "approval_policy"]);
    const text = requiredString(args, "text");
    const requestedThreadId = optionalString(args, "thread_id", 200);
    const cwdInput = optionalString(args, "cwd", 1_000);
    if (!requestedThreadId && !cwdInput) {
      throw new Error("cwd is required when thread_id is omitted");
    }
    const model = optionalString(args, "model", 100);
    const effort = optionalString(args, "effort", 32);
    const sandbox = enumValue(args, "sandbox", ["read-only", "workspace-write"] as const) ?? "read-only";
    const approvalPolicy = enumValue(args, "approval_policy", ["untrusted", "on-request"] as const) ?? "untrusted";
    this.workspaceRoots.requireConfigured();
    let cwdAuthorization = cwdInput
      ? this.#authorizeProjectCwd(cwdInput)
      : undefined;
    if (requestedThreadId) {
      const storedThread = await this.#readAuthorizedThread(requestedThreadId, false);
      const persistedAuthorization = this.#authorizeProjectCwd(
        extractThreadCwd(storedThread),
        "codex_thread",
      );
      if (
        cwdAuthorization?.projectId &&
        persistedAuthorization.projectId &&
        cwdAuthorization.projectId !== persistedAuthorization.projectId
      ) {
        throw new Error("resume cwd override must remain in the thread's authorized project");
      }
      cwdAuthorization ??= persistedAuthorization;
    }
    const cwd = cwdAuthorization!.cwd;
    const overrides = {
      cwd,
      ...(model ? { model } : {}),
      sandbox: "read-only",
      approvalPolicy,
    };

    const threadResult = requestedThreadId
      ? await this.appServer.request("thread/resume", {
          threadId: requestedThreadId,
          ...overrides,
        })
      : await this.appServer.request("thread/start", {
          ...overrides,
          serviceName: "local-codex-bridge",
        });
    const threadId = extractThreadId(
      threadResult,
      requestedThreadId ? "thread/resume" : "thread/start",
    );
    if (requestedThreadId && threadId !== requestedThreadId) {
      throw new Error("thread/resume returned a different thread id");
    }
    const resumedThread = await this.#readAuthorizedThread(threadId, false);
    const effectiveAuthorization = this.#authorizeProjectCwd(
      extractThreadCwd(resumedThread),
      "codex_thread",
    );
    const effectiveCwd = effectiveAuthorization.cwd;
    if (effectiveCwd.toLowerCase() !== cwd.toLowerCase()) {
      throw new Error("native thread cwd does not match the authorized requested cwd");
    }
    this.appServer.runtime.bindAuthorizedWorkspace(threadId, effectiveCwd);
    const turnResult = await this.appServer.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd: effectiveCwd,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      approvalPolicy,
      sandboxPolicy: sandbox === "workspace-write"
        ? {
            type: "workspaceWrite",
            writableRoots: [effectiveCwd],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          }
        : {
            type: "readOnly",
            networkAccess: false,
          },
    });
    const turnId = extractTurnId(turnResult, "turn/start");
    this.appServer.runtime.markTurnAccepted(threadId, turnId);
    const turn = asObject(turnResult, "turn/start result").turn as Record<string, unknown>;
    return {
      accepted: true,
      thread_id: threadId,
      turn_id: turnId,
      project_id: effectiveAuthorization.projectId,
      event_cursor: this.appServer.runtime.currentCursor(threadId),
      status: typeof turn.status === "string" ? turn.status : "inProgress",
    };
  }

  async #observe(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    onlyKeys(args, ["thread_id", "cursor", "limit", "wait_ms"]);
    const threadId = requiredString(args, "thread_id", 200);
    const cursor = optionalInteger(args, "cursor", 0, Number.MAX_SAFE_INTEGER);
    const limit = optionalInteger(args, "limit", 1, 100) ?? 50;
    const waitMs = optionalInteger(args, "wait_ms", 0, MAX_OBSERVE_WAIT_MS) ?? 0;
    const observeRuntime = async (): Promise<unknown> => waitMs === 0
      ? this.appServer.runtime.observe(threadId, cursor, limit)
      : await this.appServer.runtime.observeWithWait(threadId, cursor, limit, waitMs, signal);
    if (this.#authorizeBoundLiveThread(threadId)) {
      const runtime = await observeRuntime();
      throwIfAborted(signal);
      if (runtime) {
        return runtime;
      }
    }
    const storedThread = await this.#readAuthorizedThread(threadId, true);
    const runtime = await observeRuntime();
    throwIfAborted(signal);
    if (runtime) {
      return runtime;
    }
    throwIfAborted(signal);
    return sanitizeForTransport({
      runtime_available: false,
      live_state_reconstructable: false,
      note: "This Bridge process has no in-memory runtime for the thread. Live event ring and pending requests cannot be reconstructed after process loss.",
      runtime_status: "not_reconstructable",
      active_turn_id: null,
      events: [],
      next_cursor: 0,
      current_cursor: 0,
      cursor_floor: 0,
      cursor_lost: false,
      has_more: false,
      pending_requests: [],
      terminal: storedTerminal(storedThread),
      stored_thread: storedThread.thread,
      source: "codex_app_server_thread_read",
    });
  }

  async #steer(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "expected_turn_id", "text"]);
    const threadId = requiredString(args, "thread_id", 200);
    const expectedTurnId = requiredString(args, "expected_turn_id", 200);
    const text = requiredString(args, "text");
    await this.#authorizeControlThread(threadId);
    const result = responseRecord(
      await this.appServer.request("turn/steer", {
        threadId,
        expectedTurnId,
        input: [{ type: "text", text, text_elements: [] }],
      }),
      "turn/steer",
    );
    if (typeof result.turnId !== "string" || result.turnId.length === 0) {
      throw new Error("turn/steer returned no turn id");
    }
    if (result.turnId !== expectedTurnId) {
      throw new Error("turn/steer returned a different turn id");
    }
    return { accepted: true, thread_id: threadId, turn_id: result.turnId };
  }

  async #respond(args: Record<string, unknown>): Promise<unknown> {
    const method = requiredString(args, "method", 300);
    if (!SUPPORTED_RESPONSE_METHODS.has(method)) {
      throw new Error(
        `Unsupported codex_respond method: ${method}. The pending request was not consumed and no response was sent.`,
      );
    }
    onlyKeys(args, [
      "request_id",
      "thread_id",
      "turn_id",
      "method",
      "decision",
      "answers",
      "response",
    ]);
    const requestIdValue = args.request_id;
    if (
      !(
        (typeof requestIdValue === "string" && requestIdValue.length > 0) ||
        (typeof requestIdValue === "number" && Number.isInteger(requestIdValue))
      )
    ) {
      throw new Error("request_id must preserve the original non-empty string or integer id");
    }
    const requestId = requestIdValue as RpcId;
    const threadId = requiredString(args, "thread_id", 200);
    const turnId = optionalString(args, "turn_id", 200);
    const decision = enumValue(args, "decision", ["accept", "decline", "cancel"] as const);
    const answers = args.answers;
    const generic = args.response;
    const supplied = [decision !== undefined, answers !== undefined, generic !== undefined].filter(Boolean).length;
    if (supplied !== 1) {
      throw new Error("Provide exactly one of decision, answers, or response");
    }

    await this.#authorizeControlThread(threadId);
    const pending = this.appServer.runtime.peekPending(requestId, {
      threadId,
      method,
      ...(turnId ? { turnId } : {}),
    });
    if (pending.turnId && !turnId) {
      throw new Error("turn_id is required for this pending request");
    }
    if (decision === "accept") {
      this.#guardApprovalAccept(method, pending);
    }

    let response: Record<string, unknown>;
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "execCommandApproval" ||
      method === "applyPatchApproval"
    ) {
      if (decision) {
        if (method === "execCommandApproval" || method === "applyPatchApproval") {
          const legacyDecision = decision === "accept"
            ? "approved"
            : decision === "cancel"
                ? "abort"
                : "denied";
          response = { decision: legacyDecision };
        } else {
          response = { decision };
        }
      } else {
        throw new Error("Approval requests require decision");
      }
    } else if (method === "item/tool/requestUserInput") {
      response = answers !== undefined ? { answers: asObject(answers, "answers") } : asObject(generic, "response");
    } else {
      throw new Error(`Unsupported codex_respond method: ${method}`);
    }

    this.appServer.runtime.takePending(requestId, {
      threadId,
      method,
      ...(turnId ? { turnId } : {}),
    });
    try {
      await this.appServer.respond(requestId, response);
    } catch (error) {
      this.appServer.runtime.restorePending(pending);
      throw error;
    }
    return {
      responded: true,
      request_id: requestId,
      thread_id: threadId,
      turn_id: pending.turnId ?? null,
      method,
    };
  }

  async #interrupt(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "turn_id"]);
    const threadId = requiredString(args, "thread_id", 200);
    const turnId = requiredString(args, "turn_id", 200);
    await this.#authorizeControlThread(threadId);
    await this.appServer.request("turn/interrupt", { threadId, turnId });
    return { interrupted: true, thread_id: threadId, turn_id: turnId };
  }
}
