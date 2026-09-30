import { randomUUID } from "node:crypto";
import { admitExecutionProfile } from "../adapters/profile.js";
import {
  cloneEffectiveProfile,
  persistedProfileProblem,
} from "../domain/execution-profile.js";
import type { AdmittedExecutionProfile } from "../contracts/profile.js";
import type {
  ExecutionObserver,
  ExecutionPort,
  HarnessDecoder,
  HarnessPort,
  HarnessSignal,
  ResumeOutcome,
} from "../contracts/ports.js";
import {
  HarnessCapabilityError,
  type HarnessCapabilities,
  type HarnessControlOperation,
} from "../contracts/harness.js";
import { isObservationGap } from "../contracts/ports.js";
import type { DurableRunState } from "../contracts/durable.js";
import type { RuntimeLimits } from "../contracts/limits.js";
import { DEFAULT_LIMITS } from "../contracts/limits.js";
import {
  FORBIDDEN_JSON_KEYS,
  isPrivateMetadataKey,
} from "../contracts/privacy.js";
import type {
  Activity,
  HarnessName,
  JsonObject,
  ObservationDraft,
  Page,
  PhysicalReceipt,
  RecoveryGap,
  RunCreateInput,
  RunRecovery,
  RunResult,
  RunSnapshot,
  WaitOptions,
} from "../contracts/types.js";
import {
  RunNotFoundError,
  UnsupportedBackendError,
  WaitTimeoutError,
} from "../contracts/types.js";
import type {
  ReconcileReport,
  RunService,
  RunServiceOptions,
} from "../contracts/service.js";
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
const MAX_RECOVERY_GAPS = 16;
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
  const spawnedBy = (input as { spawnedBy?: unknown }).spawnedBy;
  if (
    spawnedBy !== undefined &&
    (typeof spawnedBy !== "string" || spawnedBy !== parentRunId)
  ) {
    throw new TypeError("spawnedBy must equal parentRunId");
  }

  const normalized: RunCreateInput = {
    harness: "mock",
    request: request as RunCreateInput["request"],
    ...(parentRunId === undefined ? {} : { parentRunId }),
    ...(spawnedBy === undefined ? {} : { spawnedBy }),
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

function isTerminal(run: RunRecord): boolean {
  return run.lifecycle === "terminal";
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

interface ResolvedAdapter {
  identity: { name: HarnessName; version: string };
  capabilities?: HarnessCapabilities;
  execution: ExecutionPort<unknown>;
  harness: HarnessPort;
  validateInput?: (
    input: RunCreateInput<unknown, HarnessName>,
    limits: RuntimeLimits,
  ) => RunCreateInput<unknown, HarnessName>;
}

const MOCK_IDENTITY = { name: "mock", version: "mock-fixture-v1" } as const;

/** Decoder for a restored run whose harness adapter is not registered. */
const unavailableDecoder: HarnessDecoder = {
  push() {
    throw new Error("Harness adapter is not registered");
  },
  finish() {
    throw new Error("Harness adapter is not registered");
  },
};

function validateCapabilities(adapter: ResolvedAdapter): void {
  const capabilities = adapter.capabilities;
  if (capabilities === undefined) return;
  if (
    capabilities.schemaVersion !== 1 ||
    capabilities.harness.name !== adapter.identity.name ||
    capabilities.harness.version !== adapter.identity.version
  ) {
    throw new TypeError(
      `Harness ${adapter.identity.name} capabilities do not match its identity`,
    );
  }
  // The service has no steer/follow-up route; advertising one would be a lie.
  for (const operation of ["steer", "followUp"] as const) {
    if (capabilities[operation].tsukai !== "unsupported") {
      throw new TypeError(
        `Harness ${adapter.identity.name} advertises ${operation} without a service route`,
      );
    }
  }
}

function resolveAdapters<Request, Harness extends HarnessName>(
  options: RunServiceOptions<Request, Harness>,
): { adapters: Map<HarnessName, ResolvedAdapter>; single: boolean } {
  const adapters = new Map<HarnessName, ResolvedAdapter>();
  if (options.adapters !== undefined) {
    if (
      options.execution !== undefined ||
      options.harness !== undefined ||
      options.harnessIdentity !== undefined ||
      options.validateInput !== undefined ||
      options.capabilities !== undefined
    ) {
      throw new TypeError(
        "Pass either harness adapters or a single execution/harness binding",
      );
    }
    if (options.adapters.length === 0) {
      throw new TypeError("At least one harness adapter is required");
    }
    for (const adapter of options.adapters) {
      const resolved = adapter as unknown as ResolvedAdapter;
      if (adapters.has(resolved.identity.name)) {
        throw new TypeError(
          `Harness ${resolved.identity.name} is registered twice`,
        );
      }
      if (resolved.capabilities === undefined) {
        throw new TypeError(
          `Harness ${resolved.identity.name} must advertise capabilities`,
        );
      }
      validateCapabilities(resolved);
      adapters.set(resolved.identity.name, resolved);
    }
    return { adapters, single: false };
  }
  if (options.execution === undefined || options.harness === undefined) {
    throw new TypeError("A single-harness service needs execution and harness");
  }
  const identity = options.harnessIdentity ?? MOCK_IDENTITY;
  const resolved: ResolvedAdapter = {
    identity: { ...identity },
    execution: options.execution as ExecutionPort<unknown>,
    harness: options.harness,
    ...(options.validateInput === undefined
      ? {}
      : {
          validateInput: options.validateInput as unknown as NonNullable<
            ResolvedAdapter["validateInput"]
          >,
        }),
    ...(options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
  };
  validateCapabilities(resolved);
  adapters.set(identity.name, resolved);
  return { adapters, single: true };
}

export function createRunService<
  Request = RunCreateInput["request"],
  Harness extends HarnessName = "mock",
>(options: RunServiceOptions<Request, Harness>): RunService<Request, Harness> {
  const limits = resolveLimits(options.limits);
  const { adapters, single } = resolveAdapters(options);
  const executions = [
    ...new Set([...adapters.values()].map((adapter) => adapter.execution)),
  ];
  /** The adapter that owns a run. A run never moves to another adapter. */
  const adapterFor = (run: RunRecord): ResolvedAdapter | undefined => {
    const adapter = adapters.get(run.harness.name);
    return adapter !== undefined &&
      adapter.identity.version === run.harness.version
      ? adapter
      : undefined;
  };
  const adapterGapReason = (run: RunRecord): string =>
    adapters.has(run.harness.name)
      ? "harness-version-mismatch"
      : "harness-adapter-unavailable";
  const store = options.durableStore;
  if (store !== undefined && options.journal !== store) {
    throw new TypeError(
      "A durable store must also be the journal so observations persist before projection",
    );
  }
  const runs = new Map<string, RunRecord>();
  const order: string[] = [];
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let detachPromise: Promise<void> | undefined;
  const reconciling = new Map<string, Promise<void>>();

  const requireRun = (agentRunId: string): RunRecord => {
    const run = runs.get(agentRunId);
    if (run === undefined) throw new RunNotFoundError(agentRunId);
    return run;
  };

  const append = (
    run: RunRecord,
    draft: Omit<ObservationDraft, "runId">,
  ): void => {
    try {
      options.journal.append({ runId: run.agentRunId, ...draft });
    } catch {
      // A failed record is not a successful record: flag the run instead of
      // letting an observer callback take the owner down.
      run.persistFailed = true;
      if (run.lifecycle !== "terminal") run.completeness = "incomplete";
    }
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

  const toDurable = (run: RunRecord): DurableRunState => ({
    snapshot: toSnapshot(run),
    ...(run.outcomeCandidate === undefined
      ? {}
      : {
          // Reported assistant text is content and is never made durable.
          candidate: {
            outcome: run.outcomeCandidate.outcome,
            semantic: run.outcomeCandidate.semantic,
            reason: run.outcomeCandidate.reason,
          },
        }),
    cancelIntentSeen: run.cancelIntentSeen,
    cursor: { ...run.cursor },
    intent: { startRequested: run.startRequested },
    ...(run.dispatch === undefined ? {} : { dispatch: run.dispatch }),
    retirementRequests: [...run.retirementRequests],
    journalSeq: store?.journalHead(run.agentRunId).lastSeq ?? 0,
  });

  /** Strict commit: a failure propagates so the caller does not proceed. */
  const persist = (run: RunRecord): void => {
    if (store === undefined) return;
    store.saveRun(toDurable(run));
    run.persistFailed = false;
  };

  /**
   * Commit from an observation callback. Durable state may then be behind
   * memory, which restart reconciliation tolerates because it re-derives from
   * backend evidence; the run is flagged incomplete instead of crashing.
   */
  const persistSafe = (run: RunRecord): void => {
    try {
      persist(run);
    } catch {
      run.persistFailed = true;
      if (run.lifecycle !== "terminal") run.completeness = "incomplete";
    }
  };

  const update = (run: RunRecord, changes: RunChanges): boolean => {
    if (!changeRun(run, changes)) return false;
    persistSafe(run);
    appendSnapshot(run);
    notify(run);
    return true;
  };

  /** Commits before the caller may produce an externally visible effect. */
  const updateStrict = (run: RunRecord, changes: RunChanges): boolean => {
    if (!changeRun(run, changes)) return false;
    persist(run);
    appendSnapshot(run);
    notify(run);
    return true;
  };

  const freshRecovery = (run: RunRecord): RunRecovery =>
    run.recovery ?? { state: "none", epoch: 0, attempts: 0, gaps: [] };

  const withGap = (
    recovery: RunRecovery,
    gap: Omit<RecoveryGap, "detectedAt">,
  ): RunRecovery => {
    if (
      recovery.gaps.some(
        (known) => known.kind === gap.kind && known.code === gap.code,
      )
    ) {
      return recovery;
    }
    const gaps = recovery.gaps.slice(0, MAX_RECOVERY_GAPS - 1);
    gaps.push({ ...gap, detectedAt: new Date().toISOString() });
    return { ...recovery, gaps };
  };

  /** Records lost evidence. Gaps only ever grow. */
  const recordGap = (
    run: RunRecord,
    gap: Omit<RecoveryGap, "detectedAt">,
  ): void => {
    const next = withGap(freshRecovery(run), gap);
    if (next === run.recovery) return;
    append(run, {
      source: "runtime",
      kind: "run.gap",
      payload: { kind: gap.kind, code: gap.code },
    });
    if (run.lifecycle === "terminal") return;
    update(run, { recovery: next, completeness: "incomplete" });
  };

  const markUncertain = (run: RunRecord, reason: string): void => {
    if (run.lifecycle === "terminal") return;
    if (run.lifecycle === "uncertain" && run.recovery?.reason === reason)
      return;
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
    if (run.recovery !== undefined) {
      changes.recovery = { ...run.recovery, state: "uncertain", reason };
    }
    if (run.outcomeCandidate === undefined) changes.semantic = "unknown";
    update(run, changes);
  };

  const resolvedRecovery = (run: RunRecord): RunRecovery | undefined =>
    run.recovery === undefined
      ? undefined
      : {
          ...run.recovery,
          state: "terminal",
          reconciledAt: new Date().toISOString(),
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
      if (run.recovery !== undefined) {
        changes.recovery = {
          ...run.recovery,
          state: "uncertain",
          reason: "execution-status-uncertain",
        };
      }
      update(run, changes);
      return;
    }

    if (run.outcomeCandidate !== undefined) {
      const candidate = run.outcomeCandidate;
      const recovery = resolvedRecovery(run);
      update(run, {
        lifecycle: "terminal",
        semantic: candidate.semantic,
        outcome: candidate.outcome,
        reason: candidate.reason,
        receipt: cloneReceipt(receipt),
        ...(recovery === undefined ? {} : { recovery }),
      });
      return;
    }

    if (run.recovery !== undefined && run.recovery.gaps.length > 0) {
      // The process is physically gone but the evidence that would classify
      // its work was lost. Keep the physical fact; do not guess a result.
      update(run, {
        lifecycle: "uncertain",
        semantic: "unknown",
        completeness: "incomplete",
        reason: "physical-exit-with-observation-gap",
        receipt: cloneReceipt(receipt),
        recovery: {
          ...run.recovery,
          state: "uncertain",
          reason: "physical-exit-with-observation-gap",
          reconciledAt: new Date().toISOString(),
        },
      });
      return;
    }

    const recovery = resolvedRecovery(run);
    update(run, {
      lifecycle: "terminal",
      semantic: "unknown",
      outcome: "interrupted",
      reason: "execution-exited-before-settlement",
      completeness: "incomplete",
      receipt: cloneReceipt(receipt),
      ...(recovery === undefined ? {} : { recovery }),
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
    const adapter = adapterFor(run);
    if (adapter === undefined) {
      markUncertain(run, adapterGapReason(run));
      return;
    }
    run.retirementRequests.add(reason);
    persistSafe(run);
    try {
      await adapter.execution.retire(binding.executionRunId, reason);
    } catch {
      // An unattached (post-restart) run may retry once it is re-attached.
      if (!run.attached) run.retirementRequests.delete(reason);
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
    persistSafe(run); // candidate durable before any retirement request
    void requestRetirement(
      run,
      candidate.outcome === "cancelled" ? "cancel" : "settled",
    );
  };

  const processSignals = (
    run: RunRecord,
    signals: HarnessSignal[],
    identityBase?: string,
  ): void => {
    let index = 0;
    for (const signal of signals) {
      if (run.lifecycle === "terminal") return;
      if (signal.type === "observation") {
        // Harness activity proves the prompt reached the harness.
        if (run.dispatch !== undefined && run.dispatch !== "accepted") {
          run.dispatch = "accepted";
          persistSafe(run);
        }
        append(run, {
          ...signal.draft,
          source: signal.draft.source ?? "harness",
          ...(signal.draft.sourceIdentity === undefined &&
          identityBase !== undefined
            ? { sourceIdentity: `${identityBase}#${index++}` }
            : {}),
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

  const processOutput = (
    run: RunRecord,
    chunk: Uint8Array,
    sourceIdentity?: string,
  ): void => {
    if (run.lifecycle === "terminal" || run.decoderFinished) return;
    try {
      processSignals(run, run.decoder.push(chunk), sourceIdentity);
    } catch {
      markUncertain(run, "harness-decoding-failed");
      void requestRetirement(run, "cancel");
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
    onEstablished: async (binding) => {
      if (run.lifecycle === "terminal" || run.execution !== undefined) return;
      // The binding is durable before the adapter may submit the prompt.
      updateStrict(run, { execution: { ...binding } });
    },
    onOutput: (chunk, sourceIdentity) =>
      processOutput(run, chunk, sourceIdentity),
    onReplay: (chunk) => {
      if (run.lifecycle === "terminal" || run.decoderFinished) return;
      try {
        // Rebuild decoder state only. These bytes were settled before the
        // cursor advanced, so derived signals are not re-applied.
        const signals = run.decoder.push(chunk);
        if (
          signals.some((signal) => signal.type === "observation") &&
          run.dispatch !== undefined &&
          run.dispatch !== "accepted"
        ) {
          run.dispatch = "accepted";
          persistSafe(run);
        }
      } catch {
        markUncertain(run, "harness-replay-failed");
      }
    },
    onDispatch: (phase) => {
      if (run.dispatch === phase || run.dispatch === "accepted") return;
      run.dispatch = phase;
      if (phase === "requested")
        persist(run); // durable before the write
      else persistSafe(run);
    },
    onSignal: (signal) => processSignals(run, [signal]),
    onBindingUpdate: (binding) => {
      if (run.lifecycle === "terminal") return;
      if (run.execution === undefined) {
        run.pendingBindingUpdate = binding;
        return;
      }
      if (binding.executionRunId !== run.execution.executionRunId) {
        markUncertain(run, "execution-binding-mismatch");
        return;
      }
      update(run, { execution: { ...binding } });
    },
    onProgress: (cursor) => {
      const next = {
        eventSeq: Math.max(run.cursor.eventSeq, cursor.eventSeq),
        stdoutOffset: Math.max(run.cursor.stdoutOffset, cursor.stdoutOffset),
        stderrOffset: Math.max(run.cursor.stderrOffset, cursor.stderrOffset),
      };
      if (
        next.eventSeq === run.cursor.eventSeq &&
        next.stdoutOffset === run.cursor.stdoutOffset &&
        next.stderrOffset === run.cursor.stderrOffset
      ) {
        return;
      }
      run.cursor = next;
      persistSafe(run);
    },
    onExit: (receipt) => processExit(run, receipt),
    onError: (error) => {
      if (run.lifecycle === "terminal") return;
      // This observation is dead; a later reconcile may attach a new one.
      run.attached = false;
      if (!(
        run.lifecycle === "uncertain" &&
        run.recovery?.reason === "execution-observation-lost"
      )) {
        append(run, {
          source: "execution",
          kind: "execution.error",
          payload: { category: "transport" },
        });
      }
      if (isObservationGap(error)) {
        recordGap(run, {
          kind: error.gapKind,
          code:
            typeof (error as { code?: unknown }).code === "string"
              ? (error as unknown as { code: string }).code
              : "observation-gap",
        });
      }
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

  const restoreRun = (state: DurableRunState): RunRecord => {
    const snapshot = state.snapshot;
    const restoredAdapter = adapters.get(snapshot.harness.name);
    const run: RunRecord = {
      agentRunId: snapshot.agentRunId,
      harness: { ...snapshot.harness },
      ...(snapshot.parentRunId === undefined
        ? {}
        : { parentRunId: snapshot.parentRunId }),
      ...(snapshot.spawnedBy === undefined
        ? {}
        : { spawnedBy: snapshot.spawnedBy }),
      metadata: { ...snapshot.metadata },
      ...(snapshot.workspace === undefined
        ? {}
        : { workspace: { ...snapshot.workspace } }),
      ...(snapshot.executionProfile === undefined
        ? {}
        : {
            executionProfile: cloneEffectiveProfile(snapshot.executionProfile),
          }),
      lifecycle: snapshot.lifecycle,
      semantic: snapshot.semantic,
      activity: snapshot.activity,
      revision: snapshot.revision,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      ...(snapshot.execution === undefined
        ? {}
        : { execution: { ...snapshot.execution } }),
      ...(snapshot.receipt === undefined
        ? {}
        : { receipt: cloneReceipt(snapshot.receipt) }),
      ...(snapshot.outcome === undefined ? {} : { outcome: snapshot.outcome }),
      ...(snapshot.reason === undefined ? {} : { reason: snapshot.reason }),
      completeness: snapshot.completeness,
      ...(snapshot.recovery === undefined
        ? {}
        : {
            recovery: {
              ...snapshot.recovery,
              gaps: snapshot.recovery.gaps.map((gap) => ({ ...gap })),
            },
          }),
      decoder: unavailableDecoder,
      waiters: new Set(),
      ...(state.candidate === undefined
        ? {}
        : { outcomeCandidate: { ...state.candidate } }),
      retirementRequests: new Set(),
      cancelIntentSeen: state.cancelIntentSeen,
      decoderFinished: false,
      cursor: { ...state.cursor },
      startRequested: state.intent.startRequested,
      ...(state.dispatch === undefined ? {} : { dispatch: state.dispatch }),
      attached: false,
      persistFailed: false,
    };
    if (
      restoredAdapter !== undefined &&
      restoredAdapter.identity.version === snapshot.harness.version
    ) {
      run.decoder = restoredAdapter.harness.decoder();
    }
    return run;
  };

  /**
   * Loads durable runs before any client can observe them. Classification here
   * uses only durable facts; it never contacts a backend, starts work, or
   * sends a prompt.
   */
  const loadDurableRuns = (): void => {
    if (store === undefined) return;
    const persisted = store.loadRuns();
    if (persisted.length > limits.maxRuns) {
      // Never drop durable runs silently to fit an in-memory bound.
      throw new RangeError(
        `Durable store holds ${persisted.length} runs, above the maxRuns limit of ${limits.maxRuns}`,
      );
    }
    for (const state of persisted) {
      const run = restoreRun(state);
      runs.set(run.agentRunId, run);
      order.push(run.agentRunId);
      const head = store.journalHead(run.agentRunId);
      const journalLost = head.truncated || head.lastSeq < state.journalSeq;
      if (run.lifecycle === "terminal") {
        if (journalLost) {
          run.recovery = withGap(freshRecovery(run), {
            kind: "journal",
            code: head.truncated
              ? "journal-tail-discarded"
              : "journal-behind-state",
          });
          run.completeness = "incomplete";
          persistSafe(run);
        }
        continue;
      }
      const previous = run.lifecycle;
      let recovery: RunRecovery = {
        ...freshRecovery(run),
        epoch: (run.recovery?.epoch ?? 0) + 1,
        state: "pending",
      };
      delete recovery.reason;
      if (journalLost) {
        recovery = withGap(recovery, {
          kind: "journal",
          code: head.truncated
            ? "journal-tail-discarded"
            : "journal-behind-state",
        });
      }
      let action: string;
      const changes: RunChanges = {
        recovery,
        ...(journalLost ? { completeness: "incomplete" as const } : {}),
      };
      if (!run.startRequested && run.execution === undefined) {
        // Intent was never durable, so no external start can have happened.
        action = "never-started";
        changes.lifecycle = "terminal";
        changes.semantic = "failed";
        changes.outcome = "failed";
        changes.reason = "owner-restarted-before-start";
        changes.recovery = {
          ...recovery,
          state: "terminal",
          reconciledAt: new Date().toISOString(),
        };
      } else if (run.execution === undefined) {
        // Start may or may not have reached the backend. Never retry blindly.
        action = "start-unconfirmed";
        changes.lifecycle = "uncertain";
        changes.completeness = "incomplete";
        if (run.outcomeCandidate === undefined) changes.semantic = "unknown";
        changes.reason = "execution-start-unconfirmed-after-restart";
        changes.recovery = {
          ...recovery,
          state: "uncertain",
          reason: "execution-start-unconfirmed-after-restart",
        };
      } else {
        action = "reconcile";
        changes.lifecycle = "reconciling";
      }
      // Commit the classification, then journal it. Replaying load is safe:
      // a repeated load classifies the same durable facts the same way.
      changeRun(run, changes);
      persistSafe(run);
      append(run, {
        source: "runtime",
        kind: "run.recovered",
        payload: { epoch: recovery.epoch, previous, action },
      });
      appendSnapshot(run);
    }
  };

  const reconcileRun = (run: RunRecord): Promise<void> => {
    const inflight = reconciling.get(run.agentRunId);
    if (inflight !== undefined) return inflight;
    const task = (async (): Promise<void> => {
      const binding = run.execution;
      if (
        binding === undefined ||
        run.lifecycle === "terminal" ||
        run.attached ||
        disposed ||
        detachPromise !== undefined
      ) {
        return;
      }
      const adapter = adapterFor(run);
      if (adapter === undefined) {
        // Never re-attach through a different harness adapter or version.
        markUncertain(run, adapterGapReason(run));
        return;
      }
      if (run.executionProfile !== undefined) {
        // Never re-attach under different semantics: the persisted profile
        // must be intact and still configurable by the registered adapter.
        const problem = persistedProfileProblem(
          run.executionProfile,
          adapter.capabilities?.executionProfile,
        );
        if (problem !== undefined) {
          markUncertain(run, problem);
          return;
        }
      }
      if (adapter.execution.resume === undefined) {
        markUncertain(run, "execution-resume-unsupported");
        return;
      }
      const base = freshRecovery(run);
      update(run, {
        ...(run.lifecycle === "reconciling"
          ? {}
          : { lifecycle: "reconciling" as const }),
        recovery: {
          ...base,
          state: "reconciling",
          attempts: base.attempts + 1,
        },
      });
      let outcome: ResumeOutcome;
      try {
        outcome = await adapter.execution.resume(
          { ...binding },
          observerFor(run),
          { ...run.cursor },
        );
      } catch {
        outcome = { status: "ambiguous", reason: "backend-resume-failed" };
      }
      if (isTerminal(run)) return;
      if (outcome.status === "attached") {
        run.attached = true;
        if (run.outcomeCandidate !== undefined && run.receipt === undefined) {
          // Finish the persisted decision; closing input is idempotent and
          // physical retirement does not depend on lost observation history.
          run.retirementRequests.clear();
          void requestRetirement(
            run,
            run.outcomeCandidate.outcome === "cancelled" ? "cancel" : "settled",
          );
        }
        if (
          outcome.physical === "terminal" &&
          run.lifecycle === "reconciling" &&
          run.receipt === undefined
        ) {
          // Terminal was reported but no receipt reached the owner.
          markUncertain(run, "execution-terminal-without-receipt");
          return;
        }
        // A gap can leave the decoder without the evidence to classify.
        if (run.lifecycle === "uncertain" && run.recovery?.gaps.length) return;
        if (
          outcome.physical === "running" &&
          run.lifecycle !== "uncertain" &&
          run.dispatch !== "accepted" &&
          run.outcomeCandidate === undefined
        ) {
          markUncertain(
            run,
            run.dispatch === "requested"
              ? "prompt-delivery-unconfirmed"
              : "prompt-not-dispatched",
          );
          return;
        }
        if (outcome.physical === "running" && run.lifecycle !== "uncertain") {
          update(run, {
            lifecycle:
              run.outcomeCandidate === undefined ? "running" : "stopping",
            recovery: {
              ...freshRecovery(run),
              state: "attached",
              reconciledAt: new Date().toISOString(),
            },
          });
        }
        return;
      }
      markUncertain(
        run,
        outcome.status === "missing"
          ? "execution-missing-from-backend"
          : outcome.reason,
      );
    })().finally(() => reconciling.delete(run.agentRunId));
    reconciling.set(run.agentRunId, task);
    return task;
  };

  loadDurableRuns();

  /**
   * Checks a control operation against the run's advertised capabilities
   * before anything reaches the harness. No adapter routes steer/follow-up, so
   * the check always ends in an explicit typed failure; nothing is emulated.
   */
  const rejectControl = async (
    agentRunId: string,
    operation: HarnessControlOperation,
    message: string,
  ): Promise<never> => {
    const run = requireRun(agentRunId);
    if (
      typeof message !== "string" ||
      message.length === 0 ||
      Buffer.byteLength(message, "utf8") > limits.maxRecordBytes
    ) {
      throw new TypeError(`${operation} message must be a bounded string`);
    }
    const capability = adapters.get(run.harness.name)?.capabilities?.[
      operation
    ];
    throw new HarnessCapabilityError(
      run.harness.name,
      operation,
      capability?.native ?? "unverified",
    );
  };

  const service: RunService<Request, Harness> = {
    runs: {
      create: async (input) => {
        if (disposed) throw new Error("Run service has been disposed");
        const requested = (input as { harness?: unknown } | null)?.harness;
        const adapter = single
          ? [...adapters.values()][0]!
          : adapters.get(requested as HarnessName);
        if (adapter === undefined) {
          throw new UnsupportedBackendError(String(requested));
        }
        const validated = (
          adapter.validateInput
            ? adapter.validateInput(
                input as RunCreateInput<unknown, HarnessName>,
                limits,
              )
            : validateInput(input as RunCreateInput, limits)
        ) as RunCreateInput<Request, Harness>;
        // The profile is validated against the selected adapter's advertised
        // configurability before anything is persisted or started. An
        // adapter without profile support rejects it; it is never ignored.
        const profileInput = (input as { executionProfile?: unknown })
          .executionProfile;
        const profile: AdmittedExecutionProfile | undefined =
          profileInput === undefined
            ? undefined
            : admitExecutionProfile(
                profileInput,
                adapter.identity.name,
                adapter.capabilities?.executionProfile,
              );
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
          harness: { ...adapter.identity },
          ...(validated.parentRunId === undefined
            ? {}
            : { parentRunId: validated.parentRunId }),
          ...(validated.spawnedBy === undefined
            ? {}
            : { spawnedBy: validated.spawnedBy }),
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
          ...(profile === undefined
            ? {}
            : { executionProfile: cloneEffectiveProfile(profile.effective) }),
          lifecycle: "accepted",
          semantic: "pending",
          activity: "unknown",
          revision: 0,
          createdAt,
          updatedAt: createdAt,
          completeness: "complete",
          decoder: adapter.harness.decoder(),
          waiters: new Set(),
          retirementRequests: new Set(),
          cancelIntentSeen: false,
          decoderFinished: false,
          cursor: { eventSeq: 0, stdoutOffset: 0, stderrOffset: 0 },
          startRequested: false,
          attached: false,
          persistFailed: false,
        };
        // Identity first, then intent: nothing external can exist before both
        // are durable, so a crash before the start request leaves no orphan.
        persist(run);
        runs.set(agentRunId, run);
        order.push(agentRunId);
        appendSnapshot(run);
        try {
          run.startRequested = true;
          updateStrict(run, { lifecycle: "starting" });
        } catch (error) {
          runs.delete(agentRunId);
          order.pop();
          throw error;
        }

        try {
          const binding = await adapter.execution.start(
            agentRunId,
            validated.request,
            observerFor(run),
            validated.workspace,
            profile,
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
          const nextBinding = run.pendingBindingUpdate ?? binding;
          delete run.pendingBindingUpdate;
          if (nextBinding.executionRunId !== binding.executionRunId) {
            markUncertain(run, "execution-binding-mismatch");
            return toSnapshot(run);
          }
          // Acknowledge only after the binding is durable (an adapter that
          // supports onEstablished has already committed it before any prompt).
          updateStrict(run, { execution: { ...nextBinding } });
          run.attached = true;
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
          persistSafe(run);
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
          persistSafe(run);
        }
        if (run.execution !== undefined && !run.attached) {
          await reconcileRun(run);
        }
        await requestRetirement(run, "cancel");
        return toSnapshot(run);
      },

      events: (agentRunId, afterSeq) => {
        requireRun(agentRunId);
        return options.journal.subscribe(agentRunId, afterSeq);
      },

      eventsPage: (agentRunId, afterSeq, limit) => {
        requireRun(agentRunId);
        return options.journal.read(agentRunId, afterSeq, limit);
      },

      capabilities: (agentRunId) => {
        const run = requireRun(agentRunId);
        const capabilities = adapters.get(run.harness.name)?.capabilities;
        if (
          capabilities === undefined ||
          capabilities.harness.version !== run.harness.version
        ) {
          throw new HarnessCapabilityError(
            run.harness.name,
            "capabilities",
            "unverified",
          );
        }
        return structuredClone(capabilities);
      },

      steer: (agentRunId, message) =>
        rejectControl(agentRunId, "steer", message),

      followUp: (agentRunId, message) =>
        rejectControl(agentRunId, "followUp", message),

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
    reconcile: async () => {
      const targets = order
        .map((agentRunId) => requireRun(agentRunId))
        .filter(
          (run) =>
            run.lifecycle !== "terminal" &&
            run.execution !== undefined &&
            !run.attached,
        );
      const before = new Map(
        targets.map((run) => [run.agentRunId, run.lifecycle]),
      );
      await Promise.all(targets.map((run) => reconcileRun(run)));
      return {
        runs: targets.map((run) => ({
          agentRunId: run.agentRunId,
          before: before.get(run.agentRunId)!,
          after: run.lifecycle,
          recovery: run.recovery?.state ?? "none",
        })),
      };
    },
    detach: () => {
      if (detachPromise !== undefined) return detachPromise;
      detachPromise = Promise.resolve()
        .then(() =>
          Promise.all(executions.map((execution) => execution.detach?.())),
        )
        .then(() => undefined)
        .finally(() => options.journal.close());
      return detachPromise;
    },
    dispose: () => {
      if (disposePromise !== undefined) return disposePromise;
      disposed = true;
      disposePromise = Promise.resolve()
        .then(() =>
          Promise.all(executions.map((execution) => execution.dispose())),
        )
        .then(() => undefined)
        .finally(() => options.journal.close());
      return disposePromise;
    },
  };

  return service;
}
