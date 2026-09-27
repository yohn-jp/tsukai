import { randomUUID } from "node:crypto";
import type { ExecutionObserver, HarnessSignal } from "../contracts/ports.js";
import type { RuntimeLimits } from "../contracts/limits.js";
import { DEFAULT_LIMITS } from "../contracts/limits.js";
import {
  FORBIDDEN_JSON_KEYS,
  isPrivateMetadataKey,
} from "../contracts/privacy.js";
import type {
  Activity,
  JsonObject,
  ObservationDraft,
  Page,
  PhysicalReceipt,
  RunCreateInput,
  RunResult,
  RunSnapshot,
  WaitOptions,
} from "../contracts/types.js";
import {
  RunNotFoundError,
  UnsupportedBackendError,
  WaitTimeoutError,
} from "../contracts/types.js";
import type { RunService, RunServiceOptions } from "../contracts/service.js";
import {
  changeRun,
  toSnapshot,
  type OutcomeCandidate,
  type RunRecord,
  type RunChanges,
} from "../domain/run-record.js";

const mockScenarios = new Set([
  "normal",
  "error",
  "crash",
  "retry",
  "quiet",
  "hold",
]);
const activities = new Set<Activity>([
  "output",
  "tool",
  "retry",
  "compaction",
  "input_wait",
  "idle",
  "unknown",
]);

function resolveLimits(
  overrides: Partial<RuntimeLimits> | undefined,
): RuntimeLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        `Runtime limit ${name} must be a non-negative safe integer`,
      );
    }
  }
  if (limits.maxPageSize < 1) {
    throw new RangeError("Runtime limit maxPageSize must be at least 1");
  }
  return limits;
}

function validateInput(
  input: RunCreateInput,
  limits: RuntimeLimits,
): RunCreateInput {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Run input must be an object");
  }
  const backend = (input as { harness?: unknown }).harness;
  if (backend !== "mock") {
    throw new UnsupportedBackendError(String(backend));
  }
  const request = (input as { request?: unknown }).request;
  if (
    request === null ||
    typeof request !== "object" ||
    !mockScenarios.has(String((request as { scenario?: unknown }).scenario))
  ) {
    throw new TypeError("Run request must select a supported mock scenario");
  }
  const requestRecord = request as {
    reportedText?: unknown;
    delayMs?: unknown;
  };
  if (
    requestRecord.reportedText !== undefined &&
    typeof requestRecord.reportedText !== "string"
  ) {
    throw new TypeError("reportedText must be a string");
  }
  if (
    requestRecord.delayMs !== undefined &&
    (typeof requestRecord.delayMs !== "number" ||
      !Number.isFinite(requestRecord.delayMs) ||
      requestRecord.delayMs < 0)
  ) {
    throw new TypeError("delayMs must be a non-negative finite number");
  }

  const metadataInput = (input as { metadata?: unknown }).metadata;
  if (
    metadataInput !== undefined &&
    (metadataInput === null ||
      typeof metadataInput !== "object" ||
      Array.isArray(metadataInput))
  ) {
    throw new TypeError("Run metadata must be a string record");
  }
  const metadata = Object.create(null) as Record<string, string>;
  const entries = Object.entries(
    (metadataInput ?? {}) as Record<string, unknown>,
  );
  if (entries.length > limits.maxMetadataEntries) {
    throw new RangeError("Run metadata has too many entries");
  }
  for (const [key, value] of entries) {
    if (
      key.length === 0 ||
      Buffer.byteLength(key, "utf8") > 128 ||
      FORBIDDEN_JSON_KEYS.has(key) ||
      isPrivateMetadataKey(key)
    ) {
      throw new TypeError(`Run metadata key is unsupported: ${key}`);
    }
    if (typeof value !== "string") {
      throw new TypeError("Run metadata values must be strings");
    }
    if (Buffer.byteLength(value, "utf8") > limits.maxMetadataValueBytes) {
      throw new RangeError(`Run metadata value for ${key} is too large`);
    }
    metadata[key] = value;
  }

  const workspaceInput = (input as { workspace?: unknown }).workspace;
  let workspace: RunCreateInput["workspace"];
  if (workspaceInput !== undefined) {
    if (
      workspaceInput === null ||
      typeof workspaceInput !== "object" ||
      typeof (workspaceInput as { cwd?: unknown }).cwd !== "string" ||
      (workspaceInput as { cwd: string }).cwd.length === 0 ||
      Buffer.byteLength((workspaceInput as { cwd: string }).cwd, "utf8") > 4096
    ) {
      throw new TypeError("Workspace must contain a cwd string");
    }
    const workspaceSessionId = (
      workspaceInput as { workspaceSessionId?: unknown }
    ).workspaceSessionId;
    if (
      workspaceSessionId !== undefined &&
      (typeof workspaceSessionId !== "string" ||
        workspaceSessionId.length === 0 ||
        Buffer.byteLength(workspaceSessionId, "utf8") > 256)
    ) {
      throw new TypeError("workspaceSessionId must be a string");
    }
    workspace = {
      cwd: (workspaceInput as { cwd: string }).cwd,
      ...(workspaceSessionId === undefined ? {} : { workspaceSessionId }),
    };
  }

  const parentRunId = (input as { parentRunId?: unknown }).parentRunId;
  if (
    parentRunId !== undefined &&
    (typeof parentRunId !== "string" || parentRunId.length === 0)
  ) {
    throw new TypeError("parentRunId must be a non-empty string");
  }

  const normalized: RunCreateInput = {
    harness: "mock",
    request: request as RunCreateInput["request"],
    ...(parentRunId === undefined ? {} : { parentRunId }),
    metadata,
    ...(workspace === undefined ? {} : { workspace }),
  };
  const projectedInputSize = Buffer.byteLength(
    JSON.stringify({
      metadata,
      ...(workspace === undefined ? {} : { workspace }),
    }),
    "utf8",
  );
  if (projectedInputSize > limits.maxRecordBytes) {
    throw new RangeError(
      "Run metadata and workspace exceed the record size limit",
    );
  }
  return normalized;
}

function isSettled(run: RunRecord): boolean {
  return run.lifecycle === "terminal" || run.lifecycle === "uncertain";
}

function abortError(): Error {
  const error = new Error("Wait was aborted");
  error.name = "AbortError";
  return error;
}

function cloneReceipt(receipt: PhysicalReceipt): PhysicalReceipt {
  return {
    executionRunId: receipt.executionRunId,
    status: receipt.status,
    exitCode: receipt.exitCode,
    signal: receipt.signal,
    forced: receipt.forced,
  };
}

function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function createRunService(options: RunServiceOptions): RunService {
  const limits = resolveLimits(options.limits);
  const runs = new Map<string, RunRecord>();
  const order: string[] = [];
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  const requireRun = (agentRunId: string): RunRecord => {
    const run = runs.get(agentRunId);
    if (run === undefined) throw new RunNotFoundError(agentRunId);
    return run;
  };

  const append = (
    run: RunRecord,
    draft: Omit<ObservationDraft, "runId">,
  ): void => {
    options.journal.append({ runId: run.agentRunId, ...draft });
  };

  const appendSnapshot = (run: RunRecord): void => {
    append(run, {
      source: "runtime",
      kind: "run.snapshot",
      payload: toJsonObject({ snapshot: toSnapshot(run) }),
    });
  };

  const notify = (run: RunRecord): void => {
    for (const wake of run.waiters) wake();
  };

  const update = (run: RunRecord, changes: RunChanges): boolean => {
    if (!changeRun(run, changes)) return false;
    appendSnapshot(run);
    notify(run);
    return true;
  };

  const markUncertain = (run: RunRecord, reason: string): void => {
    if (run.lifecycle === "terminal") return;
    append(run, {
      source: "execution",
      kind: "execution.uncertain",
      payload: { reason },
    });
    const changes: RunChanges = {
      lifecycle: "uncertain",
      completeness: "incomplete",
      reason: run.outcomeCandidate?.reason ?? reason,
    };
    if (run.outcomeCandidate === undefined) changes.semantic = "unknown";
    update(run, changes);
  };

  const finalizeFromReceipt = (run: RunRecord): void => {
    const receipt = run.receipt;
    if (
      receipt === undefined ||
      run.execution === undefined ||
      run.lifecycle === "terminal"
    )
      return;
    if (receipt.executionRunId !== run.execution.executionRunId) {
      markUncertain(run, "execution-receipt-mismatch");
      return;
    }
    if (receipt.status === "uncertain") {
      const changes: RunChanges = {
        lifecycle: "uncertain",
        completeness: "incomplete",
        receipt: cloneReceipt(receipt),
      };
      if (run.outcomeCandidate === undefined) {
        changes.semantic = "unknown";
        changes.reason = "execution-status-uncertain";
      }
      update(run, changes);
      return;
    }

    if (run.outcomeCandidate !== undefined) {
      const candidate = run.outcomeCandidate;
      update(run, {
        lifecycle: "terminal",
        semantic: candidate.semantic,
        outcome: candidate.outcome,
        reason: candidate.reason,
        receipt: cloneReceipt(receipt),
      });
      return;
    }

    update(run, {
      lifecycle: "terminal",
      semantic: "unknown",
      outcome: "interrupted",
      reason: "execution-exited-before-settlement",
      completeness: "incomplete",
      receipt: cloneReceipt(receipt),
    });
  };

  const requestRetirement = async (
    run: RunRecord,
    reason: "settled" | "cancel",
  ): Promise<void> => {
    const binding = run.execution;
    if (
      binding === undefined ||
      run.lifecycle === "terminal" ||
      run.retirementRequests.has(reason)
    ) {
      return;
    }
    run.retirementRequests.add(reason);
    try {
      await options.execution.retire(binding.executionRunId, reason);
    } catch {
      markUncertain(run, "execution-retirement-unconfirmed");
    }
  };

  const acceptCandidate = (
    run: RunRecord,
    candidate: OutcomeCandidate,
  ): void => {
    if (run.outcomeCandidate !== undefined || run.lifecycle === "terminal")
      return;
    run.outcomeCandidate = candidate;
    if (candidate.reportedText !== undefined)
      run.reportedText = candidate.reportedText;
    append(run, {
      source: "harness",
      kind: "harness.settlement",
      payload: {
        status:
          candidate.semantic === "settled"
            ? "success"
            : candidate.semantic === "failed"
              ? "error"
              : "abort",
      },
    });
    const lifecycle =
      run.lifecycle === "uncertain" || run.lifecycle === "reconciling"
        ? run.lifecycle
        : "stopping";
    update(run, {
      lifecycle,
      semantic: candidate.semantic,
      reason: candidate.reason,
    });
    void requestRetirement(
      run,
      candidate.outcome === "cancelled" ? "cancel" : "settled",
    );
  };

  const processSignals = (run: RunRecord, signals: HarnessSignal[]): void => {
    for (const signal of signals) {
      if (run.lifecycle === "terminal") return;
      if (signal.type === "observation") {
        append(run, {
          ...signal.draft,
          source: signal.draft.source ?? "harness",
        });
        const fromPayload = signal.draft.payload.activity;
        const activity =
          typeof fromPayload === "string" &&
          activities.has(fromPayload as Activity)
            ? (fromPayload as Activity)
            : activities.has(signal.draft.kind as Activity)
              ? (signal.draft.kind as Activity)
              : "unknown";
        update(run, {
          activity,
          ...(run.outcomeCandidate === undefined ? { semantic: "active" } : {}),
        });
        continue;
      }

      const candidate: OutcomeCandidate =
        signal.status === "success"
          ? {
              outcome: "completed",
              semantic: "settled",
              reason: signal.reason || "harness-settled-success",
              ...(signal.reportedText === undefined
                ? {}
                : { reportedText: signal.reportedText }),
            }
          : signal.status === "error"
            ? {
                outcome: "failed",
                semantic: "failed",
                reason: signal.reason || "harness-settled-error",
              }
            : {
                outcome: "interrupted",
                semantic: "aborted",
                reason: signal.reason || "harness-settled-abort",
              };
      acceptCandidate(run, candidate);
    }
  };

  const processOutput = (run: RunRecord, chunk: Uint8Array): void => {
    if (run.lifecycle === "terminal" || run.decoderFinished) return;
    try {
      processSignals(run, run.decoder.push(chunk));
    } catch {
      markUncertain(run, "harness-decoding-failed");
    }
  };

  const processExit = (run: RunRecord, incoming: PhysicalReceipt): void => {
    if (run.lifecycle === "terminal") return;
    if (!run.decoderFinished) {
      run.decoderFinished = true;
      try {
        processSignals(run, run.decoder.finish());
      } catch {
        markUncertain(run, "harness-finalization-failed");
      }
    }
    append(run, {
      source: "execution",
      kind: "execution.exit",
      payload: {
        status: incoming.status,
        exitCode: incoming.exitCode,
        signal: incoming.signal,
        forced: incoming.forced,
      },
    });
    if (
      run.execution !== undefined &&
      incoming.executionRunId !== run.execution.executionRunId
    ) {
      markUncertain(run, "execution-receipt-mismatch");
      return;
    }
    if (run.execution === undefined) {
      if (
        run.pendingReceipt?.status === "exited" &&
        incoming.status === "uncertain"
      )
        return;
      run.pendingReceipt = cloneReceipt(incoming);
      markUncertain(run, "execution-binding-unconfirmed");
      return;
    }
    if (run.receipt?.status === "exited" && incoming.status === "uncertain")
      return;
    run.receipt = cloneReceipt(incoming);
    finalizeFromReceipt(run);
  };

  const observerFor = (run: RunRecord): ExecutionObserver => ({
    onOutput: (chunk) => processOutput(run, chunk),
    onExit: (receipt) => processExit(run, receipt),
    onError: (_error) => {
      if (run.lifecycle === "terminal") return;
      append(run, {
        source: "execution",
        kind: "execution.error",
        payload: { category: "transport" },
      });
      markUncertain(run, "execution-observation-lost");
    },
  });

  const validatePage = (requested: number | undefined): number => {
    const limit = requested ?? limits.maxPageSize;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > limits.maxPageSize
    ) {
      throw new RangeError(
        `Page limit must be between 1 and ${limits.maxPageSize}`,
      );
    }
    return limit;
  };

  const pageFor = (
    selected: RunRecord[],
    cursor: string | undefined,
    requestedLimit: number | undefined,
  ): Page<RunSnapshot> => {
    const limit = validatePage(requestedLimit);
    const cursorIndex =
      cursor === undefined
        ? -1
        : selected.findIndex((run) => run.agentRunId === cursor);
    if (cursor !== undefined && cursorIndex < 0) {
      throw new RangeError("Page cursor is not present in this run collection");
    }
    const start = cursorIndex + 1;
    const slice = selected.slice(start, start + limit);
    const nextCursor =
      start + slice.length < selected.length
        ? slice.at(-1)?.agentRunId
        : undefined;
    return {
      items: slice.map(toSnapshot),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  };

  const service: RunService = {
    runs: {
      create: async (input) => {
        if (disposed) throw new Error("Run service has been disposed");
        const validated = validateInput(input, limits);
        if (runs.size >= limits.maxRuns)
          throw new RangeError("Maximum retained run count reached");
        if (validated.parentRunId !== undefined) {
          const parent = requireRun(validated.parentRunId);
          if (parent.lifecycle === "terminal") {
            throw new RangeError("A child run requires a nonterminal parent");
          }
        }

        const agentRunId = randomUUID();
        const createdAt = new Date().toISOString();
        const run: RunRecord = {
          agentRunId,
          ...(validated.parentRunId === undefined
            ? {}
            : { parentRunId: validated.parentRunId }),
          metadata: { ...validated.metadata },
          ...(validated.workspace === undefined
            ? {}
            : {
                workspace: {
                  cwd: validated.workspace.cwd,
                  ...(validated.workspace.workspaceSessionId === undefined
                    ? {}
                    : {
                        workspaceSessionId:
                          validated.workspace.workspaceSessionId,
                      }),
                },
              }),
          lifecycle: "accepted",
          semantic: "pending",
          activity: "unknown",
          revision: 0,
          createdAt,
          updatedAt: createdAt,
          completeness: "complete",
          decoder: options.harness.decoder(),
          waiters: new Set(),
          retirementRequests: new Set(),
          cancelIntentSeen: false,
          decoderFinished: false,
        };
        runs.set(agentRunId, run);
        order.push(agentRunId);
        appendSnapshot(run);
        update(run, { lifecycle: "starting" });

        try {
          const binding = await options.execution.start(
            agentRunId,
            validated.request,
            observerFor(run),
          );
          const pendingReceipt = run.pendingReceipt;
          if (
            pendingReceipt !== undefined &&
            pendingReceipt.executionRunId !== binding.executionRunId
          ) {
            delete run.pendingReceipt;
            update(run, { execution: { ...binding } });
            markUncertain(run, "execution-receipt-mismatch");
            return toSnapshot(run);
          }
          update(run, { execution: { ...binding } });
          if (pendingReceipt !== undefined) {
            delete run.pendingReceipt;
            run.receipt = cloneReceipt(pendingReceipt);
          }
          if (run.receipt !== undefined) {
            finalizeFromReceipt(run);
          } else if (run.outcomeCandidate !== undefined) {
            const retirement =
              run.outcomeCandidate.outcome === "cancelled"
                ? "cancel"
                : "settled";
            await requestRetirement(run, retirement);
          } else if (run.lifecycle === "starting") {
            update(run, { lifecycle: "running" });
          }
        } catch {
          if (run.lifecycle !== "terminal")
            markUncertain(run, "execution-start-outcome-uncertain");
        }
        return toSnapshot(run);
      },

      get: (agentRunId) => toSnapshot(requireRun(agentRunId)),

      list: (options = {}) =>
        pageFor(
          order.map((agentRunId) => requireRun(agentRunId)),
          options.cursor,
          options.limit,
        ),

      children: (parentRunId, options = {}) => {
        requireRun(parentRunId);
        return pageFor(
          order
            .map((agentRunId) => requireRun(agentRunId))
            .filter((run) => run.parentRunId === parentRunId),
          options.cursor,
          options.limit,
        );
      },

      wait: (agentRunId, waitOptions: WaitOptions = {}) => {
        const run = requireRun(agentRunId);
        const { signal, timeoutMs } = waitOptions;
        if (
          timeoutMs !== undefined &&
          (!Number.isFinite(timeoutMs) || timeoutMs < 0)
        ) {
          return Promise.reject(
            new RangeError("timeoutMs must be a non-negative finite number"),
          );
        }
        if (signal?.aborted) return Promise.reject(abortError());
        if (isSettled(run)) return Promise.resolve(toSnapshot(run));
        return new Promise<RunSnapshot>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const cleanup = (): void => {
            run.waiters.delete(check);
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
          };
          const check = (): void => {
            if (!isSettled(run)) return;
            cleanup();
            resolve(toSnapshot(run));
          };
          const onAbort = (): void => {
            cleanup();
            reject(abortError());
          };
          run.waiters.add(check);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
              cleanup();
              reject(new WaitTimeoutError());
            }, timeoutMs);
          }
          check();
        });
      },

      cancel: async (agentRunId) => {
        const run = requireRun(agentRunId);
        if (run.lifecycle === "terminal") return toSnapshot(run);

        if (!run.cancelIntentSeen) {
          run.cancelIntentSeen = true;
          append(run, {
            source: "runtime",
            kind: "run.cancel.requested",
            payload: { agentRunId },
          });
        }
        if (run.outcomeCandidate === undefined) {
          run.outcomeCandidate = {
            outcome: "cancelled",
            semantic: "aborted",
            reason: "user-cancelled",
          };
          const lifecycle =
            run.lifecycle === "uncertain" || run.lifecycle === "reconciling"
              ? run.lifecycle
              : "stopping";
          update(run, {
            lifecycle,
            semantic: "aborted",
            reason: "user-cancelled",
          });
        }
        await requestRetirement(run, "cancel");
        return toSnapshot(run);
      },

      events: (agentRunId, afterSeq) => {
        requireRun(agentRunId);
        return options.journal.subscribe(agentRunId, afterSeq);
      },

      result: (agentRunId): RunResult => {
        const run = requireRun(agentRunId);
        if (
          run.lifecycle !== "terminal" ||
          run.outcome === undefined ||
          run.reason === undefined
        ) {
          return { ready: false, agentRunId };
        }
        return {
          ready: true,
          agentRunId,
          outcome: run.outcome,
          reason: run.reason,
          ...(run.reportedText === undefined
            ? {}
            : { reportedText: run.reportedText }),
          ...(run.receipt === undefined
            ? {}
            : { receipt: cloneReceipt(run.receipt) }),
        };
      },
    },
    dispose: () => {
      if (disposePromise !== undefined) return disposePromise;
      disposed = true;
      disposePromise = Promise.resolve()
        .then(() => options.execution.dispose())
        .finally(() => options.journal.close());
      return disposePromise;
    },
  };

  return service;
}
