interface FixtureRequest {
  scenario: "normal" | "error" | "crash" | "retry" | "quiet" | "hold";
  reportedText?: string;
  delayMs?: number;
}

interface StartMessage {
  type: "start";
  agentRunId: string;
  request: FixtureRequest;
}

const MAX_CONTROL_RECORD_BYTES = 64 * 1024;
const MAX_REPORTED_TEXT_BYTES = 32 * 1024;
let bufferedInput = Buffer.alloc(0);
let started = false;
let gateScenario: FixtureRequest["scenario"] | undefined;
let releaseGate: (() => void) | undefined;
let gateReleased = false;

function fail(): void {
  process.exitCode = 70;
  process.stdin.destroy();
}

function isScenario(value: unknown): value is FixtureRequest["scenario"] {
  return (
    value === "normal" ||
    value === "error" ||
    value === "crash" ||
    value === "retry" ||
    value === "quiet" ||
    value === "hold"
  );
}

function parseStart(value: unknown): StartMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const message = value as Record<string, unknown>;
  if (message.type !== "start" || typeof message.agentRunId !== "string")
    return undefined;
  if (
    !message.request ||
    typeof message.request !== "object" ||
    Array.isArray(message.request)
  ) {
    return undefined;
  }
  const request = message.request as Record<string, unknown>;
  if (!isScenario(request.scenario)) return undefined;
  if (
    request.reportedText !== undefined &&
    (typeof request.reportedText !== "string" ||
      Buffer.byteLength(request.reportedText, "utf8") > MAX_REPORTED_TEXT_BYTES)
  ) {
    return undefined;
  }
  if (
    request.delayMs !== undefined &&
    (!Number.isSafeInteger(request.delayMs) ||
      (request.delayMs as number) < 0 ||
      (request.delayMs as number) > 2_000)
  ) {
    return undefined;
  }
  const requestKeys = new Set(["scenario", "reportedText", "delayMs"]);
  if (Object.keys(request).some((key) => !requestKeys.has(key)))
    return undefined;
  const messageKeys = new Set(["type", "agentRunId", "request"]);
  if (Object.keys(message).some((key) => !messageKeys.has(key)))
    return undefined;
  return {
    type: "start",
    agentRunId: message.agentRunId,
    request: {
      scenario: request.scenario,
      ...(request.reportedText === undefined
        ? {}
        : { reportedText: request.reportedText as string }),
      ...(request.delayMs === undefined
        ? {}
        : { delayMs: request.delayMs as number }),
    },
  };
}

function sleep(ms: number): Promise<void> {
  return ms === 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, ms));
}

async function emit(
  event: Record<string, unknown>,
  delayMs: number,
): Promise<void> {
  const line = `${JSON.stringify({ type: "pi-event", event })}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_CONTROL_RECORD_BYTES) {
    throw new RangeError("Fixture output record exceeds its byte limit");
  }
  if (!process.stdout.write(line)) {
    await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
  }
  await sleep(delayMs);
}

async function waitForRelease(): Promise<void> {
  if (gateReleased) return;
  await new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
}

async function runFixture(
  agentRunId: string,
  request: FixtureRequest,
): Promise<void> {
  gateScenario = request.scenario;
  const delayMs = request.delayMs ?? 0;
  const resultText =
    request.reportedText ?? `Mock fixture completed: ${agentRunId}`;
  if (request.scenario === "quiet") {
    // The process stays alive without emitting evidence until the owner retires it.
    await new Promise<void>(() => undefined);
    return;
  }

  if (request.scenario === "hold") {
    await emit({ type: "agent_start" }, delayMs);
    await emit({ type: "prompt_accepted", success: true }, delayMs);
    await emit({ type: "agent_end" }, delayMs);
    await waitForRelease();
    await emit({ type: "agent_start" }, delayMs);
  } else if (request.scenario === "crash") {
    await emit({ type: "agent_start" }, delayMs);
    process.exitCode = 71;
    process.stdin.destroy();
    return;
  } else if (request.scenario === "retry") {
    await emit({ type: "agent_start" }, delayMs);
    await emit({ type: "agent_end" }, delayMs);
    await emit({ type: "agent_retry", attempt: 2 }, delayMs);
    await emit({ type: "compaction_start" }, delayMs);
    await emit({ type: "compaction_end" }, delayMs);
    await emit({ type: "agent_start" }, delayMs);
  } else {
    await emit({ type: "agent_start" }, delayMs);
  }

  if (request.scenario === "error") {
    await emit(
      {
        type: "agent_settled",
        finalStatus: "error",
        reason: "fixture_error",
      },
      delayMs,
    );
  } else {
    await emit(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: resultText }],
        },
      },
      delayMs,
    );
    await emit({ type: "agent_end" }, delayMs);
    await emit({ type: "agent_settled", finalStatus: "success" }, delayMs);
  }
  process.stdin.destroy();
}

function acceptLine(bytes: Buffer): void {
  const line = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8")) as unknown;
  } catch {
    fail();
    return;
  }

  if (!started) {
    const start = parseStart(value);
    if (!start) {
      fail();
      return;
    }
    started = true;
    void runFixture(start.agentRunId, start.request).catch(() => fail());
    return;
  }

  if (
    gateScenario === "hold" &&
    !gateReleased &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "release" &&
    Object.keys(value as Record<string, unknown>).length === 1
  ) {
    gateReleased = true;
    releaseGate?.();
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  if (bufferedInput.byteLength + chunk.byteLength > MAX_CONTROL_RECORD_BYTES) {
    fail();
    return;
  }
  bufferedInput = Buffer.concat([bufferedInput, chunk]);
  while (true) {
    const delimiter = bufferedInput.indexOf(0x0a);
    if (delimiter < 0) break;
    const line = bufferedInput.subarray(0, delimiter);
    bufferedInput = bufferedInput.subarray(delimiter + 1);
    if (line.byteLength > MAX_CONTROL_RECORD_BYTES) {
      fail();
      return;
    }
    acceptLine(line);
  }
});

process.stdin.on("end", () => {
  if (bufferedInput.byteLength > 0) fail();
});
