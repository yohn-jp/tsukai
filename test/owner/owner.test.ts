import {
  chmodSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectOwner,
  createJinushiPiExecutionPort,
  createPiRuntime,
  OwnerError,
  RunNotFoundError,
  startResidentOwner,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
  type OwnerClient,
  type ResidentOwner,
} from "../../src/index.js";
import { FakeSupervisor } from "../durable/fake-supervisor.js";
import { PROMPT, tempDir, WORKSPACE } from "../durable/harness.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(): { dir: string; sup: FakeSupervisor } {
  const temp = tempDir();
  cleanups.push(temp.cleanup);
  return { dir: temp.dir, sup: new FakeSupervisor() };
}

async function boot(
  dir: string,
  sup: FakeSupervisor,
  extra: Partial<Parameters<typeof startResidentOwner>[0]> = {},
): Promise<ResidentOwner> {
  const owner = await startResidentOwner({
    stateDir: dir,
    fsync: false,
    createService: (store) =>
      createPiRuntime({
        execution: createJinushiPiExecutionPort({
          client: sup.view(),
          executable: "/opt/pi/bin/pi",
          environment: { mode: "replace", set: { PATH: "/usr/bin" } },
        }),
        piVersion: SUPPORTED_PI_VERSION,
        piRevision: SUPPORTED_PI_REVISION,
        durableStore: store,
        commandTimeoutMs: 2_000,
      }),
    ...extra,
  });
  cleanups.push(() => owner.close("detach"));
  return owner;
}

async function client(dir: string): Promise<OwnerClient> {
  const connected = await connectOwner({ stateDir: dir });
  cleanups.push(() => connected.close());
  return connected;
}

async function until<T>(
  read: () => Promise<T | false> | T | false,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const input = {
  harness: "pi" as const,
  request: { prompt: PROMPT },
  workspace: WORKSPACE,
};

describe("resident owner over local IPC", () => {
  it("serves one canonical run to clients that connect, disconnect, and reconnect", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    await boot(dir, sup);
    const first = await client(dir);
    const created = await first.runs.create(input);
    await first.close();

    const second = await client(dir);
    expect(await second.runs.get(created.agentRunId)).toMatchObject({
      agentRunId: created.agentRunId,
      lifecycle: "running",
      execution: { executionRunId: sup.only().runId },
    });
    expect(
      (await second.runs.list()).items.map((run) => run.agentRunId),
    ).toEqual([created.agentRunId]);
    sup.releaseTranscript(sup.only());
    const done = await second.runs.wait(created.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done).toMatchObject({ lifecycle: "terminal", outcome: "completed" });
    expect(await second.runs.result(created.agentRunId)).toMatchObject({
      ready: true,
      reportedText: "private answer",
    });
    expect(sup.runStarts).toBe(1);
    expect(sup.prompts).toBe(1);
  });

  it("keeps the same AgentRun across an owner restart and a reconnecting client", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    const owner = await boot(dir, sup);
    const connected = await client(dir);
    const created = await connected.runs.create(input);
    await until(() => sup.only().heldTranscript);
    await owner.close("detach");

    const restarted = await boot(dir, sup);
    expect(restarted.socketPath).toBe(owner.socketPath);
    // The same client object reconnects lazily to the new owner process.
    const seen = await connected.runs.get(created.agentRunId);
    expect(seen).toMatchObject({
      agentRunId: created.agentRunId,
      recovery: { state: "attached", epoch: 1 },
    });
    sup.releaseTranscript(sup.only());
    const done = await connected.runs.wait(created.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done.outcome).toBe("completed");
    expect(sup.runStarts).toBe(1);
    expect(sup.prompts).toBe(1);
  });

  it("cancels through the canonical owner and a disconnect only cancels a waiter", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    await boot(dir, sup);
    const first = await client(dir);
    const created = await first.runs.create(input);
    const controller = new AbortController();
    const waiter = first.runs.wait(created.agentRunId, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
    const waiting = (await client(dir)).runs.wait(created.agentRunId);
    const dropper = await client(dir);
    void dropper.runs.wait(created.agentRunId).catch(() => undefined);
    await dropper.close();
    expect((await first.runs.get(created.agentRunId)).lifecycle).toBe(
      "running",
    );

    const other = await client(dir);
    await other.runs.cancel(created.agentRunId);
    const done = await waiting;
    expect(done).toMatchObject({ lifecycle: "terminal", outcome: "cancelled" });
  });

  it("streams journal events and reports unknown runs explicitly", async () => {
    const { dir, sup } = setup();
    await boot(dir, sup);
    const connected = await client(dir);
    const created = await connected.runs.create(input);
    await connected.runs.wait(created.agentRunId, { timeoutMs: 2_000 });
    const kinds: string[] = [];
    for await (const event of connected.runs.events(created.agentRunId)) {
      kinds.push(event.kind);
      if (event.kind === "harness.settlement") break;
    }
    expect(kinds).toContain("harness.prompt_accepted");
    await expect(connected.runs.get("missing")).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
    const page = await connected.runs.list({ limit: 1 });
    expect(page.items).toHaveLength(1);
  });
});

describe("owner reconciliation", () => {
  it("keeps reconciling an unreachable backend and resolves on later evidence", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    const first = await boot(dir, sup);
    const connected = await client(dir);
    const created = await connected.runs.create(input);
    await until(() => sup.only().heldTranscript);
    await first.close("detach");
    sup.outage = true;
    await boot(dir, sup, { reconcileIntervalMs: 20 });
    expect(await connected.runs.get(created.agentRunId)).toMatchObject({
      lifecycle: "uncertain",
      recovery: { reason: "jinushi-inspect-failed" },
    });
    sup.outage = false;
    sup.releaseTranscript(sup.only());
    // `wait` resolves on uncertainty; resolution arrives via the timer.
    const done = await until(async () => {
      const snapshot = await connected.runs.get(created.agentRunId);
      return snapshot.lifecycle === "terminal" && snapshot;
    }, 3_000);
    expect(done).toMatchObject({ lifecycle: "terminal", outcome: "completed" });
    expect(sup.runStarts).toBe(1);
    expect(sup.prompts).toBe(1);
  });
});

describe("IPC access control", () => {
  it("is a private Unix socket with no network listener", async () => {
    const { dir, sup } = setup();
    const owner = await boot(dir, sup);
    expect(statSync(owner.socketPath).isSocket()).toBe(true);
    expect(statSync(owner.socketPath).mode & 0o077).toBe(0);
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(statSync(join(dir, "owner.token")).mode & 0o077).toBe(0);
    for (const file of [
      "server.ts",
      "client.ts",
      "protocol.ts",
      "security.ts",
    ]) {
      const source = readFileSync(
        join(import.meta.dirname, "../../src/owner", file),
        "utf8",
      );
      expect(source).not.toMatch(/node:(http|https|http2|tls|dgram)/);
      expect(source).not.toMatch(/listen\(\s*\d/);
    }
  });

  it("rejects a wrong token, unauthenticated operations, and malformed frames", async () => {
    const { dir, sup } = setup();
    const owner = await boot(dir, sup);
    const talk = (lines: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        const socket = connect(owner.socketPath);
        let received = "";
        socket.on("data", (chunk) => (received += chunk.toString()));
        socket.on("close", () => resolve(received));
        // A reset after the owner's reply still leaves the reply readable.
        socket.on("error", () => resolve(received));
        socket.on("connect", () => {
          for (const line of lines) socket.write(`${line}\n`);
        });
      });
    const wrong = await talk([
      JSON.stringify({ id: 1, op: "hello", token: "nope" }),
    ]);
    expect(wrong).toContain("UNAUTHENTICATED");
    const bare = await talk([JSON.stringify({ id: 1, op: "list" })]);
    expect(bare).toContain("UNAUTHENTICATED");
    expect(bare).not.toContain('"items"');
    const malformed = await talk(["{not json"]);
    expect(malformed).toContain("INVALID_REQUEST");
    const token = readFileSync(join(dir, "owner.token"), "utf8").trim();
    const oversized = await talk([
      JSON.stringify({ id: 1, op: "hello", token }),
      "x".repeat(300_000),
    ]);
    expect(oversized).toContain("INVALID_REQUEST");
  });

  it("drops a connection that never authenticates", async () => {
    const { dir, sup } = setup();
    const owner = await boot(dir, sup, { helloTimeoutMs: 50 });
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(owner.socketPath);
      socket.on("close", () => resolve(true));
    });
    expect(closed).toBe(true);
  });

  it("refuses to run or connect through a state directory others can reach", async () => {
    const { dir, sup } = setup();
    const owner = await boot(dir, sup);
    chmodSync(dir, 0o755);
    await expect(connectOwner({ stateDir: dir })).rejects.toBeInstanceOf(
      OwnerError,
    );
    chmodSync(dir, 0o700);
    chmodSync(join(dir, "owner.token"), 0o644);
    await expect(connectOwner({ stateDir: dir })).rejects.toMatchObject({
      code: "OWNER_UNAVAILABLE",
    });
    chmodSync(join(dir, "owner.token"), 0o600);
    await owner.close("detach");
    chmodSync(dir, 0o755);
    await expect(boot(dir, sup)).rejects.toMatchObject({
      code: "OWNER_UNAVAILABLE",
    });
  });

  it("allows exactly one live owner per state directory", async () => {
    const { dir, sup } = setup();
    await boot(dir, sup);
    await expect(boot(dir, sup)).rejects.toMatchObject({
      code: "STORE_LOCKED",
    });
    expect(readdirSync(dir)).toContain("owner.sock");
  });

  it("does not leak internal error details to clients", async () => {
    const { dir, sup } = setup();
    await boot(dir, sup);
    const connected = await client(dir);
    const failure = await connected.runs
      .create({ harness: "pi", request: { prompt: "" } })
      .catch((error: unknown) => error as OwnerError);
    expect(failure).toMatchObject({ code: "INVALID_REQUEST" });
    writeFileSync(join(dir, "note"), "x");
  });
});
