import { createRunService } from "../../application/index.js";
import { DEFAULT_LIMITS, type RuntimeLimits } from "../../contracts/limits.js";
import {
  FORBIDDEN_JSON_KEYS,
  isPrivateMetadataKey,
} from "../../contracts/privacy.js";
import type {
  ExecutionObserver,
  ExecutionPort,
  JournalPort,
} from "../../contracts/ports.js";
import type { RunService } from "../../contracts/service.js";
import type {
  PiDuplexExecution,
  PiDuplexExecutionPort,
  PiRunCreateInput,
  PiRunRequest,
} from "../../contracts/pi.js";
import type {
  ExecutionBinding,
  PhysicalReceipt,
} from "../../contracts/types.js";
import { createMemoryJournal } from "../../observation/journal.js";
import { createPiRpcClient, type PiRpcClient } from "./protocol.js";
import { createPiHarness } from "./semantic.js";

export const SUPPORTED_PI_VERSION = "0.87.1";
export const SUPPORTED_PI_REVISION = "2b0a123de98318c2ff8069661721ce0c3794c34e";

export interface PiRuntimeOptions {
  /** Physical ownership is supplied by the caller; this adapter never spawns Pi. */
  execution: PiDuplexExecutionPort;
  piVersion: string;
  /** Source revision used to build the certified Pi executable. */
  piRevision: string;
  journal?: JournalPort;
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
  if (!input || typeof input !== "object" || input.harness !== "pi") {
    throw new TypeError("Pi run input must select the pi harness");
  }
  const request = input.request;
  if (
    !request ||
    typeof request !== "object" ||
    typeof request.prompt !== "string" ||
    request.prompt.length === 0 ||
    Buffer.byteLength(request.prompt, "utf8") > limits.maxRecordBytes - 128
  ) {
    throw new TypeError("Pi prompt must be a bounded non-empty string");
  }
  const metadata = input.metadata ?? {};
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).length > limits.maxMetadataEntries
  ) {
    throw new TypeError("Pi run metadata is invalid or exceeds its limit");
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (
      key.length === 0 ||
      Buffer.byteLength(key, "utf8") > 128 ||
      FORBIDDEN_JSON_KEYS.has(key) ||
      isPrivateMetadataKey(key) ||
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > limits.maxMetadataValueBytes
    ) {
      throw new TypeError(
        "Pi run metadata contains an invalid or private value",
      );
    }
  }
  const workspace = input.workspace;
  if (
    workspace !== undefined &&
    (!workspace ||
      typeof workspace.cwd !== "string" ||
      workspace.cwd.length === 0 ||
      (workspace.workspaceSessionId !== undefined &&
        (typeof workspace.workspaceSessionId !== "string" ||
          workspace.workspaceSessionId.length === 0 ||
          Buffer.byteLength(workspace.workspaceSessionId, "utf8") > 256)))
  ) {
    throw new TypeError("Pi workspace configuration is invalid");
  }
  if (
    input.parentRunId !== undefined &&
    (typeof input.parentRunId !== "string" || input.parentRunId.length === 0)
  ) {
    throw new TypeError("parentRunId must be a non-empty string");
  }
  return {
    harness: "pi",
    request: { prompt: request.prompt },
    metadata: { ...metadata },
    ...(workspace === undefined ? {} : { workspace: { ...workspace } }),
    ...(input.parentRunId === undefined
      ? {}
      : { parentRunId: input.parentRunId }),
  };
}

interface ActivePi {
  transport: PiDuplexExecution;
  client: PiRpcClient;
  retirement?: Promise<void>;
  startup?: Promise<void>;
}

/** Creates the Pi adapter over an injected execution owner. No direct spawn path exists here. */
export function createPiRuntime(options: PiRuntimeOptions): PiRuntime {
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
  const journal = options.journal ?? createMemoryJournal(limits);
  let disposed = false;

  const execution: ExecutionPort<PiRunRequest> = {
    async start(
      agentRunId,
      request,
      observer: ExecutionObserver,
      workspace,
    ): Promise<ExecutionBinding> {
      if (disposed) throw new Error("Pi runtime has been disposed");
      let client: PiRpcClient | undefined;
      let transport: PiDuplexExecution | undefined;
      let exited = false;
      let failed = false;
      let earlyFailure: Error | undefined;
      const early: Uint8Array[] = [];
      let earlyBytes = 0;
      const earlyEvents: Uint8Array[] = [];
      let earlyEventBytes = 0;
      let promptContractVerified = false;
      const fail = (error: Error): void => {
        if (failed) return;
        failed = true;
        if (!transport) earlyFailure = error;
        client?.fail(error);
        observer.onError(error);
        if (transport) void transport.retire("cancel").catch(() => undefined);
      };
      const wireObserver = {
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
      };
      transport = await options.execution.open(
        agentRunId,
        wireObserver,
        workspace,
      );
      const opened = transport;
      client = createPiRpcClient(
        opened,
        (record, frame) => {
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
            earlyEvents.push(frame);
            return;
          }
          observer.onOutput(frame);
        },
        {
          maxRecordBytes: limits.maxRecordBytes,
          maxBufferedBytes: limits.maxQueuedInputBytes,
          onFailure: fail,
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
              payload: {
                sessionId,
                piVersion: options.piVersion,
                piRevision: options.piRevision,
              },
            },
          });
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
          observer.onSignal?.({
            type: "observation",
            draft: {
              source: "harness",
              kind: "harness.prompt_accepted",
              payload: { disposition: "started" },
            },
          });
          for (const frame of earlyEvents) observer.onOutput(frame);
          earlyEvents.length = 0;
          earlyEventBytes = 0;
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
        await state.transport.closeInput();
        await state.transport.retire(reason);
      })();
      return state.retirement;
    },
    async dispose(): Promise<void> {
      disposed = true;
      await options.execution.dispose();
    },
  };

  const service = createRunService<PiRunRequest, "pi">({
    execution,
    harness: createPiHarness(limits),
    journal,
    limits,
    harnessIdentity: { name: "pi", version: options.piVersion },
    validateInput: validatePiInput,
  });
  return { runs: service.runs, dispose: () => service.dispose(), journal };
}
