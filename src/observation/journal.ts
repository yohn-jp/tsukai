import type { RuntimeLimits } from "../contracts/limits.js";
import type { JournalPort } from "../contracts/ports.js";
import type {
  ObservationDraft,
  ObservationEnvelope,
  ObservationPage,
} from "../contracts/types.js";
import {
  JournalCapacityError,
  JournalClosedError,
  JournalGapError,
  JournalOverflowError,
  JournalValidationError,
} from "./errors.js";
import { resolveLimits } from "./limits.js";
import { isRecord, jsonObject, utf8Bytes } from "./json.js";

interface StoredEvent {
  envelope: ObservationEnvelope;
  order: number;
}

interface Subscriber {
  runId: string;
  queue: ObservationEnvelope[];
  error?: Error;
  done: boolean;
  waiter:
    | {
        resolve(value: IteratorResult<ObservationEnvelope>): void;
        reject(reason: Error): void;
      }
    | undefined;
}

interface RunHistory {
  events: StoredEvent[];
  lastSeq: number;
  identities: Map<string, ObservationEnvelope>;
  subscribers: Set<Subscriber>;
}

function cloneEnvelope(envelope: ObservationEnvelope): ObservationEnvelope {
  return structuredClone(envelope);
}

function validateCursor(value: number | undefined, label: string): number {
  const cursor = value ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return cursor;
}

function validTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function sourceKey(source: string, identity: string): string {
  return `${source}\0${identity}`;
}

export interface JournalHooks {
  /**
   * Called with the final envelope before it is stored or published. Throwing
   * rejects the append, so a durable journal persists before projecting.
   */
  beforeCommit?(envelope: ObservationEnvelope): void;
}

export interface MemoryJournal extends JournalPort {
  /** Loads already-persisted history without publishing or persisting it. */
  restore(
    runId: string,
    envelopes: ObservationEnvelope[],
    lastSeq: number,
  ): void;
}

export function createMemoryJournal(
  limits: Partial<RuntimeLimits> = {},
  hooks: JournalHooks = {},
): MemoryJournal {
  const resolved = resolveLimits(limits);
  const runs = new Map<string, RunHistory>();
  let ordinal = 0;
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new JournalClosedError();
  };

  const ensureRun = (runId: string): RunHistory => {
    if (!runs.has(runId)) {
      if (runs.size >= resolved.maxRuns) {
        throw new JournalCapacityError(
          "Observation journal run limit reached",
          "RUN_LIMIT",
        );
      }
      runs.set(runId, {
        events: [],
        lastSeq: 0,
        identities: new Map(),
        subscribers: new Set(),
      });
    }
    return runs.get(runId)!;
  };

  const validateDraft = (draft: ObservationDraft): ObservationDraft => {
    if (!isRecord(draft))
      throw new JournalValidationError("Observation draft must be an object");
    if (
      typeof draft.runId !== "string" ||
      draft.runId.length === 0 ||
      utf8Bytes(draft.runId) > 256
    ) {
      throw new JournalValidationError(
        "Observation runId must be a bounded non-empty string",
      );
    }
    if (
      draft.source !== "runtime" &&
      draft.source !== "harness" &&
      draft.source !== "execution"
    ) {
      throw new JournalValidationError("Observation source is unsupported");
    }
    if (
      typeof draft.kind !== "string" ||
      draft.kind.length === 0 ||
      utf8Bytes(draft.kind) > 128
    ) {
      throw new JournalValidationError(
        "Observation kind must be a bounded non-empty string",
      );
    }
    if (draft.sourceIdentity !== undefined) {
      if (
        typeof draft.sourceIdentity !== "string" ||
        draft.sourceIdentity.length === 0 ||
        utf8Bytes(draft.sourceIdentity) > 256
      ) {
        throw new JournalValidationError(
          "Observation sourceIdentity must be bounded and non-empty",
        );
      }
    }
    if (draft.sourceTime !== undefined) {
      if (
        typeof draft.sourceTime !== "string" ||
        utf8Bytes(draft.sourceTime) > 128 ||
        !validTime(draft.sourceTime)
      ) {
        throw new JournalValidationError(
          "Observation sourceTime must be a valid bounded timestamp",
        );
      }
    }
    let payload;
    try {
      payload = jsonObject(draft.payload, resolved.maxRecordBytes);
    } catch (error) {
      throw new JournalValidationError(
        `Observation payload is invalid: ${error instanceof Error ? error.message : "unknown value"}`,
      );
    }
    const result: ObservationDraft = {
      runId: draft.runId,
      source: draft.source,
      kind: draft.kind,
      payload,
      ...(draft.sourceIdentity === undefined
        ? {}
        : { sourceIdentity: draft.sourceIdentity }),
      ...(draft.sourceTime === undefined
        ? {}
        : { sourceTime: draft.sourceTime }),
    };
    return result;
  };

  const retainedFrom = (history: RunHistory): number =>
    history.events[0]?.envelope.seq ?? history.lastSeq + 1;

  const publish = (
    history: RunHistory,
    envelope: ObservationEnvelope,
  ): void => {
    for (const subscriber of history.subscribers) {
      if (subscriber.error || subscriber.done) continue;
      if (subscriber.queue.length >= resolved.maxSubscriberQueue) {
        subscriber.error = new JournalOverflowError(subscriber.runId);
      } else {
        subscriber.queue.push(envelope);
      }
      notify(subscriber);
    }
  };

  const notify = (subscriber: Subscriber): void => {
    const waiter = subscriber.waiter;
    if (!waiter) return;
    subscriber.waiter = undefined;
    if (subscriber.queue.length > 0) {
      waiter.resolve({
        value: cloneEnvelope(subscriber.queue.shift()!),
        done: false,
      });
    } else if (subscriber.error) {
      waiter.reject(subscriber.error);
    } else if (subscriber.done || closed) {
      waiter.resolve({ value: undefined, done: true });
    } else {
      subscriber.waiter = waiter;
    }
  };

  const append = (input: ObservationDraft): ObservationEnvelope => {
    assertOpen();
    let draft: ObservationDraft;
    try {
      draft = validateDraft(input);
    } catch (error) {
      if (error instanceof JournalValidationError) throw error;
      throw new JournalValidationError(
        `Observation draft is invalid: ${error instanceof Error ? error.message : "unknown value"}`,
      );
    }
    const existing = runs.get(draft.runId);
    if (draft.sourceIdentity !== undefined && existing) {
      const duplicate = existing.identities.get(
        sourceKey(draft.source, draft.sourceIdentity),
      );
      if (duplicate) return cloneEnvelope(duplicate);
    }
    const existingHistory = runs.get(draft.runId);
    if (!existingHistory && runs.size >= resolved.maxRuns) {
      throw new JournalCapacityError(
        "Observation journal run limit reached",
        "RUN_LIMIT",
      );
    }
    const seq = (existingHistory?.lastSeq ?? 0) + 1;
    if (!Number.isSafeInteger(seq)) {
      throw new JournalCapacityError(
        "Observation sequence limit reached",
        "SEQUENCE_LIMIT",
      );
    }
    const envelope: ObservationEnvelope = {
      schemaVersion: 1,
      runId: draft.runId,
      seq,
      source: draft.source,
      ...(draft.sourceIdentity === undefined
        ? {}
        : { sourceIdentity: draft.sourceIdentity }),
      ...(draft.sourceTime === undefined
        ? {}
        : { sourceTime: draft.sourceTime }),
      receivedAt: new Date().toISOString(),
      kind: draft.kind,
      payload: draft.payload,
    };
    const encoded = JSON.stringify(envelope);
    if (utf8Bytes(encoded) > resolved.maxRecordBytes) {
      throw new JournalCapacityError(
        "Observation exceeds record byte limit",
        "RECORD_LIMIT",
      );
    }
    hooks.beforeCommit?.(envelope);
    const history = existingHistory ?? ensureRun(draft.runId);
    history.lastSeq = seq;
    history.events.push({ envelope, order: ++ordinal });
    if (draft.sourceIdentity !== undefined) {
      history.identities.set(
        sourceKey(draft.source, draft.sourceIdentity),
        envelope,
      );
    }
    while (history.events.length > resolved.maxHistoryPerRun) {
      const removed = history.events.shift()!;
      if (removed.envelope.sourceIdentity !== undefined) {
        history.identities.delete(
          sourceKey(removed.envelope.source, removed.envelope.sourceIdentity),
        );
      }
    }
    publish(history, envelope);
    return cloneEnvelope(envelope);
  };

  const read = (
    runId: string,
    afterSeq?: number,
    limit?: number,
  ): ObservationPage => {
    const after = validateCursor(afterSeq, "afterSeq");
    const requested = limit ?? resolved.maxPageSize;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new RangeError("limit must be a positive safe integer");
    }
    const pageSize = Math.min(requested, resolved.maxPageSize);
    const history = runs.get(runId);
    const retained = history ? retainedFrom(history) : 1;
    const all =
      history?.events
        .map((stored) => stored.envelope)
        .filter((event) => event.seq > after) ?? [];
    const selected = all.slice(0, pageSize);
    const page: ObservationPage = {
      items: selected.map(cloneEnvelope),
      retainedFrom: retained,
      gap: after + 1 < retained,
    };
    if (all.length > pageSize) page.nextCursor = String(selected.at(-1)!.seq);
    return page;
  };

  const subscribe = (
    runId: string,
    afterSeq?: number,
  ): AsyncIterable<ObservationEnvelope> => {
    const after = validateCursor(afterSeq, "afterSeq");
    let subscriber: Subscriber | undefined;
    const start = (): Subscriber => {
      assertOpen();
      const history = ensureRun(runId);
      if (history.subscribers.size >= resolved.maxSubscribersPerRun) {
        throw new JournalCapacityError(
          `Observation subscriber limit reached for ${runId}`,
          "SUBSCRIBER_LIMIT",
        );
      }
      const retained = retainedFrom(history);
      if (after + 1 < retained)
        throw new JournalGapError(runId, after, retained);
      const backlog = history.events
        .map((stored) => stored.envelope)
        .filter((envelope) => envelope.seq > after);
      if (backlog.length > resolved.maxSubscriberQueue) {
        throw new JournalOverflowError(runId);
      }
      const created: Subscriber = {
        runId,
        queue: [...backlog],
        done: false,
        waiter: undefined,
      };
      history.subscribers.add(created);
      subscriber = created;
      return created;
    };

    const stop = (): void => {
      if (!subscriber) return;
      const history = runs.get(runId);
      history?.subscribers.delete(subscriber);
      subscriber.done = true;
      notify(subscriber);
      subscriber = undefined;
    };

    const iterator: AsyncIterator<ObservationEnvelope> = {
      async next(): Promise<IteratorResult<ObservationEnvelope>> {
        const current = subscriber ?? start();
        if (current.queue.length > 0) {
          return { value: cloneEnvelope(current.queue.shift()!), done: false };
        }
        if (current.error) throw current.error;
        if (current.done || closed) return { value: undefined, done: true };
        if (current.waiter) {
          throw new JournalOverflowError(runId);
        }
        return await new Promise<IteratorResult<ObservationEnvelope>>(
          (resolve, reject) => {
            current.waiter = { resolve, reject };
          },
        );
      },
      async return(): Promise<IteratorResult<ObservationEnvelope>> {
        stop();
        return { value: undefined, done: true };
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  };

  const exportJournal = (runId?: string): string => {
    const selected: StoredEvent[] = [];
    if (runId !== undefined) {
      for (const event of runs.get(runId)?.events ?? []) selected.push(event);
    } else {
      for (const history of runs.values()) selected.push(...history.events);
    }
    selected.sort((left, right) => left.order - right.order);
    if (selected.length === 0) return "";
    return `${selected.map(({ envelope }) => JSON.stringify(envelope)).join("\n")}\n`;
  };

  const restore = (
    runId: string,
    envelopes: ObservationEnvelope[],
    lastSeq: number,
  ): void => {
    assertOpen();
    const history = ensureRun(runId);
    for (const envelope of envelopes) {
      history.events.push({ envelope, order: ++ordinal });
      if (envelope.sourceIdentity !== undefined) {
        history.identities.set(
          sourceKey(envelope.source, envelope.sourceIdentity),
          envelope,
        );
      }
    }
    history.lastSeq = Math.max(lastSeq, envelopes.at(-1)?.seq ?? 0);
    while (history.events.length > resolved.maxHistoryPerRun) {
      const removed = history.events.shift()!;
      if (removed.envelope.sourceIdentity !== undefined) {
        history.identities.delete(
          sourceKey(removed.envelope.source, removed.envelope.sourceIdentity),
        );
      }
    }
  };

  return {
    append,
    read,
    subscribe,
    restore,
    export: exportJournal,
    close(): void {
      if (closed) return;
      closed = true;
      for (const history of runs.values()) {
        for (const subscriber of history.subscribers) {
          subscriber.done = true;
          notify(subscriber);
        }
        history.subscribers.clear();
      }
    },
  };
}
