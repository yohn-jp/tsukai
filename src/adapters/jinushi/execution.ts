import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
  PiAttachResult,
  PiDuplexExecution,
  PiDuplexExecutionPort,
  PiTransportObserver,
} from "../../contracts/pi.js";
import type { PhysicalReceipt } from "../../contracts/types.js";
import type {
  JinushiClient,
  JinushiEventPage,
  JinushiOutputPage,
  JinushiRun,
  JinushiRunSpec,
} from "./contract.js";

const PI_RPC_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-approve",
  "--no-tools",
] as const;

const MAX_JINUSHI_INPUT_BYTES = 65_536;
const MAX_JINUSHI_OUTPUT_PAGE_BYTES = 65_536;
const DEFAULT_MAX_STDERR_BYTES = 16_384;
const DEFAULT_MAX_WRITE_QUEUE_BYTES = 1_048_576;

export interface JinushiPiExecutionPortOptions {
  client: JinushiClient;
  /** Absolute path to the Pi executable. Pi RPC arguments are fixed by this adapter. */
  executable: string;
  /** Explicit environment behavior; Jinushi does not persist its values. */
  environment: JinushiRunSpec["environment"];
  /** Used only when open() has no workspace cwd. */
  cwd?: string;
  limits?: JinushiRunSpec["limits"];
  maxStderrBytes?: number;
  maxWriteQueueBytes?: number;
  outputPageBytes?: number;
}

const GAP_KINDS: Record<string, "event" | "output"> = {
  JINUSHI_EVENT_GAP: "event",
  JINUSHI_OUTPUT_GAP: "output",
  JINUSHI_OUTPUT_SHORT_READ: "output",
};

export class JinushiExecutionError extends Error {
  readonly code: string;
  /** Present when the error means observed history was lost, not just delayed. */
  readonly gapKind?: "event" | "output";

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JinushiExecutionError";
    this.code = code;
    const gapKind = GAP_KINDS[code];
    if (gapKind !== undefined) this.gapKind = gapKind;
  }
}

/** The request may have taken effect. The caller must not retry it. */
export class JinushiEffectUncertainError extends JinushiExecutionError {
  readonly ambiguousEffect = true;

  constructor(operation: string, message: string, options?: ErrorOptions) {
    super(
      "JINUSHI_EFFECT_UNCERTAIN",
      `Jinushi ${operation} effect is uncertain; no retry was attempted: ${message}`,
      options,
    );
    this.name = "JinushiEffectUncertainError";
  }
}

interface JinushiClientFailure extends Error {
  code?: unknown;
  ambiguousEffect?: unknown;
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function clientCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function hasAmbiguousEffect(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as JinushiClientFailure).ambiguousEffect === true
  );
}

function stableSubmissionId(agentRunId: string): string {
  return `tsukai-${createHash("sha256").update(agentRunId, "utf8").digest("hex")}`;
}

function controlRequestId(): string {
  return randomUUID();
}

async function retryAmbiguous<T>(
  operation: string,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!hasAmbiguousEffect(error)) throw error;
    try {
      return await attempt();
    } catch (retryError) {
      throw mutationError(operation, retryError);
    }
  }
}

function mutationError(operation: string, value: unknown): Error {
  const error = asError(value, `Jinushi ${operation} request failed`);
  if (hasAmbiguousEffect(value)) {
    return new JinushiEffectUncertainError(operation, error.message, {
      cause: error,
    });
  }
  return error;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return result;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return result;
}

function validateAbsolutePath(
  value: string,
  name: string,
  maxBytes = 4096,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new TypeError(`${name} must be a non-empty absolute path`);
  }
  return value;
}

function cloneEnvironment(
  environment: JinushiRunSpec["environment"],
): JinushiRunSpec["environment"] {
  if (!environment || typeof environment !== "object") {
    throw new TypeError("Jinushi Pi environment must be explicit");
  }
  if (
    environment.mode !== "replace" &&
    environment.mode !== "inherit-supervisor"
  ) {
    throw new TypeError("Jinushi Pi environment mode is invalid");
  }
  const set = environment.set;
  const unset = environment.unset;
  if (
    set !== undefined &&
    (!set || typeof set !== "object" || Array.isArray(set))
  ) {
    throw new TypeError("Jinushi Pi environment.set must be a string map");
  }
  if (
    unset !== undefined &&
    (!Array.isArray(unset) || unset.some((name) => typeof name !== "string"))
  ) {
    throw new TypeError("Jinushi Pi environment.unset must be a string array");
  }
  if (set !== undefined) {
    for (const [name, value] of Object.entries(set)) {
      if (name.length === 0 || name.includes("=") || name.includes("\0")) {
        throw new TypeError("Jinushi Pi environment contains an invalid name");
      }
      if (typeof value !== "string" || value.includes("\0")) {
        throw new TypeError("Jinushi Pi environment contains an invalid value");
      }
    }
  }
  for (const name of unset ?? []) {
    if (name.length === 0 || name.includes("=") || name.includes("\0")) {
      throw new TypeError("Jinushi Pi environment contains an invalid name");
    }
  }
  return {
    mode: environment.mode,
    ...(set === undefined ? {} : { set: { ...set } }),
    ...(unset === undefined ? {} : { unset: [...unset] }),
  };
}

function validateRunId(runId: string): string {
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    Buffer.byteLength(runId, "utf8") > 256 ||
    runId.includes("\0")
  ) {
    throw new JinushiExecutionError(
      "JINUSHI_INVALID_RUN_ID",
      "Jinushi returned an invalid Run ID",
    );
  }
  return runId;
}

function validCounter(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new JinushiExecutionError(
      "JINUSHI_INVALID_OBSERVATION",
      `Jinushi returned an invalid ${name}`,
    );
  }
  return value;
}

function isTerminalState(run: JinushiRun): boolean {
  return run.state === "terminal" || run.state === "uncertain";
}

function receiptForRun(run: JinushiRun): PhysicalReceipt | undefined {
  const receipt = run.receipt;
  if (!receipt) return undefined;
  if (
    receipt.version !== 1 ||
    receipt.runId !== run.runId ||
    typeof receipt.forced !== "boolean"
  ) {
    return undefined;
  }
  return {
    executionRunId: run.runId,
    status: run.state === "terminal" ? "exited" : "uncertain",
    exitCode: typeof receipt.exitCode === "number" ? receipt.exitCode : null,
    signal: typeof receipt.signal === "string" ? receipt.signal : null,
    forced: receipt.forced,
  };
}

function outputForStream(
  run: JinushiRun,
  stream: "stdout" | "stderr",
): { observedBytes: number; retainedFrom: number } {
  const output = run.output[stream];
  const observedBytes = validCounter(
    output.observedBytes,
    `${stream} observed byte count`,
  );
  const retainedFrom = validCounter(
    output.retainedFrom,
    `${stream} retained offset`,
  );
  if (retainedFrom > observedBytes) {
    throw new JinushiExecutionError(
      "JINUSHI_INVALID_OBSERVATION",
      `Jinushi ${stream} retained offset exceeds its observed byte count`,
    );
  }
  return { observedBytes, retainedFrom };
}

class JinushiPiExecution implements PiDuplexExecution {
  readonly executionRunId: string;
  backend: string;
  pid?: number;

  private readonly controller = new AbortController();
  private readyResolve!: () => void;
  private readonly ready: Promise<void>;
  private readonly onTerminal: (executionRunId: string) => void;
  private readonly maxStderrBytes: number;
  private readonly maxWriteQueueBytes: number;
  private readonly outputPageBytes: number;
  private lastEventSeq = 0;
  private stdoutOffset = 0;
  private stderrOffset = 0;
  private stderrDelivered = 0;
  private queuedWriteBytes = 0;
  private acceptingWrites = true;
  private writeTail: Promise<void> = Promise.resolve();
  private writeFailure: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private retirement: Promise<void> | undefined;
  private pageTail: Promise<void> = Promise.resolve();
  private follow: Promise<void> | undefined;
  private currentRun: JinushiRun;
  private reportedError = false;
  private lastError: Error | undefined;
  private terminalEvidenceSeen = false;
  private reportedExit = false;
  private resumed = false;

  constructor(
    private readonly client: JinushiClient,
    run: JinushiRun,
    backend: string,
    private readonly observer: PiTransportObserver,
    options: {
      maxStderrBytes: number;
      maxWriteQueueBytes: number;
      outputPageBytes: number;
      /** Re-attach: resume event follow here and re-deliver stdout from 0. */
      resume?: { eventSeq: number; stderrOffset: number };
    },
    onTerminal: (executionRunId: string) => void,
  ) {
    this.executionRunId = run.runId;
    this.backend = run.ownership?.backend || backend;
    if (
      run.ownership?.pid !== undefined &&
      Number.isSafeInteger(run.ownership.pid) &&
      run.ownership.pid > 0
    ) {
      this.pid = run.ownership.pid;
    }
    this.maxStderrBytes = options.maxStderrBytes;
    this.maxWriteQueueBytes = options.maxWriteQueueBytes;
    this.outputPageBytes = options.outputPageBytes;
    this.onTerminal = onTerminal;
    this.currentRun = run;
    if (options.resume !== undefined) {
      this.resumed = true;
      this.lastEventSeq = options.resume.eventSeq;
      this.stderrOffset = options.resume.stderrOffset;
    }
    this.ready = new Promise<void>((resolveReady) => {
      this.readyResolve = resolveReady;
    });
    void this.ready.catch(() => undefined);
  }

  async start(initialRun: JinushiRun): Promise<void> {
    this.follow = Promise.resolve()
      .then(() =>
        this.client.followEvents(
          this.executionRunId,
          this.lastEventSeq,
          this.controller.signal,
          async (page) => this.enqueuePage(page),
        ),
      )
      .then(() => {
        if (!this.controller.signal.aborted && !this.terminalEvidenceSeen) {
          this.fail(
            new JinushiExecutionError(
              "JINUSHI_FOLLOW_EOF",
              "Jinushi event follow ended before terminal Run evidence",
            ),
          );
        }
      })
      .catch((error: unknown) => {
        if (!this.controller.signal.aborted && !this.terminalEvidenceSeen) {
          this.fail(
            new JinushiExecutionError(
              "JINUSHI_FOLLOW_LOST",
              `Jinushi event follow failed: ${asError(error, "unknown follow failure").message}`,
              { cause: error },
            ),
          );
        }
      });
    void this.follow.catch(() => undefined);
    try {
      await this.enqueueRun(initialRun);
    } catch (error) {
      this.fail(
        new JinushiExecutionError(
          "JINUSHI_INVALID_RUN_OBSERVATION",
          `Jinushi returned an invalid Run observation: ${asError(error, "unknown Run error").message}`,
          { cause: error },
        ),
      );
    }
    await this.ready;
  }

  private async retryControl(
    operation: string,
    requestId: string,
    mutate: (expectedGeneration: number) => Promise<JinushiRun>,
  ): Promise<JinushiRun> {
    const attempt = () =>
      retryAmbiguous(operation, () => mutate(this.currentRun.generation));
    try {
      return await attempt();
    } catch (error) {
      if (clientCode(error) !== "stale-generation") throw error;
      const inspected = await this.client.inspect(this.executionRunId);
      if (inspected.generation < this.currentRun.generation) {
        throw new JinushiExecutionError(
          "JINUSHI_STALE_OBSERVATION",
          "Jinushi inspect returned an older Run generation",
        );
      }
      this.currentRun = inspected;
      return attempt();
    }
  }

  private async withWriterLease<T>(
    requestId: string,
    mutate: (writerToken: string) => Promise<T>,
  ): Promise<T> {
    const writerToken = await retryAmbiguous("writer acquire", () =>
      this.client.acquireWriter(this.executionRunId, requestId),
    );
    try {
      return await mutate(writerToken);
    } finally {
      try {
        await retryAmbiguous("writer release", () =>
          this.client.releaseWriter(
            this.executionRunId,
            requestId,
            writerToken,
          ),
        );
      } catch {
        // A lost release is bounded by Jinushi's writer-lease expiry. It must
        // not rewrite the already established mutation result.
      }
    }
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.reportedError) {
      return Promise.reject(
        this.lastError ??
          new JinushiExecutionError(
            "JINUSHI_OBSERVATION_UNCERTAIN",
            "Jinushi Pi observation is no longer reliable",
          ),
      );
    }
    if (!this.acceptingWrites) {
      return Promise.reject(
        new JinushiExecutionError(
          "JINUSHI_INPUT_CLOSED",
          "Jinushi Pi stdin is closed",
        ),
      );
    }
    if (!(bytes instanceof Uint8Array)) {
      return Promise.reject(
        new TypeError("Pi stdin writes must be Uint8Array values"),
      );
    }
    if (bytes.byteLength > MAX_JINUSHI_INPUT_BYTES) {
      return Promise.reject(
        new RangeError(
          `Pi RPC input exceeds Jinushi's ${MAX_JINUSHI_INPUT_BYTES}-byte input limit`,
        ),
      );
    }
    if (this.writeFailure !== undefined) {
      return Promise.reject(this.writeFailure);
    }
    if (this.queuedWriteBytes + bytes.byteLength > this.maxWriteQueueBytes) {
      return Promise.reject(
        new RangeError("Jinushi Pi stdin write queue limit exceeded"),
      );
    }
    if (bytes.byteLength === 0) return Promise.resolve();

    const owned = new Uint8Array(bytes);
    this.queuedWriteBytes += owned.byteLength;
    const write = this.writeTail.then(async () => {
      if (this.writeFailure !== undefined) throw this.writeFailure;
      if (!this.acceptingWrites) {
        throw new JinushiExecutionError(
          "JINUSHI_INPUT_CLOSED",
          "Jinushi Pi stdin is closed",
        );
      }
      try {
        const requestId = controlRequestId();
        const updated = await this.withWriterLease(requestId, (writerToken) =>
          this.retryControl("input", requestId, (expectedGeneration) =>
            this.client.input(
              this.executionRunId,
              requestId,
              expectedGeneration,
              writerToken,
              owned,
            ),
          ),
        );
        this.currentRun = updated;
      } catch (error) {
        this.writeFailure = mutationError("input", error);
        throw this.writeFailure;
      }
    });
    this.writeTail = write.catch(() => undefined);
    return write.finally(() => {
      this.queuedWriteBytes -= owned.byteLength;
    });
  }

  closeInput(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    if (this.reportedExit) return Promise.resolve();
    if (this.terminalEvidenceSeen) {
      return Promise.reject(
        new JinushiExecutionError(
          "JINUSHI_TERMINAL_RECEIPT_MISSING",
          "Jinushi reported a final Run without a usable physical receipt",
        ),
      );
    }
    this.acceptingWrites = false;
    this.closePromise = this.writeTail.then(async () => {
      if (this.writeFailure !== undefined) throw this.writeFailure;
      if (this.reportedExit) return;
      try {
        const requestId = controlRequestId();
        const updated = await this.withWriterLease(requestId, (writerToken) =>
          this.retryControl("close-input", requestId, (expectedGeneration) =>
            this.client.closeInput(
              this.executionRunId,
              requestId,
              expectedGeneration,
              writerToken,
            ),
          ),
        );
        this.currentRun = updated;
      } catch (error) {
        const mapped = mutationError("close-input", error);
        if (
          clientCode(error) === "already-terminal" ||
          hasAmbiguousEffect(error)
        ) {
          const final = await this.inspectAfterControlFailure(mapped);
          if (final) return;
        }
        throw mapped;
      }
    });
    return this.closePromise;
  }

  retire(reason: "settled" | "cancel"): Promise<void> {
    if (this.retirement !== undefined) return this.retirement;
    this.acceptingWrites = false;
    this.retirement = this.performRetirement(reason);
    return this.retirement;
  }

  private async performRetirement(reason: "settled" | "cancel"): Promise<void> {
    if (this.reportedExit) return;
    if (this.currentRun.state === "uncertain") {
      throw new JinushiExecutionError(
        "JINUSHI_RUN_UNCERTAIN",
        "Jinushi cannot prove the Pi Run is live or terminal",
      );
    }
    if (this.terminalEvidenceSeen) {
      throw new JinushiExecutionError(
        "JINUSHI_TERMINAL_RECEIPT_MISSING",
        "Jinushi reported a final Run without a usable physical receipt",
      );
    }

    if (reason === "settled") {
      try {
        await this.closeInput();
      } catch (error) {
        if (this.reportedExit) return;
        if (
          hasAmbiguousEffect(error) ||
          clientCode(error) === "already-terminal"
        ) {
          if (await this.inspectAfterControlFailure(error)) return;
        }
        throw error;
      }
      await this.awaitTerminal();
      return;
    }

    try {
      await this.closeInput();
    } catch (error) {
      if (this.reportedExit) return;
      if (clientCode(error) === "already-terminal") {
        if (await this.inspectAfterControlFailure(error)) return;
        if (this.terminalEvidenceSeen) {
          throw new JinushiExecutionError(
            "JINUSHI_TERMINAL_RECEIPT_MISSING",
            "Jinushi reported a final Run without a usable physical receipt",
            { cause: error },
          );
        }
      }
      // Cancellation is a separate, single-attempt Jinushi control operation.
      // It is still needed when input closure is uncertain.
    }

    try {
      const requestId = controlRequestId();
      const updated = await this.retryControl(
        "cancel",
        requestId,
        (expectedGeneration) =>
          this.client.cancel(
            this.executionRunId,
            requestId,
            expectedGeneration,
          ),
      );
      this.currentRun = updated;
    } catch (error) {
      const mapped = mutationError("cancel", error);
      if (
        hasAmbiguousEffect(error) ||
        clientCode(error) === "already-terminal"
      ) {
        if (await this.inspectAfterControlFailure(mapped)) return;
      }
      throw mapped;
    }
    await this.awaitTerminal();
  }

  private async awaitTerminal(): Promise<void> {
    if (this.reportedExit) return;
    let run: JinushiRun;
    try {
      run = await this.client.await(this.executionRunId);
    } catch (error) {
      if (this.reportedExit) return;
      throw new JinushiExecutionError(
        "JINUSHI_AWAIT_UNCERTAIN",
        `Jinushi await could not prove physical retirement: ${asError(error, "unknown await failure").message}`,
        { cause: error },
      );
    }
    try {
      await this.enqueueRun(run);
    } catch (error) {
      this.fail(
        new JinushiExecutionError(
          "JINUSHI_INVALID_RUN_OBSERVATION",
          `Jinushi await returned an invalid Run observation: ${asError(error, "unknown Run error").message}`,
          { cause: error },
        ),
      );
    }
    if (!this.reportedExit) {
      throw new JinushiExecutionError(
        "JINUSHI_TERMINAL_RECEIPT_MISSING",
        "Jinushi await returned without a terminal physical receipt",
      );
    }
  }

  /** A read may establish that a failed close/cancel already reached terminal. */
  private async inspectAfterControlFailure(_cause: unknown): Promise<boolean> {
    if (this.reportedExit) return true;
    let run: JinushiRun;
    try {
      run = await this.client.inspect(this.executionRunId);
    } catch {
      return false;
    }
    try {
      await this.enqueueRun(run);
    } catch {
      return false;
    }
    return this.reportedExit;
  }

  private enqueuePage(page: JinushiEventPage): Promise<void> {
    const next = this.pageTail.then(async () => this.handlePage(page));
    this.pageTail = next.catch((error: unknown) => {
      this.fail(
        new JinushiExecutionError(
          "JINUSHI_OBSERVATION_FAILED",
          `Jinushi observation failed: ${asError(error, "unknown observation failure").message}`,
          { cause: error },
        ),
      );
    });
    return next;
  }

  private enqueueRun(run: JinushiRun): Promise<void> {
    const next = this.pageTail.then(async () => this.handleRun(run));
    this.pageTail = next.catch((error: unknown) => {
      this.fail(
        new JinushiExecutionError(
          "JINUSHI_OBSERVATION_FAILED",
          `Jinushi Run observation failed: ${asError(error, "unknown observation failure").message}`,
          { cause: error },
        ),
      );
    });
    return next;
  }

  private async handlePage(page: JinushiEventPage): Promise<void> {
    if (!page || !Array.isArray(page.events)) {
      this.fail(
        new JinushiExecutionError(
          "JINUSHI_INVALID_EVENT_PAGE",
          "Jinushi returned an invalid event page",
        ),
      );
      return;
    }
    if (!Number.isSafeInteger(page.retainedFrom) || page.retainedFrom < 1) {
      this.fail(
        new JinushiExecutionError(
          "JINUSHI_INVALID_EVENT_PAGE",
          "Jinushi returned an invalid event retention watermark",
        ),
      );
    } else if (page.retainedFrom > this.lastEventSeq + 1) {
      this.fail(
        new JinushiExecutionError(
          "JINUSHI_EVENT_GAP",
          "Jinushi event history starts after the requested cursor",
        ),
      );
    }
    if (page.gap) {
      this.fail(
        new JinushiExecutionError(
          "JINUSHI_EVENT_GAP",
          "Jinushi event history has a retention gap",
        ),
      );
    }
    for (const event of page.events) {
      if (event.runId !== this.executionRunId) {
        this.fail(
          new JinushiExecutionError(
            "JINUSHI_EVENT_RUN_MISMATCH",
            "Jinushi event belongs to a different Run",
          ),
        );
        continue;
      }
      if (!Number.isSafeInteger(event.seq) || event.seq <= 0) {
        this.fail(
          new JinushiExecutionError(
            "JINUSHI_INVALID_EVENT_SEQUENCE",
            "Jinushi event has an invalid sequence",
          ),
        );
        continue;
      }
      if (event.seq <= this.lastEventSeq) continue;
      if (event.seq !== this.lastEventSeq + 1) {
        this.fail(
          new JinushiExecutionError(
            "JINUSHI_EVENT_GAP",
            "Jinushi event sequence is discontinuous",
          ),
        );
      }
      this.lastEventSeq = event.seq;
      if (event.kind === "output.gap") {
        this.fail(
          new JinushiExecutionError(
            "JINUSHI_OUTPUT_GAP",
            "Jinushi reported a gap in retained process output",
          ),
        );
      }
    }
    if (page.run !== undefined) {
      await this.handleRun(page.run);
    } else if (page.events.length > 0) {
      const run = await this.client.inspect(this.executionRunId);
      await this.handleRun(run);
    }
    this.reportProgress();
  }

  /** Cursors advance only after every earlier byte reached the observer. */
  private reportProgress(): void {
    if (this.reportedError) return;
    try {
      this.observer.onProgress?.({
        eventSeq: this.lastEventSeq,
        stdoutOffset: this.stdoutOffset,
        stderrOffset: this.stderrOffset,
      });
    } catch {
      /* A failed cursor commit leaves the older durable cursor in force. */
    }
  }

  /** Stops observing. The physical Run is left untouched. */
  detach(): void {
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  private async handleRun(run: JinushiRun): Promise<void> {
    if (!run || run.runId !== this.executionRunId) {
      this.fail(
        new JinushiExecutionError(
          "JINUSHI_RUN_MISMATCH",
          "Jinushi returned a different Run identity",
        ),
      );
      return;
    }
    if (run.generation >= this.currentRun.generation) {
      this.currentRun = run;
    }
    if (
      run.ownership?.backend !== undefined &&
      typeof run.ownership.backend === "string" &&
      run.ownership.backend.length > 0
    ) {
      this.backend = run.ownership.backend;
    }
    if (
      run.ownership?.pid !== undefined &&
      Number.isSafeInteger(run.ownership.pid) &&
      run.ownership.pid > 0
    ) {
      this.pid = run.ownership.pid;
    } else {
      delete this.pid;
    }
    if (run.output.historyComplete !== true) {
      this.fail(
        new JinushiExecutionError(
          "JINUSHI_OUTPUT_GAP",
          "Jinushi reports incomplete retained process output",
        ),
      );
    }

    const isFinal = isTerminalState(run);
    if (!this.reportedError || isFinal) {
      for (const stream of ["stdout", "stderr"] as const) {
        try {
          await this.drainOutput(stream, run);
        } catch (error) {
          this.fail(
            new JinushiExecutionError(
              "JINUSHI_INVALID_OUTPUT_OBSERVATION",
              `Jinushi ${stream} output metadata is invalid: ${asError(error, "unknown output error").message}`,
              { cause: error },
            ),
          );
        }
      }
    }

    if (run.state === "running") this.readyResolve();
    if (isFinal) {
      this.terminalEvidenceSeen = true;
      this.readyResolve();
      const receipt = receiptForRun(run);
      if (run.state === "uncertain") {
        this.fail(
          new JinushiExecutionError(
            "JINUSHI_RUN_UNCERTAIN",
            "Jinushi cannot prove the Pi Run reached a physical terminal state",
          ),
        );
      }
      if (!receipt) {
        this.fail(
          new JinushiExecutionError(
            "JINUSHI_TERMINAL_RECEIPT_MISSING",
            "Jinushi returned a terminal Run without a valid physical receipt",
          ),
        );
        if (!this.controller.signal.aborted) this.controller.abort();
        this.onTerminal(this.executionRunId);
      } else {
        this.reportExit(receipt);
      }
    }
    this.reportProgress();
  }

  private async drainOutput(
    stream: "stdout" | "stderr",
    observedRun: JinushiRun,
  ): Promise<void> {
    const snapshot = outputForStream(observedRun, stream);
    const target = snapshot.observedBytes;
    let offset = stream === "stdout" ? this.stdoutOffset : this.stderrOffset;
    if (offset < snapshot.retainedFrom) {
      this.fail(
        new JinushiExecutionError(
          "JINUSHI_OUTPUT_GAP",
          `Jinushi ${stream} output was compacted before offset ${offset}`,
        ),
      );
      return;
    }
    while (offset < target) {
      let page: JinushiOutputPage;
      try {
        page = await this.client.output(
          this.executionRunId,
          stream,
          offset,
          this.outputPageBytes,
        );
      } catch (error) {
        this.fail(
          new JinushiExecutionError(
            "JINUSHI_OUTPUT_UNAVAILABLE",
            `Jinushi ${stream} output could not be read: ${asError(error, "unknown output failure").message}`,
            { cause: error },
          ),
        );
        return;
      }
      if (
        !Number.isSafeInteger(page.retainedFrom) ||
        page.retainedFrom < 0 ||
        page.gap ||
        page.retainedFrom > offset
      ) {
        this.fail(
          new JinushiExecutionError(
            "JINUSHI_OUTPUT_GAP",
            `Jinushi ${stream} output history has a gap at offset ${offset}`,
          ),
        );
        return;
      }
      if (
        !(page.data instanceof Uint8Array) ||
        page.data.byteLength > this.outputPageBytes
      ) {
        this.fail(
          new JinushiExecutionError(
            "JINUSHI_INVALID_OUTPUT_PAGE",
            `Jinushi returned an invalid ${stream} output page`,
          ),
        );
        return;
      }
      if (page.run !== undefined) {
        if (page.run.runId !== this.executionRunId) {
          this.fail(
            new JinushiExecutionError(
              "JINUSHI_RUN_MISMATCH",
              "Jinushi output page belongs to a different Run",
            ),
          );
          return;
        }
        if (page.run.output.historyComplete !== true) {
          this.fail(
            new JinushiExecutionError(
              "JINUSHI_OUTPUT_GAP",
              "Jinushi reports incomplete retained process output",
            ),
          );
          return;
        }
        try {
          outputForStream(page.run, stream);
        } catch (error) {
          this.fail(
            new JinushiExecutionError(
              "JINUSHI_INVALID_OUTPUT_OBSERVATION",
              `Jinushi ${stream} output metadata is invalid: ${asError(error, "unknown output error").message}`,
              { cause: error },
            ),
          );
          return;
        }
      }
      if (page.data.byteLength === 0) {
        if (offset < target) {
          this.fail(
            new JinushiExecutionError(
              "JINUSHI_OUTPUT_SHORT_READ",
              `Jinushi ${stream} output ended before its observed byte count`,
            ),
          );
        }
        return;
      }
      offset += page.data.byteLength;
      if (stream === "stdout") {
        this.stdoutOffset = offset;
        this.safeBytes("stdout", page.data);
      } else {
        this.stderrOffset = offset;
        const remaining = this.maxStderrBytes - this.stderrDelivered;
        if (remaining > 0) {
          const bounded = page.data.subarray(0, remaining);
          this.stderrDelivered += bounded.byteLength;
          if (bounded.byteLength > 0) this.safeBytes("stderr", bounded);
        }
      }
    }
  }

  private safeBytes(stream: "stdout" | "stderr", bytes: Uint8Array): void {
    try {
      if (stream === "stdout") this.observer.onStdout(new Uint8Array(bytes));
      else this.observer.onStderr(new Uint8Array(bytes));
    } catch {
      this.fail(
        new JinushiExecutionError(
          "JINUSHI_OBSERVER_FAILED",
          `Tsukai ${stream} observer rejected Jinushi output`,
        ),
      );
    }
  }

  private fail(error: Error): void {
    if (this.reportedError) return;
    this.reportedError = true;
    this.lastError = error;
    this.acceptingWrites = false;
    this.readyResolve();
    if (!this.controller.signal.aborted) this.controller.abort();
    try {
      this.observer.onError(error);
    } catch {
      // Observer failures cannot change Jinushi's physical state.
    }
  }

  private reportExit(receipt: PhysicalReceipt): void {
    if (this.reportedExit) return;
    this.terminalEvidenceSeen = true;
    this.reportedExit = true;
    this.readyResolve();
    if (!this.controller.signal.aborted) this.controller.abort();
    this.onTerminal(this.executionRunId);
    if (receipt.status === "exited" && this.reportedError && !this.resumed)
      return;
    try {
      this.observer.onExit(receipt);
    } catch {
      // The receipt is final even if the local observer failed to consume it.
    }
  }
}

/** Connects the M1a Pi RPC port to one Jinushi Run per Tsukai AgentRun. */
export function createJinushiPiExecutionPort(
  options: JinushiPiExecutionPortOptions,
): PiDuplexExecutionPort {
  const executable = validateAbsolutePath(
    options.executable,
    "executable",
    32_768,
  );
  const environment = cloneEnvironment(options.environment);
  const defaultCwd =
    options.cwd === undefined
      ? undefined
      : validateAbsolutePath(options.cwd, "cwd");
  const limits =
    options.limits === undefined ? undefined : { ...options.limits };
  if (limits !== undefined) {
    for (const [name, value] of Object.entries(limits)) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new RangeError(
          `Jinushi Pi ${name} must be a non-negative safe integer`,
        );
      }
    }
  }
  const maxStderrBytes = nonNegativeInteger(
    options.maxStderrBytes,
    DEFAULT_MAX_STDERR_BYTES,
    "maxStderrBytes",
  );
  const maxWriteQueueBytes = positiveInteger(
    options.maxWriteQueueBytes,
    DEFAULT_MAX_WRITE_QUEUE_BYTES,
    "maxWriteQueueBytes",
  );
  const outputPageBytes = positiveInteger(
    options.outputPageBytes,
    MAX_JINUSHI_OUTPUT_PAGE_BYTES,
    "outputPageBytes",
  );
  if (outputPageBytes > MAX_JINUSHI_OUTPUT_PAGE_BYTES) {
    throw new RangeError(
      `outputPageBytes cannot exceed ${MAX_JINUSHI_OUTPUT_PAGE_BYTES}`,
    );
  }

  const executions = new Map<string, JinushiPiExecution>();
  let capabilityPromise: Promise<{ backend: string }> | undefined;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const capabilities = (): Promise<{ backend: string }> => {
    capabilityPromise ??= options.client.capabilities().then((value) => {
      if (
        !value ||
        typeof value.backend !== "string" ||
        value.backend.length === 0
      ) {
        throw new JinushiExecutionError(
          "JINUSHI_INVALID_CAPABILITIES",
          "Jinushi returned an invalid backend capability",
        );
      }
      return value;
    });
    return capabilityPromise;
  };

  return {
    async open(
      agentRunId: string,
      observer: PiTransportObserver,
      workspace?: { cwd: string; workspaceSessionId?: string },
    ): Promise<PiDuplexExecution> {
      if (disposed) {
        throw new JinushiExecutionError(
          "JINUSHI_PORT_DISPOSED",
          "Jinushi Pi execution port has been disposed",
        );
      }
      if (
        typeof agentRunId !== "string" ||
        agentRunId.length === 0 ||
        Buffer.byteLength(agentRunId, "utf8") > 256
      ) {
        throw new TypeError("agentRunId must be a bounded non-empty string");
      }
      const cwd = validateAbsolutePath(
        workspace?.cwd ?? defaultCwd ?? "",
        "workspace.cwd",
      );
      if (
        workspace?.workspaceSessionId !== undefined &&
        (typeof workspace.workspaceSessionId !== "string" ||
          workspace.workspaceSessionId.length === 0 ||
          Buffer.byteLength(workspace.workspaceSessionId, "utf8") > 256)
      ) {
        throw new TypeError(
          "workspaceSessionId must be non-empty when supplied",
        );
      }
      const backend = await capabilities();
      const spec: JinushiRunSpec = {
        argv: [executable, ...PI_RPC_ARGS],
        cwd,
        environment: {
          mode: environment.mode,
          ...(environment.set === undefined
            ? {}
            : { set: { ...environment.set } }),
          ...(environment.unset === undefined
            ? {}
            : { unset: [...environment.unset] }),
        },
        interactive: false,
        lifetime: { mode: "detached" },
        ...(limits === undefined ? {} : { limits: { ...limits } }),
        correlation: { "tsukai.agentRunId": agentRunId },
      };

      let run: JinushiRun;
      try {
        const submissionId = stableSubmissionId(agentRunId);
        run = await retryAmbiguous("run submission", () =>
          options.client.run(submissionId, spec),
        );
      } catch (error) {
        throw mutationError("run submission", error);
      }
      try {
        validateRunId(run.runId);
      } catch (error) {
        throw new JinushiEffectUncertainError(
          "run submission",
          "Jinushi accepted a response without a usable Run ID",
          { cause: error },
        );
      }
      if (executions.has(run.runId)) {
        throw new JinushiEffectUncertainError(
          "run submission",
          "Jinushi returned a Run ID already active in this port",
        );
      }
      const execution = new JinushiPiExecution(
        options.client,
        run,
        backend.backend,
        observer,
        { maxStderrBytes, maxWriteQueueBytes, outputPageBytes },
        (runId) => executions.delete(runId),
      );
      executions.set(run.runId, execution);
      await execution.start(run);
      return execution;
    },
    async attach(
      executionRunId: string,
      observer: PiTransportObserver,
      resume: { eventSeq: number; stderrOffset: number },
      onOpen: (execution: PiDuplexExecution) => void,
    ): Promise<PiAttachResult> {
      if (disposed) {
        throw new JinushiExecutionError(
          "JINUSHI_PORT_DISPOSED",
          "Jinushi Pi execution port has been disposed",
        );
      }
      try {
        validateRunId(executionRunId);
      } catch {
        return { status: "ambiguous", reason: "execution-identity-invalid" };
      }
      if (executions.has(executionRunId)) {
        return { status: "ambiguous", reason: "execution-already-attached" };
      }
      // Read-only evidence first: attaching must never create a Run.
      let run: JinushiRun;
      try {
        run = await options.client.inspect(executionRunId);
      } catch (error) {
        return clientCode(error) === "run-not-found"
          ? { status: "missing", reason: "jinushi-run-not-found" }
          : { status: "ambiguous", reason: "jinushi-inspect-failed" };
      }
      if (!run || run.runId !== executionRunId) {
        return { status: "ambiguous", reason: "jinushi-run-identity-mismatch" };
      }
      let backend: string;
      try {
        backend = run.ownership?.backend || (await capabilities()).backend;
      } catch {
        return { status: "ambiguous", reason: "jinushi-capabilities-failed" };
      }
      const execution = new JinushiPiExecution(
        options.client,
        run,
        backend,
        observer,
        { maxStderrBytes, maxWriteQueueBytes, outputPageBytes, resume },
        (runId) => executions.delete(runId),
      );
      executions.set(run.runId, execution);
      onOpen(execution);
      try {
        await execution.start(run);
      } catch {
        executions.delete(run.runId);
        execution.detach();
        return { status: "ambiguous", reason: "jinushi-attach-failed" };
      }
      return { status: "attached", execution };
    },
    async detach(): Promise<void> {
      disposed = true;
      for (const execution of executions.values()) execution.detach();
      executions.clear();
    },
    dispose(): Promise<void> {
      if (disposePromise !== undefined) return disposePromise;
      disposed = true;
      disposePromise = Promise.all(
        [...executions.values()].map((execution) => execution.retire("cancel")),
      ).then(() => undefined);
      return disposePromise;
    },
  };
}
