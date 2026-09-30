import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectAgent,
  connectOwner,
  createJinushiPiExecutionPort,
  createPiRuntime,
  startResidentOwner,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
  type AgentClient,
  type OwnerClient,
  type ResidentOwner,
  type RunSnapshot,
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

async function boot(dir: string, sup: FakeSupervisor): Promise<ResidentOwner> {
  const owner = await startResidentOwner({
    stateDir: dir,
    fsync: false,
    reconcileIntervalMs: 0,
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
  });
  cleanups.push(() => owner.close("detach"));
  return owner;
}

async function operator(dir: string): Promise<OwnerClient> {
  const connected = await connectOwner({ stateDir: dir });
  cleanups.push(() => connected.close());
  return connected;
}

async function agentFor(dir: string, token: string): Promise<AgentClient> {
  const connected = await connectAgent({ stateDir: dir, agentToken: token });
  cleanups.push(() => connected.close());
  return connected;
}

const rootInput = {
  harness: "pi" as const,
  request: { prompt: PROMPT },
  workspace: WORKSPACE,
};
const childInput = {
  harness: "pi" as const,
  request: { prompt: "child prompt text" },
};

/** Operator-admitted root run plus its scoped agent credential. */
async function until<T>(
  read: () => Promise<T | false>,
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

async function root(
  op: OwnerClient,
  dir: string,
  workspace: { cwd: string; workspaceSessionId?: string } | null = WORKSPACE,
): Promise<{ run: RunSnapshot; agent: AgentClient; token: string }> {
  const run = await op.runs.create({
    harness: "pi",
    request: rootInput.request,
    ...(workspace === null ? {} : { workspace }),
  });
  const { token } = await op.grantAgentControl(run.agentRunId);
  return { run, token, agent: await agentFor(dir, token) };
}

function execOf(run: RunSnapshot): string {
  return run.execution!.executionRunId;
}

describe("agent-facing control surface", () => {
  it("spawns an independent durable child AgentRun with explicit lineage", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    await boot(dir, sup);
    const op = await operator(dir);
    const parent = await root(op, dir);

    const child = await parent.agent.agent_spawn(childInput);

    expect(child.agentRunId).not.toBe(parent.run.agentRunId);
    expect(child.parentRunId).toBe(parent.run.agentRunId);
    expect(child.spawnedBy).toBe(parent.run.agentRunId);
    expect(child.lifecycle).toBe("running");
    // Own Jinushi Run and own Pi session, not shared with the parent. The Pi
    // session identity is an observation that arrives after establishment.
    const seen = await until(async () => {
      const [c, p] = await Promise.all([
        parent.agent.agent_status(child.agentRunId),
        op.runs.get(parent.run.agentRunId),
      ]);
      return c.execution?.sessionId !== undefined &&
        p.execution?.sessionId !== undefined
        ? { c, p }
        : false;
    });
    expect(execOf(child)).not.toBe(execOf(seen.p));
    expect(seen.c.execution?.sessionId).not.toBe(seen.p.execution?.sessionId);
    expect(seen.c.execution?.backend).toBe(seen.p.execution?.backend);
    expect(sup.runs.size).toBe(2);
    expect(sup.runStarts).toBe(2);
    expect(sup.prompts).toBe(2);
    // The same canonical registry: the operator sees the child as a normal run.
    expect((await op.runs.children(parent.run.agentRunId)).items).toEqual([
      expect.objectContaining({ agentRunId: child.agentRunId }),
    ]);
  });

  it("lets the authorized parent status, wait, retrieve the result, and cancel", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    await boot(dir, sup);
    const op = await operator(dir);
    const parent = await root(op, dir);

    const finishing = await parent.agent.agent_spawn(childInput);
    expect(await parent.agent.agent_result(finishing.agentRunId)).toEqual({
      ready: false,
      agentRunId: finishing.agentRunId,
    });
    expect(await parent.agent.agent_status(finishing.agentRunId)).toMatchObject(
      { lifecycle: "running" },
    );
    sup.releaseTranscript(sup.run(execOf(finishing)));
    const done = await parent.agent.agent_wait(finishing.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done).toMatchObject({ lifecycle: "terminal", outcome: "completed" });
    expect(await parent.agent.agent_result(finishing.agentRunId)).toMatchObject(
      { ready: true, outcome: "completed", reportedText: "private answer" },
    );

    const cancelled = await parent.agent.agent_spawn(childInput);
    const waiting = parent.agent.agent_wait(cancelled.agentRunId, {
      timeoutMs: 2_000,
    });
    await parent.agent.agent_cancel(cancelled.agentRunId);
    expect(await waiting).toMatchObject({
      lifecycle: "terminal",
      outcome: "cancelled",
    });
    // Canonical cancellation: the operator sees the identical AgentRun state,
    // and the Jinushi execution was abort-requested by the shared service.
    expect(await op.runs.get(cancelled.agentRunId)).toMatchObject({
      outcome: "cancelled",
      reason: expect.any(String),
    });
    expect(
      sup
        .run(execOf(cancelled))
        .inputCommands.some((command) => command.type === "abort"),
    ).toBe(true);
    // Idempotent by stable identity.
    expect(await parent.agent.agent_cancel(cancelled.agentRunId)).toMatchObject(
      { outcome: "cancelled" },
    );
  });

  it("rejects cross-run status, wait, result, and cancel", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    await boot(dir, sup);
    const op = await operator(dir);
    const owner = await root(op, dir);
    const stranger = await root(op, dir);
    const child = await owner.agent.agent_spawn(childInput);
    const strangerChild = await stranger.agent.agent_spawn(childInput);

    for (const target of [
      child.agentRunId,
      owner.run.agentRunId, // even a run of the same runtime that is not a spawned child
      "no-such-run",
    ]) {
      const denied = stranger.agent;
      await expect(denied.agent_status(target)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        denied.agent_wait(target, { timeoutMs: 50 }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(denied.agent_result(target)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(denied.agent_cancel(target)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    // A parent cannot use the surface on itself or on the other family either.
    await expect(
      owner.agent.agent_cancel(strangerChild.agentRunId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      owner.agent.agent_status(owner.run.agentRunId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Nothing was cancelled by the rejected attempts.
    expect((await op.runs.get(child.agentRunId)).lifecycle).toBe("running");
    expect((await op.runs.get(strangerChild.agentRunId)).lifecycle).toBe(
      "running",
    );
    expect((await op.runs.get(owner.run.agentRunId)).lifecycle).toBe("running");
  });

  it("grants nothing to forged lineage or to a known run ID", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    await boot(dir, sup);
    const op = await operator(dir);
    const parent = await root(op, dir);
    const impostor = await root(op, dir);

    // Claiming another run as parent is refused and creates nothing.
    const starts = sup.runStarts;
    await expect(
      impostor.agent.agent_spawn({
        ...childInput,
        parentRunId: parent.run.agentRunId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(sup.runStarts).toBe(starts);

    // A run that merely claims the parent via the operator channel has
    // lineage but no spawn authority: the parent cannot control it.
    const lineageOnly = await op.runs.create({
      ...childInput,
      workspace: WORKSPACE,
      parentRunId: parent.run.agentRunId,
    });
    expect(lineageOnly.parentRunId).toBe(parent.run.agentRunId);
    expect(lineageOnly.spawnedBy).toBeUndefined();
    await expect(
      parent.agent.agent_status(lineageOnly.agentRunId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      parent.agent.agent_cancel(lineageOnly.agentRunId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // The spawn relationship cannot be injected by a client.
    await expect(
      op.runs.create({
        ...childInput,
        parentRunId: parent.run.agentRunId,
        spawnedBy: parent.run.agentRunId,
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    // An agent credential reaches no operator operation.
    expect(parent.agent).not.toHaveProperty("runs");
    await expect(
      connectAgent({ stateDir: dir, agentToken: "tsk_agent_forged" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      connectAgent({
        stateDir: dir,
        agentToken: readFileSync(join(dir, "owner.token"), "utf8").trim(),
      }).then((operatorLike) => operatorLike.agent_status("x")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps the wait separate from the AgentRun: aborting a wait never cancels it", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    await boot(dir, sup);
    const op = await operator(dir);
    const parent = await root(op, dir);
    const child = await parent.agent.agent_spawn(childInput);

    const controller = new AbortController();
    const waiter = parent.agent.agent_wait(child.agentRunId, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: "AbortError" });

    // A dropped connection with a pending wait is also only a waiter loss.
    const dropper = await connectAgent({
      stateDir: dir,
      agentToken: parent.token,
    });
    void dropper.agent_wait(child.agentRunId).catch(() => undefined);
    await dropper.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // A wait timeout is also not a cancel.
    await expect(
      parent.agent.agent_wait(child.agentRunId, { timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    expect(await op.runs.get(child.agentRunId)).toMatchObject({
      lifecycle: "running",
    });
    expect(
      sup
        .run(execOf(child))
        .inputCommands.some((command) => command.type === "abort"),
    ).toBe(false);
  });

  it("never re-executes or resends a prompt on result retrieval", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    await boot(dir, sup);
    const op = await operator(dir);
    const parent = await root(op, dir);
    const child = await parent.agent.agent_spawn(childInput);
    sup.releaseTranscript(sup.run(execOf(child)));
    await parent.agent.agent_wait(child.agentRunId, { timeoutMs: 2_000 });
    const starts = sup.runStarts;
    const prompts = sup.prompts;
    const commands = sup.run(execOf(child)).inputCommands.length;
    for (let index = 0; index < 3; index++) {
      expect(await parent.agent.agent_result(child.agentRunId)).toMatchObject({
        ready: true,
        outcome: "completed",
      });
      await parent.agent.agent_status(child.agentRunId);
    }
    expect(sup.runStarts).toBe(starts);
    expect(sup.prompts).toBe(prompts);
    expect(sup.run(execOf(child)).inputCommands).toHaveLength(commands);
    expect(sup.runs.size).toBe(2);
  });

  it("preserves control of the same child across client reconnects", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    await boot(dir, sup);
    const op = await operator(dir);
    const parent = await root(op, dir);
    const child = await parent.agent.agent_spawn(childInput);
    await parent.agent.close();

    const again = await agentFor(dir, parent.token);
    expect(await again.agent_status(child.agentRunId)).toMatchObject({
      agentRunId: child.agentRunId,
      spawnedBy: parent.run.agentRunId,
      execution: { executionRunId: execOf(child) },
    });
    expect(sup.runStarts).toBe(2);
    await again.agent_cancel(child.agentRunId);
    expect((await op.runs.get(child.agentRunId)).outcome).toBe("cancelled");
  });

  it("preserves the same child and its authorization scope across an owner restart", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    const first = await boot(dir, sup);
    const op = await operator(dir);
    const parent = await root(op, dir);
    const stranger = await root(op, dir);
    const child = await parent.agent.agent_spawn(childInput);
    await first.close("detach");
    const starts = sup.runStarts;
    const prompts = sup.prompts;

    await boot(dir, sup);
    // The same client objects reconnect lazily to the restarted owner.
    const seen = await parent.agent.agent_status(child.agentRunId);
    expect(seen).toMatchObject({
      agentRunId: child.agentRunId,
      parentRunId: parent.run.agentRunId,
      spawnedBy: parent.run.agentRunId,
      execution: { executionRunId: execOf(child) },
      recovery: { state: "attached", epoch: 1 },
    });
    // Authority is not widened by restart.
    await expect(
      stranger.agent.agent_status(child.agentRunId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      stranger.agent.agent_cancel(child.agentRunId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Retrieval after restart consumes reconciled state and reruns nothing.
    expect(await parent.agent.agent_result(child.agentRunId)).toMatchObject({
      ready: false,
    });
    sup.releaseTranscript(sup.run(execOf(child)));
    const done = await parent.agent.agent_wait(child.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done).toMatchObject({ lifecycle: "terminal", outcome: "completed" });
    const result = await parent.agent.agent_result(child.agentRunId);
    expect(result).toMatchObject({ ready: true, outcome: "completed" });
    // Reported text is content and is not durable; it was not replayed.
    expect(sup.runStarts).toBe(starts);
    expect(sup.prompts).toBe(prompts);
    expect(sup.run(execOf(child)).inputCommands).toHaveLength(2);
  });

  it("keeps uncertainty and gaps visible and never reports them as success", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    const first = await boot(dir, sup);
    const op = await operator(dir);
    const parent = await root(op, dir);
    const child = await parent.agent.agent_spawn(childInput);
    await first.close("detach");

    sup.outage = true;
    await boot(dir, sup);
    const uncertain = await parent.agent.agent_status(child.agentRunId);
    expect(uncertain).toMatchObject({
      lifecycle: "uncertain",
      recovery: { reason: "jinushi-inspect-failed" },
    });
    expect(uncertain.outcome).toBeUndefined();
    expect(await parent.agent.agent_result(child.agentRunId)).toEqual({
      ready: false,
      agentRunId: child.agentRunId,
    });
    // wait resolves on explicit uncertainty; it is not a completion.
    expect(
      await parent.agent.agent_wait(child.agentRunId, { timeoutMs: 500 }),
    ).toMatchObject({ lifecycle: "uncertain" });
  });

  it("surfaces an output gap and incomplete evidence through the projection", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    const first = await boot(dir, sup);
    const op = await operator(dir);
    const parent = await root(op, dir);
    const child = await parent.agent.agent_spawn(childInput);
    await first.close("detach");
    const run = sup.run(execOf(child));
    sup.compactStdout(run, 10);
    sup.releaseTranscript(run);
    sup.terminate(run, 0);

    await boot(dir, sup);
    const seen = await parent.agent.agent_status(child.agentRunId);
    expect(seen).toMatchObject({
      lifecycle: "uncertain",
      semantic: "unknown",
      completeness: "incomplete",
      reason: "physical-exit-with-observation-gap",
      receipt: { status: "exited", exitCode: 0 },
    });
    expect(seen.recovery?.gaps.length).toBeGreaterThan(0);
    expect(await parent.agent.agent_result(child.agentRunId)).toMatchObject({
      ready: false,
    });
  });

  it("cannot widen workspace scope through child creation", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    await boot(dir, sup);
    const op = await operator(dir);
    const parent = await root(op, dir, {
      cwd: "/tmp/tsukai-ws/project",
      workspaceSessionId: "ws-session-1",
    });
    const scoped = parent.run.workspace!;

    const starts = sup.runStarts;
    for (const workspace of [
      { cwd: "/tmp/tsukai-ws" },
      { cwd: "/tmp/tsukai-ws/project/sub", workspaceSessionId: "ws-session-1" },
      { cwd: "/", workspaceSessionId: "ws-session-1" },
      { cwd: scoped.cwd },
      { cwd: scoped.cwd, workspaceSessionId: "ws-session-2" },
    ]) {
      await expect(
        parent.agent.agent_spawn({ ...childInput, workspace }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(sup.runStarts).toBe(starts);

    // Omitted or identical scope is carried, not expanded.
    const inherited = await parent.agent.agent_spawn(childInput);
    const explicit = await parent.agent.agent_spawn({
      ...childInput,
      workspace: { ...scoped },
    });
    expect(inherited.workspace).toEqual(scoped);
    expect(explicit.workspace).toEqual(scoped);

    // A parent without an admitted workspace cannot mint one for a child.
    const bare = await root(op, dir, null);
    expect(bare.run.workspace).toBeUndefined();
    await expect(
      bare.agent.agent_spawn({ ...childInput, workspace: { cwd: "/etc" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ends agent authority on revocation and when the principal AgentRun ends", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    await boot(dir, sup);
    const op = await operator(dir);
    const parent = await root(op, dir);
    const child = await parent.agent.agent_spawn(childInput);

    // Re-issuing rotates: the previous secret stops working on the same connection.
    const rotated = await op.grantAgentControl(parent.run.agentRunId);
    await expect(
      parent.agent.agent_status(child.agentRunId),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const current = await agentFor(dir, rotated.token);
    await current.agent_status(child.agentRunId);

    expect(await op.revokeAgentControl(parent.run.agentRunId)).toEqual({
      revoked: true,
    });
    await expect(current.agent_status(child.agentRunId)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(
      connectAgent({ stateDir: dir, agentToken: rotated.token }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    // Operators cannot use the agent surface and terminal runs get no grant.
    const second = await op.grantAgentControl(parent.run.agentRunId);
    const active = await agentFor(dir, second.token);
    await op.runs.cancel(parent.run.agentRunId);
    await expect(active.agent_spawn(childInput)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(
      op.grantAgentControl(parent.run.agentRunId),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // Parent completion does not cancel the independent child.
    expect((await op.runs.get(child.agentRunId)).lifecycle).toBe("running");
  });

  it("does not persist credentials in plaintext or prompts in authorization state", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    await boot(dir, sup);
    const op = await operator(dir);
    const parent = await root(op, dir);
    const child = await parent.agent.agent_spawn(childInput);
    sup.releaseTranscript(sup.run(execOf(child)));
    await parent.agent.agent_wait(child.agentRunId, { timeoutMs: 2_000 });
    const grants = readFileSync(join(dir, "authz", "grants.json"), "utf8");
    expect(grants).not.toContain(parent.token);
    expect(grants).not.toContain("private");
    expect(grants).not.toContain("child prompt text");
  });
});
