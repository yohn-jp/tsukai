import { describe, expect, it } from "vitest";
import { createMockExecutionPort } from "../../src/adapters/mock/execution.js";
import type {
  ExecutionObserver,
  ExecutionPort,
} from "../../src/contracts/ports.js";
import type {
  PhysicalReceipt,
  RunCreateInput,
} from "../../src/contracts/types.js";

interface ObservedRun {
  output: Buffer[];
  receipt: Promise<PhysicalReceipt>;
  errors: Error[];
}

function observerFor(output: Buffer[] = []): {
  observer: ExecutionObserver;
  observed: ObservedRun;
} {
  let resolveReceipt!: (receipt: PhysicalReceipt) => void;
  const observed: ObservedRun = {
    output,
    receipt: new Promise((resolve) => {
      resolveReceipt = resolve;
    }),
    errors: [],
  };
  return {
    observed,
    observer: {
      onOutput(chunk) {
        output.push(Buffer.from(chunk));
      },
      onExit(receipt) {
        resolveReceipt(receipt);
      },
      onError(error) {
        observed.errors.push(error);
      },
    },
  };
}

function input(
  scenario: RunCreateInput["request"]["scenario"],
  request: RunCreateInput["request"] = { scenario },
): RunCreateInput["request"] {
  return request;
}

async function withDeadline<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`deadline exceeded (${ms}ms)`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function records(
  observed: ObservedRun,
): Array<{ type: string; event?: { type?: string } }> {
  return observed.output
    .join("")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) => JSON.parse(line) as { type: string; event?: { type?: string } },
    );
}

describe("mock fixture execution port", () => {
  it("starts distinct fixture processes and retires or releases only the selected run", async () => {
    const execution = createMockExecutionPort({
      terminationGraceMs: 25,
      cleanupTimeoutMs: 500,
    });
    const firstObserver = observerFor();
    const secondObserver = observerFor();
    const thirdObserver = observerFor();
    try {
      const [first, second, third] = await Promise.all([
        execution.start("first", input("hold"), firstObserver.observer),
        execution.start("second", input("hold"), secondObserver.observer),
        execution.start("third", input("hold"), thirdObserver.observer),
      ]);
      expect(new Set([first.pid, second.pid, third.pid]).size).toBe(3);
      expect(
        new Set([
          first.executionRunId,
          second.executionRunId,
          third.executionRunId,
        ]).size,
      ).toBe(3);
      expect(first.pid).toBeGreaterThan(0);

      await execution.retire(first.executionRunId, "cancel");
      await withDeadline(firstObserver.observed.receipt);
      expect(() => process.kill(second.pid, 0)).not.toThrow();
      expect(() => process.kill(third.pid, 0)).not.toThrow();
      expect(() => process.kill(process.pid, 0)).not.toThrow();

      await execution.input(second.executionRunId, { kind: "release" });
      const secondReceipt = await withDeadline(secondObserver.observed.receipt);
      expect(secondReceipt.executionRunId).toBe(second.executionRunId);
      expect(secondReceipt.exitCode).toBe(0);
      expect(
        records(secondObserver.observed).map((record) => record.event?.type),
      ).toContain("agent_settled");

      await execution.dispose();
      const thirdReceipt = await withDeadline(thirdObserver.observed.receipt);
      expect(thirdReceipt.executionRunId).toBe(third.executionRunId);
      expect(thirdReceipt.status).toBe("exited");
      expect(firstObserver.observed.errors).toEqual([]);
      expect(secondObserver.observed.errors).toEqual([]);
      expect(thirdObserver.observed.errors).toEqual([]);
    } finally {
      await execution.dispose();
    }
  });

  it("emits deterministic normal, error, crash, retry, and quiet traces", async () => {
    const execution: ExecutionPort = createMockExecutionPort({
      terminationGraceMs: 25,
      cleanupTimeoutMs: 500,
    });
    const observers = new Map<string, ReturnType<typeof observerFor>>();
    const scenarios = ["normal", "error", "crash", "retry"] as const;
    try {
      const bindings = await Promise.all(
        scenarios.map(async (scenario) => {
          const observed = observerFor();
          observers.set(scenario, observed);
          const binding = await execution.start(
            scenario,
            input(scenario, { scenario, reportedText: `reported ${scenario}` }),
            observed.observer,
          );
          return [scenario, binding] as const;
        }),
      );
      for (const [scenario, binding] of bindings) {
        const observed = observers.get(scenario)!;
        const receipt = await withDeadline(observed.observed.receipt);
        const eventTypes = records(observed.observed).map(
          (record) => record.event?.type,
        );
        expect(receipt.executionRunId).toBe(binding.executionRunId);
        if (scenario === "normal") {
          expect(receipt.exitCode).toBe(0);
          expect(eventTypes).toEqual([
            "agent_start",
            "message_end",
            "agent_end",
            "agent_settled",
          ]);
        } else if (scenario === "error") {
          expect(receipt.exitCode).toBe(0);
          expect(eventTypes.at(-1)).toBe("agent_settled");
        } else if (scenario === "crash") {
          expect(receipt.exitCode).not.toBe(0);
          expect(eventTypes).not.toContain("agent_settled");
        } else {
          expect(receipt.exitCode).toBe(0);
          expect(eventTypes.indexOf("agent_end")).toBeLessThan(
            eventTypes.indexOf("agent_retry"),
          );
          expect(eventTypes.indexOf("agent_retry")).toBeLessThan(
            eventTypes.indexOf("compaction_start"),
          );
          expect(eventTypes.at(-1)).toBe("agent_settled");
        }
        expect(observed.observed.errors).toEqual([]);
      }

      const quiet = observerFor();
      const quietBinding = await execution.start(
        "quiet",
        input("quiet"),
        quiet.observer,
      );
      const quietState = await Promise.race([
        quiet.observed.receipt.then(() => "exited" as const),
        new Promise<"quiet">((resolve) =>
          setTimeout(() => resolve("quiet"), 35),
        ),
      ]);
      expect(quietState).toBe("quiet");
      expect(quiet.observed.output).toEqual([]);
      await execution.retire(quietBinding.executionRunId, "cancel");
      const quietReceipt = await withDeadline(quiet.observed.receipt);
      expect(quietReceipt.exitCode).toBeNull();
      expect(quietReceipt.signal).toBe("SIGTERM");
    } finally {
      await execution.dispose();
    }
  });

  it("accepts only the fixed release command and rejects invalid fixture requests", async () => {
    const execution = createMockExecutionPort({ cleanupTimeoutMs: 500 });
    const observed = observerFor();
    try {
      await expect(
        execution.start(
          "invalid",
          { scenario: "normal", reportedText: "x".repeat(100_000) },
          observed.observer,
        ),
      ).rejects.toThrow(/reportedText/);
      const binding = await execution.start(
        "hold",
        input("hold"),
        observed.observer,
      );
      await expect(
        execution.input(binding.executionRunId, { kind: "anything" } as never),
      ).rejects.toThrow(/Unsupported mock input/);
      await execution.retire(binding.executionRunId, "cancel");
      await withDeadline(observed.observed.receipt);
    } finally {
      await execution.dispose();
    }
  });
});
