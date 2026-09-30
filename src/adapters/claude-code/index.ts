import { createRunService } from "../../application/index.js";
import { DEFAULT_LIMITS, type RuntimeLimits } from "../../contracts/limits.js";
import type {
  DuplexExecution,
  DuplexExecutionPort,
  DuplexTransportObserver,
  HarnessAdapter,
  HarnessCapabilities,
} from "../../contracts/harness.js";
import type {
  ExecutionObserver,
  ExecutionPort,
  JournalPort,
  ResumeOutcome,
} from "../../contracts/ports.js";
import type { DurableStore } from "../../contracts/durable.js";
import type { RunService } from "../../contracts/service.js";
import type {
  ExecutionBinding,
  PhysicalReceipt,
  RunCreateInput,
} from "../../contracts/types.js";
import { createMemoryJournal } from "../../observation/journal.js";
import { validatePromptRunInput } from "../prompt-input.js";
import { createClaudeCodeClient, type ClaudeCodeClient } from "./protocol.js";
import { CLAUDE_CODE_NAMESPACE, createClaudeCodeHarness } from "./semantic.js";
import { capabilitiesForPort } from "../profile.js";
import { CLAUDE_CODE_EXECUTION_PROFILE_CAPABILITIES } from "./profile.js";

/**
 * Claude Code CLI version whose headless stream-json protocol was verified
 * (installed CLI plus `@anthropic-ai/claude-agent-sdk@0.3.285` message types).
 */
export const SUPPORTED_CLAUDE_CODE_VERSION = "2.1.285";

export interface ClaudeCodeRunRequest {
  prompt: string;
}
export type ClaudeCodeRunCreateInput = RunCreateInput<
  ClaudeCodeRunRequest,
  "claude-code"
>;

/** Machine-readable capabilities of the Claude Code stream-json adapter. */
export const CLAUDE_CODE_CAPABILITIES: Readonly<HarnessCapabilities> =
  Object.freeze({
    schemaVersion: 1,
    harness: { name: "claude-code", version: SUPPORTED_CLAUDE_CODE_VERSION },
    protocol: "claude-code-stream-json",
    evidenceNamespace: CLAUDE_CODE_NAMESPACE,
    // `system/init` (with session_id) is written only after the first user
    // message arrives, so identity and prompt receipt are both implicit.
    session: { identity: "after-prompt" },
    prompt: { delivery: "single", acceptance: "implicit" },
    settlement: { evidence: "claude-code:result" },
    // `control_request` subtype `interrupt`; the acknowledgement is not
    // physical or semantic proof.
    cancellation: { abort: "native", retirement: "execution-owner" },
    steer: { tsukai: "unsupported", native: "unverified" },
    // Streaming input queues further user messages as later turns.
    followUp: { tsukai: "unsupported", native: "available" },
    // Permission prompts arrive as `control_request` `can_use_tool`.
    interaction: { tsukai: "unsupported", native: "available" },
    observations: {
      tools: "reported",
      toolDurations: "unavailable",
      usage: "reported",
      cost: "estimated",
      retry: "reported",
      compaction: "reported",
    },
    recovery: { reattach: "output-replay" },
    executionProfile: CLAUDE_CODE_EXECUTION_PROFILE_CAPABILITIES,
  } satisfies HarnessCapabilities) as Readonly<HarnessCapabilities>;

export interface ClaudeCodeHarnessAdapterOptions {
  /** Physical ownership is supplied by the caller (Jinushi in production). */
  execution: DuplexExecutionPort;
  claudeCodeVersion: string;
  limits?: Partial<RuntimeLimits>;
  commandTimeoutMs?: number;
}

export interface ClaudeCodeRuntimeOptions extends ClaudeCodeHarnessAdapterOptions {
  journal?: JournalPort;
  durableStore?: DurableStore;
}

export interface ClaudeCodeRuntime extends RunService<
  ClaudeCodeRunRequest,
  "claude-code"
> {
  journal: JournalPort;
}

function validateClaudeCodeInput(
  input: ClaudeCodeRunCreateInput,
  limits: RuntimeLimits,
): ClaudeCodeRunCreateInput {
  return validatePromptRunInput(input, limits, "claude-code", "Claude Code");
}

interface ActiveClaude {
  transport: DuplexExecution;
  client: ClaudeCodeClient;
  settled: boolean;
  startup?: Promise<void>;
  retirement?: Promise<void>;
}

function sessionFromInit(
  record: Record<string, unknown>,
): { sessionId: string; version: string | undefined } | undefined {
  if (record.type !== "system" || record.subtype !== "init") return undefined;
  const sessionId = record.session_id;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    Buffer.byteLength(sessionId, "utf8") > 256
  ) {
    return undefined;
  }
  const version = record.claude_code_version;
  return {
    sessionId,
    version:
      typeof version === "string" && Buffer.byteLength(version, "utf8") <= 64
        ? version
        : undefined,
  };
}

/**
 * The Claude Code harness adapter for the canonical RunService. It is the sole
 * stream-json writer for its run and never spawns a process itself.
 */
export function createClaudeCodeHarnessAdapter(
  options: ClaudeCodeHarnessAdapterOptions,
): HarnessAdapter<ClaudeCodeRunRequest, "claude-code"> {
  if (options.claudeCodeVersion !== SUPPORTED_CLAUDE_CODE_VERSION) {
    throw new RangeError(
      `Unsupported Claude Code version: ${String(options.claudeCodeVersion)}`,
    );
  }
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new RangeError("commandTimeoutMs must be positive and finite");
  }
  const active = new Map<string, ActiveClaude>();
  let disposed = false;

  const bindingOf = (
    transport: DuplexExecution,
    session?: { sessionId: string; version: string | undefined },
  ): ExecutionBinding => ({
    executionRunId: transport.executionRunId,
    backend: transport.backend,
    ...(transport.pid === undefined ? {} : { pid: transport.pid }),
    ...(session === undefined ? {} : { sessionId: session.sessionId }),
    ...(session?.version === undefined
      ? {}
      : { harnessVersion: session.version }),
  });

  /**
   * Handles `system/init`. A reported version other than the certified one is
   * an explicit failure, never a silent compatibility guess.
   */
  const onInit = (
    record: Record<string, unknown>,
    transport: DuplexExecution,
    observer: ExecutionObserver,
  ): boolean => {
    const session = sessionFromInit(record);
    if (session === undefined) return true;
    observer.onBindingUpdate?.(bindingOf(transport, session));
    if (session.version !== options.claudeCodeVersion) {
      observer.onSignal?.({
        type: "settlement",
        status: "error",
        reason: "claude_code_version_mismatch",
      });
      void transport.retire("cancel").catch(() => undefined);
      return false;
    }
    return true;
  };

  /** Required interaction (permission prompts) is never answered for the agent. */
  const onControlRequest = (
    transport: DuplexExecution,
    observer: ExecutionObserver,
  ): void => {
    observer.onSignal?.({
      type: "settlement",
      status: "error",
      reason: "claude_code_required_interaction_unsupported",
    });
    void transport.retire("cancel").catch(() => undefined);
  };

  const execution: ExecutionPort<ClaudeCodeRunRequest> = {
    async start(agentRunId, request, observer, workspace, profile) {
      if (disposed) throw new Error("Claude Code runtime has been disposed");
      if (
        profile !== undefined &&
        options.execution.executionProfile !== "projected"
      ) {
        throw new Error(
          "Claude Code execution port cannot project an execution profile",
        );
      }
      let client: ClaudeCodeClient | undefined;
      let failed = false;
      let exited = false;
      let boundary = 0;
      let established = false;
      const early: Uint8Array[] = [];
      let earlyBytes = 0;
      let transport: DuplexExecution | undefined;
      let earlyFailure: Error | undefined;
      const fail = (error: Error): void => {
        if (failed) return;
        failed = true;
        if (!transport) earlyFailure = error;
        client?.fail(error);
        observer.onError(error);
        if (transport) void transport.retire("cancel").catch(() => undefined);
      };
      const wire: DuplexTransportObserver = {
        onStdout(chunk) {
          if (client) {
            client.push(chunk);
            return;
          }
          earlyBytes += chunk.byteLength;
          if (earlyBytes > limits.maxQueuedInputBytes) {
            fail(new Error("Claude Code early stdout exceeds buffer limit"));
            return;
          }
          early.push(new Uint8Array(chunk));
        },
        onStderr() {
          /* Diagnostics are owned and bounded by the execution port. */
        },
        onExit(receipt: PhysicalReceipt) {
          exited = true;
          client?.finish();
          observer.onExit(receipt);
          if (transport?.executionRunId === receipt.executionRunId)
            active.delete(receipt.executionRunId);
        },
        onError: fail,
        onProgress(cursor) {
          if (!established) return;
          observer.onProgress?.({
            eventSeq: cursor.eventSeq,
            stdoutOffset: boundary,
            stderrOffset: cursor.stderrOffset,
          });
        },
      };
      transport = await options.execution.open(
        agentRunId,
        wire,
        workspace,
        ...(profile === undefined ? [] : [profile]),
      );
      const opened = transport;
      try {
        // The backend identity is durable before the prompt can be written.
        await observer.onEstablished?.(bindingOf(opened));
      } catch (error) {
        void opened.retire("cancel").catch(() => undefined);
        throw error;
      }
      established = true;
      const state: ActiveClaude = {
        transport: opened,
        client: undefined as unknown as ClaudeCodeClient,
        settled: false,
      };
      client = createClaudeCodeClient(
        opened,
        (record, frame, meta) => {
          if (record.type === "control_request") {
            onControlRequest(opened, observer);
            return;
          }
          if (!onInit(record, opened, observer)) return;
          if (record.type === "result") state.settled = true;
          observer.onOutput(frame, `claude-code:stdout:${meta.end}`);
        },
        {
          maxRecordBytes: limits.maxRecordBytes,
          maxBufferedBytes: limits.maxQueuedInputBytes,
          onFailure: fail,
          onRecordEnd: (end) => {
            boundary = end;
          },
        },
      );
      state.client = client;
      for (const chunk of early) client.push(chunk);
      early.length = 0;
      if (exited) client.finish();
      if (earlyFailure) client.fail(earlyFailure);
      if (!exited) active.set(opened.executionRunId, state);
      state.startup = (async () => {
        try {
          observer.onDispatch?.("requested"); // durable before the write
          // No acceptance response exists; later harness output proves receipt.
          await client.sendUserMessage(request.prompt);
        } catch (error) {
          fail(
            error instanceof Error
              ? error
              : new Error("Claude Code prompt delivery failed"),
          );
        }
      })();
      return bindingOf(opened);
    },
    async input(): Promise<void> {
      throw new Error("Claude Code runtime has no fixture input gate");
    },
    async retire(executionRunId, reason) {
      const state = active.get(executionRunId);
      if (!state) throw new Error("Unknown Claude Code execution");
      if (state.retirement) return state.retirement;
      state.retirement = (async () => {
        if (reason === "settled") await state.startup;
        if (reason === "cancel" && !state.settled) {
          try {
            await state.client.interrupt(Math.min(commandTimeoutMs, 2_000));
          } catch {
            /* Interrupt acknowledgement is not physical or semantic proof. */
          }
        }
        let closeFailed = false;
        let closeError: unknown;
        try {
          await state.transport.closeInput();
        } catch (error) {
          closeFailed = true;
          closeError = error;
        }
        await state.transport.retire(reason);
        if (closeFailed) throw closeError;
      })();
      return state.retirement;
    },
    async resume(binding, observer, cursor): Promise<ResumeOutcome> {
      if (disposed) throw new Error("Claude Code runtime has been disposed");
      const port = options.execution;
      if (port.attach === undefined) {
        return { status: "ambiguous", reason: "execution-port-cannot-attach" };
      }
      let client: ClaudeCodeClient | undefined;
      let failed = false;
      let exited = false;
      let boundary = 0;
      // Losing sight of an execution is never a reason to retire it.
      const fail = (error: Error): void => {
        if (failed) return;
        failed = true;
        client?.fail(error);
        observer.onError(error);
      };
      const wire: DuplexTransportObserver = {
        onStdout(chunk) {
          client?.push(chunk);
        },
        onStderr() {
          /* Diagnostics are owned and bounded by the execution port. */
        },
        onExit(receipt) {
          exited = true;
          client?.finish();
          observer.onExit(receipt);
          if (receipt.executionRunId === binding.executionRunId)
            active.delete(receipt.executionRunId);
        },
        onError: fail,
        onProgress(progress) {
          observer.onProgress?.({
            eventSeq: progress.eventSeq,
            stdoutOffset: boundary,
            stderrOffset: progress.stderrOffset,
          });
        },
      };
      let opened: DuplexExecution | undefined;
      const result = await port.attach(
        binding.executionRunId,
        wire,
        { eventSeq: cursor.eventSeq, stderrOffset: cursor.stderrOffset },
        (execution) => {
          opened = execution;
          const state: ActiveClaude = {
            transport: execution,
            client: undefined as unknown as ClaudeCodeClient,
            settled: false,
          };
          client = createClaudeCodeClient(
            execution,
            (record, frame, meta) => {
              if (record.type === "control_request") {
                if (!meta.historical) onControlRequest(execution, observer);
                return;
              }
              if (record.type === "result") state.settled = true;
              if (meta.historical) {
                // Recover the session identity an earlier owner saw, if the
                // binding was persisted before it arrived.
                if (binding.sessionId === undefined) {
                  const session = sessionFromInit(record);
                  if (session !== undefined)
                    observer.onBindingUpdate?.({
                      ...binding,
                      ...bindingOf(execution, session),
                    });
                }
                observer.onReplay?.(frame);
                return;
              }
              if (!onInit(record, execution, observer)) return;
              observer.onOutput(frame, `claude-code:stdout:${meta.end}`);
            },
            {
              maxRecordBytes: limits.maxRecordBytes,
              maxBufferedBytes: limits.maxQueuedInputBytes,
              replayUntil: cursor.stdoutOffset,
              onRecordEnd: (end) => {
                boundary = end;
              },
              onFailure: fail,
            },
          );
          state.client = client;
          active.set(execution.executionRunId, state);
        },
      );
      if (result.status !== "attached") {
        if (opened !== undefined) active.delete(opened.executionRunId);
        return result;
      }
      if (exited) active.delete(binding.executionRunId);
      return { status: "attached", physical: exited ? "terminal" : "running" };
    },
    async detach() {
      disposed = true;
      await options.execution.detach?.();
    },
    async dispose() {
      disposed = true;
      await options.execution.dispose();
    },
  };

  return {
    identity: { name: "claude-code", version: options.claudeCodeVersion },
    capabilities: structuredClone(
      capabilitiesForPort(CLAUDE_CODE_CAPABILITIES, options.execution),
    ) as HarnessCapabilities,
    execution,
    harness: createClaudeCodeHarness(limits),
    validateInput: validateClaudeCodeInput,
  };
}

/** A single-harness Claude Code runtime over an injected execution owner. */
export function createClaudeCodeRuntime(
  options: ClaudeCodeRuntimeOptions,
): ClaudeCodeRuntime {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (
    options.durableStore !== undefined &&
    options.journal !== undefined &&
    options.journal !== options.durableStore
  ) {
    throw new TypeError("durableStore is also the journal; do not pass both");
  }
  const adapter = createClaudeCodeHarnessAdapter(options);
  const journal =
    options.durableStore ?? options.journal ?? createMemoryJournal(limits);
  const service = createRunService<ClaudeCodeRunRequest, "claude-code">({
    execution: adapter.execution,
    harness: adapter.harness,
    journal,
    ...(options.durableStore === undefined
      ? {}
      : { durableStore: options.durableStore }),
    limits,
    harnessIdentity: adapter.identity,
    capabilities: adapter.capabilities,
    validateInput: validateClaudeCodeInput,
  });
  return {
    runs: service.runs,
    reconcile: () => service.reconcile(),
    detach: () => service.detach(),
    dispose: () => service.dispose(),
    journal,
  };
}

export { CLAUDE_CODE_EXECUTION_PROFILE_CAPABILITIES } from "./profile.js";
