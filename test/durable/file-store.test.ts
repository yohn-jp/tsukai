import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileDurableStore } from "../../src/durable/file-store.js";
import type { DurableRunState } from "../../src/index.js";
import { tempDir } from "./harness.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function dir(): string {
  const temp = tempDir();
  cleanups.push(temp.cleanup);
  return join(temp.dir, "store");
}

function state(
  id: string,
  extra: Partial<DurableRunState> = {},
): DurableRunState {
  return {
    snapshot: {
      agentRunId: id,
      harness: { name: "pi", version: "0.99.1" },
      metadata: { label: "x" },
      lifecycle: "running",
      semantic: "active",
      activity: "unknown",
      revision: 3,
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:01.000Z",
      completeness: "complete",
    },
    cancelIntentSeen: false,
    cursor: { eventSeq: 4, stdoutOffset: 100, stderrOffset: 0 },
    intent: { startRequested: true },
    retirementRequests: [],
    journalSeq: 0,
    ...extra,
  };
}

const draft = (runId: string, payload: Record<string, unknown> = {}) => ({
  runId,
  source: "runtime" as const,
  kind: "run.note",
  payload: payload as never,
});

describe("file durable store", () => {
  it("is private, single-owner, and replaces the lock of a dead process", () => {
    const path = dir();
    const store = createFileDurableStore({ dir: path, fsync: false });
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(() =>
      createFileDurableStore({ dir: path, fsync: false }),
    ).toThrowError(expect.objectContaining({ code: "STORE_LOCKED" }));
    store.close();
    writeFileSync(join(path, "store.lock"), "2147483646\n");
    const taken = createFileDurableStore({ dir: path, fsync: false });
    taken.close();
    expect(existsSync(join(path, "store.lock"))).toBe(false);
  });

  it("refuses a directory reachable by group or others", () => {
    const path = dir();
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o755);
    expect(() => createFileDurableStore({ dir: path })).toThrowError(
      expect.objectContaining({ code: "STORE_PERMISSIONS" }),
    );
  });

  it("commits run state atomically and round-trips only whitelisted fields", () => {
    const path = dir();
    const store = createFileDurableStore({ dir: path, fsync: false });
    store.saveRun(state("run-1"));
    store.saveRun(
      state("run-1", {
        cursor: { eventSeq: 9, stdoutOffset: 200, stderrOffset: 1 },
      }),
    );
    expect(readdirSync(join(path, "runs"))).toEqual(["run-1.json"]);
    // Injected content never survives a load.
    const file = join(path, "runs", "run-1.json");
    const injected = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    injected.prompt = "leaked prompt";
    (injected.snapshot as Record<string, unknown>).reportedText =
      "leaked answer";
    writeFileSync(file, JSON.stringify(injected));
    store.close();
    const reopened = createFileDurableStore({ dir: path, fsync: false });
    const [loaded] = reopened.loadRuns();
    expect(loaded!.cursor).toEqual({
      eventSeq: 9,
      stdoutOffset: 200,
      stderrOffset: 1,
    });
    expect(JSON.stringify(loaded)).not.toContain("leaked");
    reopened.close();
  });

  it("reports corrupt entries instead of dropping them and loads the rest", () => {
    const path = dir();
    const store = createFileDurableStore({ dir: path, fsync: false });
    store.saveRun(state("good"));
    store.saveRun(state("bad"));
    store.close();
    writeFileSync(join(path, "runs", "bad.json"), "{ not json");
    writeFileSync(
      join(path, "runs", "mismatch.json"),
      JSON.stringify(state("other")),
    );
    const reopened = createFileDurableStore({ dir: path, fsync: false });
    expect(
      reopened.loadRuns().map((entry) => entry.snapshot.agentRunId),
    ).toEqual(["good"]);
    expect(
      reopened
        .issues()
        .map((issue) => issue.entry)
        .sort(),
    ).toEqual(["runs/bad.json", "runs/mismatch.json"]);
    expect(readFileSync(join(path, "runs", "bad.json"), "utf8")).toBe(
      "{ not json",
    );
    reopened.close();
  });

  it("continues journal sequence after a reload and keeps it metadata-only", () => {
    const path = dir();
    const first = createFileDurableStore({ dir: path, fsync: false });
    first.saveRun(state("run-1"));
    first.append(draft("run-1"));
    first.append(draft("run-1", { prompt: "secret prompt", tool: "read" }));
    first.close();
    expect(
      readFileSync(join(path, "journal", "run-1.jsonl"), "utf8"),
    ).not.toContain("secret prompt");
    const second = createFileDurableStore({ dir: path, fsync: false });
    second.loadRuns();
    expect(second.journalHead("run-1")).toEqual({
      lastSeq: 2,
      truncated: false,
    });
    expect(second.append(draft("run-1")).seq).toBe(3);
    expect(second.read("run-1").items.map((event) => event.seq)).toEqual([
      1, 2, 3,
    ]);
    second.close();
  });

  it("discards a torn journal tail, preserves the evidence, and reports truncation", () => {
    const path = dir();
    const first = createFileDurableStore({ dir: path, fsync: false });
    first.saveRun(state("run-1"));
    first.append(draft("run-1"));
    first.append(draft("run-1"));
    first.close();
    const journal = join(path, "journal", "run-1.jsonl");
    writeFileSync(
      journal,
      `${readFileSync(journal, "utf8")}{"schemaVersion":1,"run`,
    );
    const second = createFileDurableStore({ dir: path, fsync: false });
    second.loadRuns();
    expect(second.journalHead("run-1")).toEqual({
      lastSeq: 2,
      truncated: true,
    });
    expect(
      readdirSync(join(path, "journal")).some((name) =>
        name.includes(".corrupt-"),
      ),
    ).toBe(true);
    expect(second.append(draft("run-1")).seq).toBe(3);
    second.close();
  });

  it("bounds retained history but keeps the true journal head", () => {
    const path = dir();
    const first = createFileDurableStore({
      dir: path,
      fsync: false,
      limits: { maxHistoryPerRun: 3 },
    });
    first.saveRun(state("run-1"));
    for (let index = 0; index < 8; index++) first.append(draft("run-1"));
    first.close();
    const second = createFileDurableStore({
      dir: path,
      fsync: false,
      limits: { maxHistoryPerRun: 3 },
    });
    second.loadRuns();
    const page = second.read("run-1");
    expect(second.journalHead("run-1").lastSeq).toBe(8);
    expect(page.items.map((event) => event.seq)).toEqual([6, 7, 8]);
    // History before the retained watermark is an explicit gap.
    expect(page).toMatchObject({ retainedFrom: 6, gap: true });
    expect(second.read("run-1", 5)).toMatchObject({ gap: false });
    second.close();
  });

  it("refuses unsafe run identities as store keys", () => {
    const store = createFileDurableStore({ dir: dir(), fsync: false });
    expect(() => store.saveRun(state("../escape"))).toThrowError(
      expect.objectContaining({ code: "STORE_KEY" }),
    );
    expect(() => store.append(draft("a/b"))).toThrow();
    store.close();
  });
});
