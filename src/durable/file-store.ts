import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { DurableRunState, DurableStore } from "../contracts/durable.js";
import { DEFAULT_LIMITS, type RuntimeLimits } from "../contracts/limits.js";
import type { ObservationEnvelope } from "../contracts/types.js";
import { createMemoryJournal } from "../observation/journal.js";
import { isRecord, utf8Bytes } from "../observation/json.js";
import { parseDurableRunState } from "./state.js";

const FORMAT_VERSION = 1;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export class DurableStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DurableStoreError";
  }
}

export interface FileDurableStoreOptions {
  dir: string;
  limits?: Partial<RuntimeLimits>;
  /** Flush every commit to stable storage. Disable only in throwaway tests. */
  fsync?: boolean;
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    /* Directory fsync is unsupported on some platforms. */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeFileDurably(path: string, text: string, sync: boolean): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, text);
    if (sync) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Serializes one owner per store directory; a dead holder's lock is replaced. */
function acquireLock(dir: string): () => void {
  const path = join(dir, "store.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          /* Already removed. */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder = Number.NaN;
      try {
        holder = Number.parseInt(readFileSync(path, "utf8"), 10);
      } catch {
        /* Raced with release; retry. */
      }
      if (Number.isSafeInteger(holder) && holder > 0 && processAlive(holder)) {
        throw new DurableStoreError(
          `Durable store is owned by live process ${holder}`,
          "STORE_LOCKED",
        );
      }
      try {
        unlinkSync(path);
      } catch {
        /* Another starter removed it first. */
      }
    }
  }
  throw new DurableStoreError(
    "Durable store lock is contended",
    "STORE_LOCKED",
  );
}

interface JournalLoad {
  envelopes: ObservationEnvelope[];
  lastSeq: number;
  truncated: boolean;
}

function parseEnvelope(
  line: string,
  runId: string,
  previous: number,
  maxBytes: number,
): ObservationEnvelope | undefined {
  if (utf8Bytes(line) > maxBytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.runId !== runId ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) <= previous ||
    (value.source !== "runtime" &&
      value.source !== "harness" &&
      value.source !== "execution") ||
    typeof value.kind !== "string" ||
    typeof value.receivedAt !== "string" ||
    !isRecord(value.payload)
  ) {
    return undefined;
  }
  return value as unknown as ObservationEnvelope;
}

/**
 * File-backed DurableStore: atomic per-run state files plus an fsynced,
 * append-only, metadata-only journal per run. Every mutation is on stable
 * storage before the method returns.
 */
export function createFileDurableStore(
  options: FileDurableStoreOptions,
): DurableStore {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const sync = options.fsync ?? true;
  const dir = options.dir;
  const runsDir = join(dir, "runs");
  const journalDir = join(dir, "journal");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = statSync(dir).mode & 0o077;
  if (mode !== 0) {
    throw new DurableStoreError(
      "Durable store directory must not be accessible to group or others",
      "STORE_PERMISSIONS",
    );
  }
  const release = acquireLock(dir);
  let closed = false;
  const issues: { entry: string; reason: string }[] = [];
  const heads = new Map<string, { lastSeq: number; truncated: boolean }>();
  try {
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const formatPath = join(dir, "format.json");
    try {
      const format = JSON.parse(readFileSync(formatPath, "utf8")) as {
        version?: unknown;
      };
      if (format.version !== FORMAT_VERSION) {
        throw new DurableStoreError(
          `Unsupported durable store format ${String(format.version)}`,
          "STORE_FORMAT",
        );
      }
    } catch (error) {
      if (error instanceof DurableStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new DurableStoreError(
          "Durable store format file is unreadable",
          "STORE_FORMAT",
        );
      }
      writeFileDurably(
        formatPath,
        JSON.stringify({ version: FORMAT_VERSION }),
        sync,
      );
      fsyncDirectory(dir);
    }
  } catch (error) {
    release();
    throw error;
  }

  const journalPath = (runId: string): string => {
    if (!SAFE_NAME.test(runId)) {
      throw new DurableStoreError(
        "Run identity is not a safe store key",
        "STORE_KEY",
      );
    }
    return join(journalDir, `${runId}.jsonl`);
  };

  const loadJournal = (runId: string): JournalLoad => {
    const path = journalPath(runId);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { envelopes: [], lastSeq: 0, truncated: false };
      }
      throw error;
    }
    const envelopes: ObservationEnvelope[] = [];
    let previous = 0;
    let goodBytes = 0;
    let offset = 0;
    let truncated = false;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      if (newline === -1) {
        truncated = true; // torn final append
        break;
      }
      const envelope = parseEnvelope(
        text.slice(offset, newline),
        runId,
        previous,
        limits.maxRecordBytes,
      );
      if (envelope === undefined) {
        truncated = true;
        break;
      }
      envelopes.push(envelope);
      previous = envelope.seq;
      offset = newline + 1;
      goodBytes = offset;
    }
    if (truncated) {
      // Keep the evidence, then continue from the last verified record.
      renameSync(path, `${path}.corrupt-${Date.now()}`);
      writeFileDurably(path, text.slice(0, goodBytes), sync);
      fsyncDirectory(journalDir);
    } else if (envelopes.length > limits.maxHistoryPerRun * 2) {
      const kept = envelopes.slice(-limits.maxHistoryPerRun);
      const tmp = `${path}.tmp`;
      writeFileDurably(
        tmp,
        kept.map((envelope) => `${JSON.stringify(envelope)}\n`).join(""),
        sync,
      );
      renameSync(tmp, path);
      fsyncDirectory(journalDir);
    }
    return {
      envelopes: envelopes.slice(-limits.maxHistoryPerRun),
      lastSeq: previous,
      truncated,
    };
  };

  const journal = createMemoryJournal(limits, {
    beforeCommit(envelope) {
      if (closed)
        throw new DurableStoreError("Store is closed", "STORE_CLOSED");
      const fd = openSync(journalPath(envelope.runId), "a", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(envelope)}\n`);
        if (sync) fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const head = heads.get(envelope.runId);
      heads.set(envelope.runId, {
        lastSeq: envelope.seq,
        truncated: head?.truncated ?? false,
      });
    },
  });

  return {
    append: (draft) => journal.append(draft),
    read: (runId, afterSeq, limit) => journal.read(runId, afterSeq, limit),
    subscribe: (runId, afterSeq) => journal.subscribe(runId, afterSeq),
    export: (runId) => journal.export(runId),

    loadRuns(): DurableRunState[] {
      const states: DurableRunState[] = [];
      for (const name of readdirSync(runsDir).sort()) {
        if (!name.endsWith(".json")) continue;
        const runId = name.slice(0, -".json".length);
        try {
          if (!SAFE_NAME.test(runId)) throw new Error("unsafe run key");
          const text = readFileSync(join(runsDir, name), "utf8");
          if (utf8Bytes(text) > limits.maxRecordBytes * 4) {
            throw new Error("state exceeds its byte limit");
          }
          const state = parseDurableRunState(JSON.parse(text) as unknown);
          if (state.snapshot.agentRunId !== runId) {
            throw new Error("state identity does not match its file");
          }
          const loaded = loadJournal(runId);
          journal.restore(runId, loaded.envelopes, loaded.lastSeq);
          heads.set(runId, {
            lastSeq: loaded.lastSeq,
            truncated: loaded.truncated,
          });
          states.push(state);
        } catch (error) {
          issues.push({
            entry: `runs/${name}`,
            reason: error instanceof Error ? error.message : "unreadable",
          });
        }
      }
      states.sort((a, b) =>
        a.snapshot.createdAt === b.snapshot.createdAt
          ? a.snapshot.agentRunId.localeCompare(b.snapshot.agentRunId)
          : a.snapshot.createdAt.localeCompare(b.snapshot.createdAt),
      );
      return states;
    },

    saveRun(state): void {
      if (closed)
        throw new DurableStoreError("Store is closed", "STORE_CLOSED");
      const runId = state.snapshot.agentRunId;
      if (!SAFE_NAME.test(runId)) {
        throw new DurableStoreError(
          "Run identity is not a safe store key",
          "STORE_KEY",
        );
      }
      const text = JSON.stringify(state);
      if (utf8Bytes(text) > limits.maxRecordBytes * 4) {
        throw new DurableStoreError(
          "Durable run state exceeds its byte limit",
          "STORE_RECORD_LIMIT",
        );
      }
      const path = join(runsDir, `${runId}.json`);
      const tmp = `${path}.tmp`;
      writeFileDurably(tmp, text, sync);
      renameSync(tmp, path);
      if (sync) fsyncDirectory(runsDir);
    },

    journalHead(runId) {
      return heads.get(runId) ?? { lastSeq: 0, truncated: false };
    },

    issues: () => issues.map((issue) => ({ ...issue })),

    close(): void {
      if (closed) return;
      closed = true;
      journal.close();
      release();
    },
  };
}
