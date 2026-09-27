import { mkdtemp, rm } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createJinushiClient,
  JinushiClientError,
} from "../../src/adapters/jinushi/client.js";
import type { JinushiRunSpec } from "../../src/adapters/jinushi/contract.js";

const MAX_FRAME_BYTES = 1 << 20;

interface FakeSupervisor {
  stateDir: string;
  requests: Record<string, unknown>[];
  readonly connections: number;
  close(): Promise<void>;
}

const supervisors: FakeSupervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((server) => server.close()));
});

describe("Jinushi protocol v1 client", () => {
  it("maps operations to one big-endian framed request and validates typed responses", async () => {
    const server = await fakeSupervisor((socket, request) => {
      switch (request.op) {
        case "capabilities":
          sendFrame(socket, {
            version: 1,
            capabilities: { backend: "linux-cgroup-v2" },
          });
          break;
        case "run":
        case "inspect":
          sendFrame(socket, { version: 1, run: runRecord() });
          break;
        case "input":
        case "close-input":
        case "cancel":
          sendFrame(socket, { version: 1, run: runRecord("running") });
          break;
        case "output":
          sendFrame(socket, {
            version: 1,
            data: Buffer.from([0, 1, 2]).toString("base64"),
            retainedFrom: 2,
            gap: true,
          });
          break;
        case "await":
          sendFrame(socket, { version: 1, run: runRecord("terminal", true) });
          break;
        default:
          throw new Error(`unexpected operation ${String(request.op)}`);
      }
    });
    const client = createJinushiClient(server.stateDir);

    expect(await client.capabilities()).toEqual({ backend: "linux-cgroup-v2" });
    expect(await client.run("submission-1", runSpec())).toMatchObject({
      runId: "run_abc",
      state: "accepted",
    });
    await client.input("run_abc", "input-1", 1, new Uint8Array([0, 1, 2]));
    await client.closeInput("run_abc", "close-1", 1);
    const output = await client.output("run_abc", "stdout", 1, 3);
    expect([...output.data]).toEqual([0, 1, 2]);
    expect(output).toMatchObject({ retainedFrom: 2, gap: true });
    expect(await client.inspect("run_abc")).toMatchObject({
      state: "accepted",
    });
    expect(await client.await("run_abc")).toMatchObject({
      state: "terminal",
      receipt: { outcome: "exited", output: { historyComplete: true } },
    });
    await client.cancel("run_abc", "cancel-1", 1);

    expect(server.requests.map((request) => request.op)).toEqual([
      "capabilities",
      "run",
      "input",
      "close-input",
      "output",
      "inspect",
      "await",
      "cancel",
    ]);
    expect(server.requests[1]).toMatchObject({
      version: 1,
      op: "run",
      submissionId: "submission-1",
      spec: {
        argv: ["pi", "--mode", "rpc", "--no-session"],
        interactive: false,
        lifetime: { mode: "detached" },
      },
    });
    expect(server.requests[2]).toMatchObject({
      requestId: "input-1",
      expectedGeneration: 1,
      data: "AAEC",
    });
    expect(server.requests[4]).toMatchObject({
      op: "output",
      runId: "run_abc",
      stream: "stdout",
      offset: 1,
      limit: 3,
    });
    expect(server.requests.every((request) => request.version === 1)).toBe(
      true,
    );
    expect(server.connections).toBe(server.requests.length);
  });

  it("uses Jinushi follow and preserves event gaps and ordered events", async () => {
    const server = await fakeSupervisor((socket, request) => {
      expect(request).toMatchObject({
        version: 1,
        op: "events",
        runId: "run_abc",
        after: 1,
        follow: true,
      });
      sendFrame(socket, {
        version: 1,
        run: runRecord("running"),
        retainedFrom: 4,
        gap: true,
      });
      sendFrame(socket, {
        version: 1,
        run: runRecord("terminal", true),
        retainedFrom: 4,
        gap: false,
        events: [
          {
            version: 1,
            runId: "run_abc",
            seq: 4,
            kind: "run.terminal",
            observedAt: "2026-09-27T00:00:00Z",
            payload: { run: { state: "terminal" } },
          },
        ],
      });
      socket.end();
    });
    const pages: unknown[] = [];
    const controller = new AbortController();

    await createJinushiClient(server.stateDir).followEvents(
      "run_abc",
      1,
      controller.signal,
      async (page) => {
        pages.push(page);
      },
    );

    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ events: [], retainedFrom: 4, gap: true });
    expect(pages[1]).toMatchObject({
      events: [{ seq: 4, kind: "run.terminal" }],
      run: { state: "terminal" },
    });
  });

  it.each([
    [
      "run",
      async (client: ReturnType<typeof createJinushiClient>) =>
        client.run("submission-retry", runSpec()),
    ],
    [
      "input",
      async (client: ReturnType<typeof createJinushiClient>) =>
        client.input("run_abc", "input-retry", 1, new Uint8Array([7])),
    ],
  ])(
    "marks a lost %s response uncertain and does not retry",
    async (_operation, invoke) => {
      const server = await fakeSupervisor((socket) => {
        socket.destroy();
      });
      const client = createJinushiClient(server.stateDir);

      const error = await invoke(client).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(JinushiClientError);
      expect(error).toMatchObject({
        kind: "transport",
        ambiguousEffect: true,
      });
      expect(server.requests).toHaveLength(1);
    },
  );

  it("keeps explicit pre-effect input rejection distinct from transport ambiguity", async () => {
    const server = await fakeSupervisor((socket) => {
      sendFrame(socket, {
        version: 1,
        error: { code: "unsupported-capability", message: "not available" },
      });
    });

    const error = await createJinushiClient(server.stateDir)
      .input("run_abc", "input-test", 1, new Uint8Array([1]))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JinushiClientError);
    expect(error).toMatchObject({
      kind: "remote",
      code: "unsupported-capability",
      ambiguousEffect: false,
    });
    expect(server.requests).toHaveLength(1);
  });

  it.each(["invalid-response", "storage-failure"])(
    "marks a %s Run response ambiguous",
    async (code) => {
      const server = await fakeSupervisor((socket) => {
        sendFrame(socket, {
          version: 1,
          error: {
            code,
            message: "Run effect cannot be proven",
          },
        });
      });
      const error = await createJinushiClient(server.stateDir)
        .run("submission-test", runSpec())
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        kind: "remote",
        code,
        ambiguousEffect: true,
      });
      expect(server.requests).toHaveLength(1);
    },
  );

  it("recognizes an explicit pre-effect Run rejection", async () => {
    const server = await fakeSupervisor((socket) => {
      sendFrame(socket, {
        version: 1,
        error: { code: "invalid-request", message: "cwd must be absolute" },
      });
    });
    const error = await createJinushiClient(server.stateDir)
      .run("submission-test", runSpec())
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "remote",
      code: "invalid-request",
      ambiguousEffect: false,
    });
    expect(server.requests).toHaveLength(1);
  });

  it("marks an input backend failure as potentially partially delivered", async () => {
    const server = await fakeSupervisor((socket) => {
      sendFrame(socket, {
        version: 1,
        error: { code: "backend-failure", message: "stdin write failed" },
      });
    });
    const error = await createJinushiClient(server.stateDir)
      .input("run_abc", "input-test", 1, new Uint8Array([1]))
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "remote",
      code: "backend-failure",
      ambiguousEffect: true,
    });
    expect(server.requests).toHaveLength(1);
  });

  it("treats a response timeout after submission as ambiguous", async () => {
    const server = await fakeSupervisor(() => {});
    const error = await createJinushiClient(server.stateDir, {
      requestTimeoutMs: 20,
    })
      .run("submission-test", runSpec())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JinushiClientError);
    expect(error).toMatchObject({
      kind: "timeout",
      operation: "run",
      ambiguousEffect: true,
    });
    expect(server.requests).toHaveLength(1);
  });

  it("rejects oversized and malformed frames without decoding them as protocol values", async () => {
    const oversized = await fakeSupervisor((socket) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
      socket.write(header);
    });
    const oversizedError = await createJinushiClient(oversized.stateDir)
      .capabilities()
      .catch((caught: unknown) => caught);
    expect(oversizedError).toMatchObject({
      kind: "protocol",
      operation: "capabilities",
    });

    const malformed = await fakeSupervisor((socket) => {
      sendRawFrame(socket, Buffer.from("{"));
    });
    const malformedError = await createJinushiClient(malformed.stateDir)
      .capabilities()
      .catch((caught: unknown) => caught);
    expect(malformedError).toMatchObject({
      kind: "protocol",
      operation: "capabilities",
    });

    const invalidUtf8 = await fakeSupervisor((socket) => {
      sendRawFrame(
        socket,
        Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
      );
    });
    const invalidUtf8Error = await createJinushiClient(invalidUtf8.stateDir)
      .capabilities()
      .catch((caught: unknown) => caught);
    expect(invalidUtf8Error).toMatchObject({
      kind: "protocol",
      operation: "capabilities",
    });
  });

  it("reports EOF before the response frame as a transport failure", async () => {
    const server = await fakeSupervisor((socket) => socket.end());
    const error = await createJinushiClient(server.stateDir)
      .run("submission-test", runSpec())
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "transport",
      operation: "run",
      ambiguousEffect: true,
    });
    expect(server.requests).toHaveLength(1);
  });

  it("rejects over-limit input locally without opening a connection", async () => {
    const server = await fakeSupervisor(() => {
      throw new Error("no request is expected");
    });
    const error = await createJinushiClient(server.stateDir)
      .input("run_abc", "oversized", 1, new Uint8Array(65_537))
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "validation", operation: "input" });
    expect(server.requests).toHaveLength(0);
  });

  it("stops a live event subscription when its signal is aborted", async () => {
    const controller = new AbortController();
    const server = await fakeSupervisor((_socket, request) => {
      expect(request.op).toBe("events");
      setTimeout(() => controller.abort(), 20);
    });

    await expect(
      createJinushiClient(server.stateDir).followEvents(
        "run_abc",
        0,
        controller.signal,
        async () => {},
      ),
    ).resolves.toBeUndefined();
    expect(server.requests).toHaveLength(1);
  });

  it("rejects output beyond the requested bounded page size", async () => {
    const server = await fakeSupervisor((socket) => {
      sendFrame(socket, {
        version: 1,
        data: Buffer.from([1, 2]).toString("base64"),
        retainedFrom: 0,
        gap: false,
      });
    });
    const error = await createJinushiClient(server.stateDir)
      .output("run_abc", "stdout", 0, 1)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "protocol", operation: "output" });
    expect(server.requests).toHaveLength(1);
  });
});

async function fakeSupervisor(
  handle: (socket: Socket, request: Record<string, unknown>) => void,
): Promise<FakeSupervisor> {
  const stateDir = await mkdtemp(join(tmpdir(), "tsukai-jinushi-client-"));
  const requests: Record<string, unknown>[] = [];
  let connections = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength < 4) return;
      const size = buffered.readUInt32BE(0);
      if (
        size === 0 ||
        size > MAX_FRAME_BYTES ||
        buffered.byteLength < size + 4
      )
        return;
      const request = JSON.parse(
        buffered.subarray(4, size + 4).toString("utf8"),
      ) as Record<string, unknown>;
      requests.push(request);
      handle(socket, request);
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(join(stateDir, "jinushi.sock"), () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });

  const result: FakeSupervisor = {
    stateDir,
    requests,
    get connections() {
      return connections;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
      await rm(stateDir, { recursive: true, force: true });
    },
  };
  supervisors.push(result);
  return result;
}

function sendFrame(socket: Socket, value: unknown): void {
  sendRawFrame(socket, Buffer.from(JSON.stringify(value), "utf8"));
}

function sendRawFrame(socket: Socket, body: Buffer): void {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  socket.write(Buffer.concat([header, body]));
}

function runSpec(): JinushiRunSpec {
  return {
    argv: ["pi", "--mode", "rpc", "--no-session"],
    cwd: "/tmp/worktree",
    environment: { mode: "inherit-supervisor", set: {}, unset: [] },
    interactive: false,
    lifetime: { mode: "detached" },
    correlation: { agentRunId: "ar_123" },
  };
}

function runRecord(
  state: string = "accepted",
  withReceipt = false,
): Record<string, unknown> {
  return {
    runId: "run_abc",
    generation: 1,
    state,
    output: {
      stdout: {
        observedBytes: 0,
        retainedBytes: 0,
        retainedFrom: 0,
        truncated: false,
      },
      stderr: {
        observedBytes: 0,
        retainedBytes: 0,
        retainedFrom: 0,
        truncated: false,
      },
      historyComplete: true,
    },
    ...(withReceipt
      ? {
          receipt: {
            version: 1,
            runId: "run_abc",
            outcome: "exited",
            exitCode: 0,
            forced: false,
            cleanup: "complete",
            output: { historyComplete: true },
            evidenceIncomplete: false,
          },
        }
      : {}),
  };
}
