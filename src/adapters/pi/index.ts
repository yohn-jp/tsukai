import { createRunService } from "../../application/index.js";
import { DEFAULT_LIMITS, type RuntimeLimits } from "../../contracts/limits.js";
import { validatePromptRunInput } from "../prompt-input.js";
import type {
  ExecutionObserver,
  ExecutionPort,
  JournalPort,
} from "../../contracts/ports.js";
import type { DurableStore } from "../../contracts/durable.js";
import type { RunService } from "../../contracts/service.js";
import type {
  HarnessAdapter,
  HarnessCapabilities,
} from "../../contracts/harness.js";
import type {
  PiDuplexExecution,
  PiDuplexExecutionPort,
  PiRunCreateInput,
  PiRunRequest,
  PiTransportObserver,
} from "../../contracts/pi.js";
import type {
  ExecutionBinding,
  PhysicalReceipt,
} from "../../contracts/types.js";
import type { ResumeOutcome } from "../../contracts/ports.js";
import { createMemoryJournal } from "../../observation/journal.js";
import { createPiRpcClient, type PiRpcClient } from "./protocol.js";
import { createPiHarness } from "./semantic.js";
import { capabilitiesForPort } from "../profile.js";
import {
  PI_EXECUTION_PROFILE_CAPABILITIES,
  piModelMatches,
} from "./profile.js";

/** Published `@earendil-works/pi-coding-agent` npm version certified for Pi RPC. */
export const SUPPORTED_PI_VERSION = "0.99.1";
/** Upstream commit of the audited Pi `v0.99.1` release tag. */
export const SUPPORTED_PI_REVISION = "d86654abb8862e201933517d6f1fce9f88dd117f";

/** Machine-readable capabilities of the Pi RPC adapter (Pi-native evidence under `pi`). */
export const PI_CAPABILITIES: Readonly<HarnessCapabilities> = Object.freeze({
  schemaVersion: 1,
  harness: { name: "pi", version: SUPPORTED_PI_VERSION },
  protocol: "pi-rpc-jsonl",
  evidenceNamespace: "pi",
  session: { identity: "before-prompt" },
  prompt: { delivery: "single", acceptance: "acknowledged" },
  settlement: { evidence: "pi:agent_settled" },
  cancellation: { abort: "native", retirement: "execution-owner" },
  // Pi RPC has steer/follow_up commands; Tsukai's one-submission AgentRun
  // does not route them.
  steer: { tsukai: "unsupported", native: "available" },
  followUp: { tsukai: "unsupported", native: "available" },
  interaction: { tsukai: "unsupported", native: "available" },
  observations: {
    tools: "reported",
    toolDurations: "reported",
    usage: "reported",
    cost: "reported",
    retry: "reported",
    compaction: "reported",
  },
  recovery: { reattach: "output-replay" },
  executionProfile: PI_EXECUTION_PROFILE_CAPABILITIES,
} satisfies HarnessCapabilities) as Readonly<HarnessCapabilities>;

export interface PiRuntimeOptions {
  /** Physical ownership is supplied by the caller; this adapter never spawns Pi. */
  execution: PiDuplexExecutionPort;
  piVersion: string;
  /** Upstream release commit of the certified published Pi artifact. */
  piRevision: string;
  journal?: JournalPort;
  /**
   * Durable registry and metadata-only journal. It is also the journal; passing
   * a separate `journal` together with it is rejected.
   */
  durableStore?: DurableStore;
  limits?: Partial<RuntimeLimits>;
  commandTimeoutMs?: number;
}

export interface PiRuntime extends RunService<PiRunRequest, "pi"> {
  journal: JournalPort;
}

function validatePiInput(
  input: PiRunCreateInput,
  limits: RuntimeLimits,
): PiRunCreateInput {
  return validatePromptRunInput(input, limits, "pi", "Pi");
}

interface ActivePi {
  transport: PiDuplexExecution;
  client: PiRpcClient;
  retirement?: Promise<void>;
  startup?: Promise<void>;
}

export type PiHarnessAdapterOptions = Pick<
  PiRuntimeOptions,
  "execution" | "piVersion" | "piRevision" | "limits" | "commandTimeoutMs"
>;

/**
 * The Pi RPC harness adapter for the canonical RunService. Execution is the
 * injected owner (Jinushi in production); this adapter never spawns Pi.
 */
export function createPiHarnessAdapter(
  options: PiHarnessAdapterOptions,
): HarnessAdapter<PiRunRequest, "pi"> {
  if (options.piVersion !== SUPPORTED_PI_VERSION) {
    throw new RangeError(
      `Unsupported Pi RPC version: ${String(options.piVersion)}`,
    );
  }
  if (options.piRevision !== SUPPORTED_PI_REVISION) {
    throw new RangeError(
      `Unsupported Pi RPC revision: ${String(options.piRevision)}`,
    );
  }
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new RangeError("commandTimeoutMs must be positive and finite");
  }
  const active = new Map<string, ActivePi>();
  let disposed = false;

  const execution: ExecutionPort<PiRunRequest> = {
    async start(
      agentRunId,
      request,
      observer: ExecutionObserver,
      workspace,
      profile,
    ): Promise<ExecutionBinding> {
      if (disposed) throw new Error("Pi runtime has been disposed");
      if (
        profile !== undefined &&
        options.execution.executionProfile !== "projected"
      ) {
        throw new Error(
          "Pi execution port cannot project an execution profile",
        );
      }
      let client: PiRpcClient | undefined;
      let transport: PiDuplexExecution | undefined;
      let exited = false;
      let failed = false;
      let earlyFailure: Error | undefined;
      const early: Uint8Array[] = [];
      let earlyBytes = 0;
      const earlyEvents: { frame: Uint8Array; start: number; end: number }[] =
        [];
      let earlyEventBytes = 0;
      let promptContractVerified = false;
      let boundary = 0;
      let established = false;
      // Record-aligned cursor: never past a frame the application has not seen.
      const appliedCursor = (): number =>
        earlyEvents.length > 0 ? earlyEvents[0]!.start : boundary;
      const fail = (error: Error): void => {
        if (failed) return;
        failed = true;
        if (!transport) earlyFailure = error;
        client?.fail(error);
        observer.onError(error);
        if (transport) void transport.retire("cancel").catch(() => undefined);
      };
      const wireObserver: PiTransportObserver = {
        onStdout(chunk: Uint8Array): void {
          if (client) {
            try {
              client.push(chunk);
            } catch (error) {
              fail(
                error instanceof Error
                  ? error
                  : new Error("Pi protocol failed"),
              );
            }
          } else {
            earlyBytes += chunk.byteLength;
            if (earlyBytes > limits.maxQueuedInputBytes) {
              fail(new Error("Pi early stdout exceeds buffer limit"));
              return;
            }
            early.push(new Uint8Array(chunk));
          }
        },
        onStderr(_chunk: Uint8Array): void {
          /* Diagnostics are owned and bounded by the execution port. */
        },
        onExit(receipt: PhysicalReceipt): void {
          exited = true;
          try {
            client?.finish();
          } catch (error) {
            observer.onError(
              error instanceof Error ? error : new Error("Pi EOF failed"),
            );
          }
          observer.onExit(receipt);
          if (transport?.executionRunId === receipt.executionRunId)
            active.delete(receipt.executionRunId);
        },
        onError(error: Error): void {
          fail(error);
        },
        onProgress(cursor): void {
          if (!established) return;
          observer.onProgress?.({
            eventSeq: cursor.eventSeq,
            stdoutOffset: appliedCursor(),
            stderrOffset: cursor.stderrOffset,
          });
        },
      };
      transport = await options.execution.open(
        agentRunId,
        wireObserver,
        workspace,
        ...(profile === undefined ? [] : [profile]),
      );
      const opened = transport;
      try {
        // The backend identity is durable before any prompt can be written.
        await observer.onEstablished?.({
          executionRunId: opened.executionRunId,
          backend: opened.backend,
          ...(opened.pid === undefined ? {} : { pid: opened.pid }),
          piVersion: options.piVersion,
          piRevision: options.piRevision,
        });
      } catch (error) {
        void opened.retire("cancel").catch(() => undefined);
        throw error;
      }
      established = true;
      client = createPiRpcClient(
        opened,
        (record, frame, meta) => {
          if (record.type === "extension_ui_request") {
            observer.onSignal?.({
              type: "settlement",
              status: "error",
              reason: "pi-required-interaction-unsupported",
            });
            void opened.retire("cancel").catch(() => undefined);
            return;
          }
          if (!promptContractVerified) {
            earlyEventBytes += frame.byteLength;
            if (earlyEventBytes > limits.maxQueuedInputBytes) {
              fail(
                new Error(
                  "Pi event buffer exceeded before prompt contract verification",
                ),
              );
              return;
            }
            earlyEvents.push({ frame, start: meta.start, end: meta.end });
            return;
          }
          observer.onOutput(frame, `pi:stdout:${meta.end}`);
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
      for (const chunk of early) client.push(chunk);
      early.length = 0;
      earlyBytes = 0;
      if (exited) client.finish();
      if (earlyFailure) {
        client.fail(earlyFailure);
        void opened.retire("cancel").catch(() => undefined);
      }
      const state: ActivePi = { transport: opened, client };
      if (!exited) active.set(opened.executionRunId, state);

      state.startup = (async () => {
        try {
          const stateResponse = await client!.request(
            { type: "get_state" },
            commandTimeoutMs,
          );
          const data = stateResponse.data;
          const sessionId =
            data && typeof data === "object" && "sessionId" in data
              ? (data as { sessionId: unknown }).sessionId
              : undefined;
          if (
            !stateResponse.success ||
            typeof sessionId !== "string" ||
            !sessionId ||
            Buffer.byteLength(sessionId, "utf8") > 256
          ) {
            throw new Error(
              "Pi get_state did not establish a bounded sessionId",
            );
          }
          observer.onBindingUpdate?.({
            executionRunId: opened.executionRunId,
            backend: opened.backend,
            ...(opened.pid === undefined ? {} : { pid: opened.pid }),
            sessionId,
            piVersion: options.piVersion,
            piRevision: options.piRevision,
          });
          observer.onSignal?.({
            type: "observation",
            draft: {
              source: "harness",
              kind: "harness.session",
              sourceIdentity: "pi:session",
              payload: {
                sessionId,
                piVersion: options.piVersion,
                piRevision: options.piRevision,
              },
            },
          });
          if (profile !== undefined) {
            // The admitted model must be the one Pi actually selected; Pi's
            // fuzzy/`:thinking` resolution never silently substitutes it.
            const reported =
              data && typeof data === "object" && "model" in data
                ? (data as { model: unknown }).model
                : undefined;
            const matches = piModelMatches(profile.effective, reported);
            const model =
              reported && typeof reported === "object"
                ? (reported as { provider?: unknown; id?: unknown })
                : {};
            observer.onSignal?.({
              type: "observation",
              draft: {
                source: "harness",
                kind: "harness.profile",
                sourceIdentity: "pi:profile",
                payload: {
                  fingerprint: profile.effective.fingerprint,
                  modelVerified:
                    profile.effective.model === undefined
                      ? "not-requested"
                      : matches
                        ? "exact"
                        : "mismatch",
                  ...(typeof model.provider === "string" &&
                  Buffer.byteLength(model.provider, "utf8") <= 128
                    ? { reportedProvider: model.provider }
                    : {}),
                  ...(typeof model.id === "string" &&
                  Buffer.byteLength(model.id, "utf8") <= 256
                    ? { reportedModel: model.id }
                    : {}),
                },
              },
            });
            if (!matches) {
              // No prompt is written under a model other than the admitted one.
              observer.onSignal?.({
                type: "settlement",
                status: "error",
                reason: "pi-model-mismatch",
              });
              return;
            }
          }
          observer.onDispatch?.("requested"); // durable before the write
          const response = await client!.request(
            { type: "prompt", message: request.prompt },
            commandTimeoutMs,
          );
          const disposition =
            response.data &&
            typeof response.data === "object" &&
            "disposition" in response.data
              ? (response.data as { disposition: unknown }).disposition
              : undefined;
          if (!response.success || disposition !== "started") {
            earlyEvents.length = 0;
            earlyEventBytes = 0;
            const reason = !response.success
              ? "pi-prompt-rejected"
              : disposition === "queued" || disposition === "handled"
                ? `pi-prompt-${disposition}`
                : "pi-rpc-disposition-unsupported";
            observer.onSignal?.({
              type: "settlement",
              status: "error",
              reason,
            });
            return;
          }
          promptContractVerified = true;
          observer.onDispatch?.("accepted");
          observer.onSignal?.({
            type: "observation",
            draft: {
              source: "harness",
              kind: "harness.prompt_accepted",
              sourceIdentity: "pi:prompt_accepted",
              payload: { disposition: "started" },
            },
          });
          const flush = earlyEvents.splice(0);
          earlyEventBytes = 0;
          for (const entry of flush)
            observer.onOutput(entry.frame, `pi:stdout:${entry.end}`);
        } catch (error) {
          fail(
            error instanceof Error ? error : new Error("Pi handshake failed"),
          );
        }
      })();

      return {
        executionRunId: opened.executionRunId,
        backend: opened.backend,
        ...(opened.pid === undefined ? {} : { pid: opened.pid }),
        piVersion: options.piVersion,
        piRevision: options.piRevision,
      };
    },
    async input(): Promise<void> {
      throw new Error("Pi runtime has no fixture input gate");
    },
    async retire(executionRunId, reason): Promise<void> {
      const state = active.get(executionRunId);
      if (!state) throw new Error("Unknown Pi execution");
      if (state.retirement) return state.retirement;
      state.retirement = (async () => {
        if (reason === "settled") await state.startup;
        if (reason === "cancel") {
          try {
            await state.client.request(
              { type: "abort" },
              Math.min(commandTimeoutMs, 2_000),
            );
          } catch {
            /* Abort acknowledgement is not physical or semantic proof. */
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
        // A lost close-input acknowledgement cannot prevent a physical
        // retirement request. The close outcome remains uncertain to callers.
        await state.transport.retire(reason);
        if (closeFailed) throw closeError;
      })();
      return state.retirement;
    },
    async resume(binding, observer, cursor): Promise<ResumeOutcome> {
      if (disposed) throw new Error("Pi runtime has been disposed");
      const port = options.execution;
      if (port.attach === undefined) {
        return { status: "ambiguous", reason: "execution-port-cannot-attach" };
      }
      let client: PiRpcClient | undefined;
      let transport: PiDuplexExecution | undefined;
      let failed = false;
      let exited = false;
      let boundary = 0;
      // A resumed observation failure never retires the process: losing sight
      // of an execution is not a reason to kill it.
      const fail = (error: Error): void => {
        if (failed) return;
        failed = true;
        client?.fail(error);
        observer.onError(error);
      };
      const wire: PiTransportObserver = {
        onStdout(chunk): void {
          try {
            client?.push(chunk);
          } catch (error) {
            fail(
              error instanceof Error ? error : new Error("Pi protocol failed"),
            );
          }
        },
        onStderr(): void {
          /* Diagnostics are owned and bounded by the execution port. */
        },
        onExit(receipt: PhysicalReceipt): void {
          exited = true;
          try {
            client?.finish();
          } catch (error) {
            observer.onError(
              error instanceof Error ? error : new Error("Pi EOF failed"),
            );
          }
          observer.onExit(receipt);
          if (receipt.executionRunId === binding.executionRunId)
            active.delete(receipt.executionRunId);
        },
        onError: fail,
        onProgress(progress): void {
          observer.onProgress?.({
            eventSeq: progress.eventSeq,
            stdoutOffset: boundary,
            stderrOffset: progress.stderrOffset,
          });
        },
      };
      const onForeignResponse = (record: Record<string, unknown>): void => {
        // Responses written by an earlier owner. They only recover facts.
        const data = record.data;
        if (record.command === "get_state" && record.success === true) {
          const sessionId =
            data && typeof data === "object" && "sessionId" in data
              ? (data as { sessionId: unknown }).sessionId
              : undefined;
          if (
            binding.sessionId === undefined &&
            typeof sessionId === "string" &&
            sessionId.length > 0 &&
            Buffer.byteLength(sessionId, "utf8") <= 256
          ) {
            observer.onBindingUpdate?.({
              ...binding,
              sessionId,
              piVersion: options.piVersion,
              piRevision: options.piRevision,
            });
            observer.onSignal?.({
              type: "observation",
              draft: {
                source: "harness",
                kind: "harness.session",
                sourceIdentity: "pi:session",
                payload: {
                  sessionId,
                  piVersion: options.piVersion,
                  piRevision: options.piRevision,
                },
              },
            });
          }
        } else if (record.command === "prompt") {
          const disposition =
            data && typeof data === "object" && "disposition" in data
              ? (data as { disposition: unknown }).disposition
              : undefined;
          if (record.success === true && disposition === "started") {
            observer.onDispatch?.("accepted");
            observer.onSignal?.({
              type: "observation",
              draft: {
                source: "harness",
                kind: "harness.prompt_accepted",
                sourceIdentity: "pi:prompt_accepted",
                payload: { disposition: "started" },
              },
            });
          } else {
            observer.onSignal?.({
              type: "settlement",
              status: "error",
              reason:
                record.success !== true
                  ? "pi-prompt-rejected"
                  : disposition === "queued" || disposition === "handled"
                    ? `pi-prompt-${String(disposition)}`
                    : "pi-rpc-disposition-unsupported",
            });
          }
        }
      };
      const result = await port.attach(
        binding.executionRunId,
        wire,
        { eventSeq: cursor.eventSeq, stderrOffset: cursor.stderrOffset },
        (opened) => {
          transport = opened;
          client = createPiRpcClient(
            opened,
            (record, frame, meta) => {
              if (record.type === "extension_ui_request") {
                if (meta.historical) return;
                observer.onSignal?.({
                  type: "settlement",
                  status: "error",
                  reason: "pi-required-interaction-unsupported",
                });
                void opened.retire("cancel").catch(() => undefined);
                return;
              }
              if (meta.historical) observer.onReplay?.(frame);
              else observer.onOutput(frame, `pi:stdout:${meta.end}`);
            },
            {
              maxRecordBytes: limits.maxRecordBytes,
              maxBufferedBytes: limits.maxQueuedInputBytes,
              replayUntil: cursor.stdoutOffset,
              onForeignResponse,
              onRecordEnd: (end) => {
                boundary = end;
              },
              onFailure: fail,
            },
          );
          active.set(opened.executionRunId, { transport: opened, client });
        },
      );
      if (result.status !== "attached") {
        if (transport !== undefined) active.delete(transport.executionRunId);
        return result;
      }
      if (exited) active.delete(binding.executionRunId);
      return { status: "attached", physical: exited ? "terminal" : "running" };
    },
    async detach(): Promise<void> {
      disposed = true;
      await options.execution.detach?.();
    },
    async dispose(): Promise<void> {
      disposed = true;
      await options.execution.dispose();
    },
  };

  return {
    identity: { name: "pi", version: options.piVersion },
    capabilities: structuredClone(
      capabilitiesForPort(PI_CAPABILITIES, options.execution),
    ) as HarnessCapabilities,
    execution,
    harness: createPiHarness(limits),
    validateInput: validatePiInput,
  };
}

/** Creates the Pi adapter over an injected execution owner. No direct spawn path exists here. */
export function createPiRuntime(options: PiRuntimeOptions): PiRuntime {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (
    options.durableStore !== undefined &&
    options.journal !== undefined &&
    options.journal !== options.durableStore
  ) {
    throw new TypeError("durableStore is also the journal; do not pass both");
  }
  const adapter = createPiHarnessAdapter(options);
  const journal =
    options.durableStore ?? options.journal ?? createMemoryJournal(limits);
  const service = createRunService<PiRunRequest, "pi">({
    execution: adapter.execution,
    harness: adapter.harness,
    journal,
    ...(options.durableStore === undefined
      ? {}
      : { durableStore: options.durableStore }),
    limits,
    harnessIdentity: adapter.identity,
    capabilities: adapter.capabilities,
    validateInput: validatePiInput,
  });
  return {
    runs: service.runs,
    reconcile: () => service.reconcile(),
    detach: () => service.detach(),
    dispose: () => service.dispose(),
    journal,
  };
}

export {
  PI_BUILTIN_TOOLS,
  PI_EXECUTION_PROFILE_CAPABILITIES,
} from "./profile.js";
