import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJinushiPiExecutionPort,
  createPiRuntime,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
  type DurableRunState,
  type DurableStore,
  type PiRuntime,
} from "../../src/index.js";
import { createFileDurableStore } from "../../src/durable/file-store.js";
import { FakeSupervisor, type FakeClientView } from "./fake-supervisor.js";

export class CrashError extends Error {
  constructor() {
    super("simulated owner crash");
    this.name = "CrashError";
  }
}

type StatePredicate = (state: DurableRunState) => boolean;

/** Wraps a real file store so a test can kill the owner at an exact commit. */
export class CrashStore implements DurableStore {
  private dead = false;
  private armed:
    { match: StatePredicate; when: "before" | "after" } | undefined;
  onCrash: () => void = () => undefined;
  saves: DurableRunState[] = [];

  constructor(readonly inner: DurableStore) {}

  armBefore(match: StatePredicate): void {
    this.armed = { match, when: "before" };
  }

  armAfter(match: StatePredicate): void {
    this.armed = { match, when: "after" };
  }

  get isDead(): boolean {
    return this.dead;
  }

  die(): void {
    if (this.dead) return;
    this.dead = true;
    this.inner.close();
  }

  private assertAlive(): void {
    if (this.dead) throw new CrashError();
  }

  append: DurableStore["append"] = (draft) => {
    this.assertAlive();
    return this.inner.append(draft);
  };
  read: DurableStore["read"] = (runId, afterSeq, limit) =>
    this.inner.read(runId, afterSeq, limit);
  subscribe: DurableStore["subscribe"] = (runId, afterSeq) =>
    this.inner.subscribe(runId, afterSeq);
  export: DurableStore["export"] = (runId) => this.inner.export(runId);
  loadRuns = (): DurableRunState[] => this.inner.loadRuns();
  journalHead: DurableStore["journalHead"] = (runId) =>
    this.inner.journalHead(runId);
  issues: DurableStore["issues"] = () => this.inner.issues();

  saveRun = (state: DurableRunState): void => {
    this.assertAlive();
    const hit = this.armed?.match(state) === true;
    if (hit && this.armed?.when === "before") {
      this.armed = undefined;
      this.onCrash();
      throw new CrashError();
    }
    this.inner.saveRun(state);
    this.saves.push(structuredClone(state));
    if (hit) {
      this.armed = undefined;
      this.onCrash();
      throw new CrashError();
    }
  };

  close(): void {
    if (!this.dead) this.inner.close();
    this.dead = true;
  }
}

export interface Owner {
  runtime: PiRuntime;
  store: CrashStore;
  view: FakeClientView;
  /** Process death: sever Jinushi, release the lock, run no cleanup. */
  crash(): void;
}

export function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "tsukai-m2-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function startOwner(dir: string, sup: FakeSupervisor): Owner {
  const store = new CrashStore(
    createFileDurableStore({ dir: join(dir, "store"), fsync: false }),
  );
  const view = sup.view();
  const runtime = createPiRuntime({
    execution: createJinushiPiExecutionPort({
      client: view,
      executable: "/opt/pi/bin/pi",
      environment: { mode: "replace", set: { PATH: "/usr/bin" } },
    }),
    piVersion: SUPPORTED_PI_VERSION,
    piRevision: SUPPORTED_PI_REVISION,
    durableStore: store,
    commandTimeoutMs: 2_000,
  });
  const owner: Owner = {
    runtime,
    store,
    view,
    crash() {
      view.kill();
      store.die();
    },
  };
  store.onCrash = () => owner.crash();
  return owner;
}

export const PROMPT = "private prompt text";
export const WORKSPACE = { cwd: "/tmp/tsukai-ws" };

export async function until<T>(
  read: () => T | undefined | false,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
