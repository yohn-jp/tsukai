import { afterEach, describe, expect, it } from "vitest";
import {
  connectOwner,
  createJinushiPiExecutionPort,
  createPiRuntime,
  OwnerError,
  PI_CAPABILITIES,
  projectObservation,
  startResidentOwner,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
  type ObservationEnvelope,
} from "../../src/index.js";
import { FakeSupervisor } from "../durable/fake-supervisor.js";
import { PROMPT, tempDir, WORKSPACE } from "../durable/harness.js";
import { PI_PROFILE, startContractOwner } from "./contract.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temp(): string {
  const dir = tempDir();
  cleanups.push(dir.cleanup);
  return dir.dir;
}

/** Stable view of a journal: kinds plus the Pi-native payload of each event. */
function nativeShape(events: ObservationEnvelope[]): unknown[] {
  return events
    .filter((event) => event.source === "harness")
    .map((event) => ({ kind: event.kind, payload: event.payload }));
}

describe("Pi-native evidence through the generalized contract", () => {
  it("keeps Pi journal detail identical to the single-harness Pi runtime", async () => {
    const sup = new FakeSupervisor();
    sup.piTranscript = PI_PROFILE.usageTranscript;
    const single = createPiRuntime({
      execution: createJinushiPiExecutionPort({
        client: sup.view(),
        executable: PI_PROFILE.executable,
        environment: { mode: "replace", set: { PATH: "/usr/bin" } },
      }),
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
      commandTimeoutMs: 2_000,
    });
    cleanups.push(() => single.detach());
    const multi = startContractOwner(temp(), sup);
    cleanups.push(() => multi.runtime.detach());
    const input = {
      harness: "pi" as const,
      request: { prompt: PROMPT },
      workspace: WORKSPACE,
    };
    const a = await single.runs.create(input);
    const b = await multi.runtime.runs.create(input);
    const doneA = await single.runs.wait(a.agentRunId, { timeoutMs: 2_000 });
    const doneB = await multi.runtime.runs.wait(b.agentRunId, {
      timeoutMs: 2_000,
    });

    const eventsA = single.runs.eventsPage(a.agentRunId, 0, 100).items;
    const eventsB = multi.runtime.runs.eventsPage(b.agentRunId, 0, 100).items;
    const normalize = (
      value: unknown,
      run: { executionRunId?: string; sessionId?: string },
    ) =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll(run.executionRunId ?? "\0", "<exec>")
          .replaceAll(run.sessionId ?? "\0", "<session>"),
      ) as unknown;
    expect(normalize(nativeShape(eventsB), doneB.execution!)).toEqual(
      normalize(nativeShape(eventsA), doneA.execution!),
    );
    // Pi-specific fields are still present, namespaced under `pi`.
    const kinds = eventsB.map((event) => event.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "harness.session",
        "harness.prompt_accepted",
        "harness.agent_start",
        "harness.agent_end",
        "harness.agent_settled",
        "harness.settlement",
      ]),
    );
    expect(
      eventsB.find((event) => event.kind === "harness.session")?.payload,
    ).toEqual({
      sessionId: doneB.execution!.sessionId,
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
    });
    expect(
      eventsB.find((event) => event.kind === "harness.prompt_accepted")
        ?.payload,
    ).toEqual({ disposition: "started" });
    expect(
      eventsB.find(
        (event) =>
          (event.payload.pi as { nativeType?: string } | undefined)
            ?.nativeType === "message_end",
      )?.payload,
    ).toMatchObject({
      pi: {
        assistant: {
          stopReason: "stop",
          usage: { scope: "assistant_message_final" },
        },
      },
    });
    expect(doneB.execution).toMatchObject({
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
    });
    expect(doneB.execution?.harnessVersion).toBeUndefined();

    // M4 metric values are unchanged; only harness attribution is added.
    const metricsA = projectObservation({ snapshots: [doneA], events: eventsA })
      .metrics[a.agentRunId]!;
    const metricsB = projectObservation({ snapshots: [doneB], events: eventsB })
      .metrics[b.agentRunId]!;
    const values = (metrics: typeof metricsA) =>
      JSON.parse(
        JSON.stringify(metrics, (key, value: unknown) =>
          key === "eventSeqs" || key === "harness" ? undefined : value,
        ),
      ) as unknown;
    expect(values(metricsB)).toEqual(values(metricsA));
    expect(metricsB.usage.cost).toMatchObject({
      availability: "observed",
      value: 0.03,
      provenance: { harness: "pi" },
    });
    expect(metricsB.usage.outputTokens).toMatchObject({ value: 3 });
    expect(single.runs.capabilities(a.agentRunId)).toEqual(PI_CAPABILITIES);
  });

  it("serves capabilities and typed unsupported controls over the owner IPC", async () => {
    const dir = temp();
    const sup = new FakeSupervisor();
    sup.holdTranscript = true;
    const owner = await startResidentOwner({
      stateDir: dir,
      fsync: false,
      createService: (store) =>
        createPiRuntime({
          execution: createJinushiPiExecutionPort({
            client: sup.view(),
            executable: PI_PROFILE.executable,
            environment: { mode: "replace", set: { PATH: "/usr/bin" } },
          }),
          piVersion: SUPPORTED_PI_VERSION,
          piRevision: SUPPORTED_PI_REVISION,
          durableStore: store,
          commandTimeoutMs: 2_000,
        }),
    });
    cleanups.push(() => owner.close("detach"));
    const client = await connectOwner({ stateDir: dir });
    cleanups.push(() => client.close());
    const run = await client.runs.create({
      harness: "pi",
      request: { prompt: PROMPT },
      workspace: WORKSPACE,
    });
    expect(await client.runs.capabilities(run.agentRunId)).toEqual(
      PI_CAPABILITIES,
    );
    const error = await client.runs
      .steer(run.agentRunId, "more")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OwnerError);
    expect(error).toMatchObject({ code: "HARNESS_CAPABILITY_UNSUPPORTED" });
    await expect(
      client.runs.followUp(run.agentRunId, "more"),
    ).rejects.toMatchObject({ code: "HARNESS_CAPABILITY_UNSUPPORTED" });
    expect(sup.prompts).toBe(1);
    await client.runs.cancel(run.agentRunId);
  });
});
