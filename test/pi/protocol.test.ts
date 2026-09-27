import { describe, expect, it } from "vitest";
import { createPiRpcClient } from "../../src/adapters/pi/protocol.js";
import type { PiDuplexExecution } from "../../src/contracts/pi.js";

const utf8 = new TextEncoder();

function execution(
  write: (bytes: Uint8Array) => Promise<void> = async () => {},
): PiDuplexExecution {
  return {
    executionRunId: "execution-test",
    backend: "test",
    write,
    closeInput: async () => {},
    retire: async () => {},
  };
}

function wire(record: Record<string, unknown>, ending = "\n"): Uint8Array {
  return utf8.encode(`${JSON.stringify(record)}${ending}`);
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Pi RPC protocol client", () => {
  it("frames fragmented UTF-8 records, accepts CRLF, and preserves Unicode separators", () => {
    const observed: Array<{ record: Record<string, unknown>; frame: string }> =
      [];
    const client = createPiRpcClient(execution(), (record, frame) => {
      observed.push({ record, frame: new TextDecoder().decode(frame) });
    });
    const record = {
      type: "message_update",
      text: "こんにちは\u2028世界\u2029!",
    };
    const frame = wire(record, "\r\n");
    const split = frame.indexOf(0xe3);

    client.push(frame.slice(0, split + 1));
    expect(observed).toEqual([]);
    client.push(frame.slice(split + 1));

    expect(observed).toEqual([
      { record, frame: `${JSON.stringify(record)}\r\n` },
    ]);
    client.finish();
  });

  it("correlates concurrent commands by unique IDs and suppresses response records from events", async () => {
    const writes: string[] = [];
    const events: Record<string, unknown>[] = [];
    const client = createPiRpcClient(
      execution(async (bytes) => {
        writes.push(new TextDecoder().decode(bytes));
      }),
      (record) => events.push(record),
    );
    const getState = client.request({ type: "get_state" });
    const prompt = client.request({ type: "prompt", message: "hello" });
    await tick();

    const commands = writes.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(commands).toHaveLength(2);
    expect(new Set(commands.map((command) => command.id)).size).toBe(2);
    expect(commands[0]).toMatchObject({ type: "get_state" });
    expect(commands[1]).toMatchObject({ type: "prompt", message: "hello" });

    const first = commands[0];
    const second = commands[1];
    if (first === undefined || second === undefined)
      throw new Error("missing command");
    client.push(
      wire({
        id: second.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { queued: true },
      }),
    );
    client.push(
      wire({
        id: first.id,
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "session-test" },
      }),
    );

    await expect(prompt).resolves.toMatchObject({
      command: "prompt",
      success: true,
      data: { queued: true },
    });
    await expect(getState).resolves.toMatchObject({
      command: "get_state",
      success: true,
      data: { sessionId: "session-test" },
    });
    expect(events).toEqual([]);
    expect(client.pendingCount()).toBe(0);
    client.finish();
  });

  it("fails all outstanding requests on an unknown or duplicate response", async () => {
    const ids: string[] = [];
    const client = createPiRpcClient(
      execution(async (bytes) => {
        ids.push(
          (JSON.parse(new TextDecoder().decode(bytes)) as { id: string }).id,
        );
      }),
      () => {},
    );
    const request = client.request({ type: "get_state" });
    const other = client.request({ type: "abort" });
    await tick();
    client.push(
      wire({
        id: ids[0],
        type: "response",
        command: "get_state",
        success: true,
      }),
    );
    await request;
    client.push(
      wire({
        id: ids[0],
        type: "response",
        command: "get_state",
        success: true,
      }),
    );

    await expect(other).rejects.toMatchObject({ code: "UNKNOWN_RESPONSE_ID" });
    expect(client.pendingCount()).toBe(0);

    const unknownClient = createPiRpcClient(execution(), () => {});
    const unknownFirst = unknownClient.request({ type: "get_state" });
    const unknownSecond = unknownClient.request({ type: "abort" });
    unknownClient.push(
      wire({
        id: "never-issued",
        type: "response",
        command: "get_state",
        success: true,
      }),
    );
    await expect(unknownFirst).rejects.toMatchObject({
      code: "UNKNOWN_RESPONSE_ID",
    });
    await expect(unknownSecond).rejects.toMatchObject({
      code: "UNKNOWN_RESPONSE_ID",
    });
  });

  it("fails all outstanding requests when the response command does not match", async () => {
    let requestId = "";
    const client = createPiRpcClient(
      execution(async (bytes) => {
        requestId = (
          JSON.parse(new TextDecoder().decode(bytes)) as { id: string }
        ).id;
      }),
      () => {},
    );
    const request = client.request({ type: "get_state" });
    await tick();
    client.push(
      wire({
        id: requestId,
        type: "response",
        command: "prompt",
        success: true,
      }),
    );

    await expect(request).rejects.toMatchObject({
      code: "RESPONSE_COMMAND_MISMATCH",
    });
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects malformed UTF-8, malformed JSON, and non-object records", async () => {
    for (const input of [
      Uint8Array.of(0xc3, 0x28, 0x0a),
      utf8.encode("{not json}\n"),
      utf8.encode("[]\n"),
    ]) {
      const client = createPiRpcClient(execution(), () => {});
      const pending = client.request({ type: "get_state" });
      client.push(input);
      await expect(pending).rejects.toBeInstanceOf(Error);
      expect(client.pendingCount()).toBe(0);
    }
  });

  it("rejects oversized records and oversized input chunks", async () => {
    const recordClient = createPiRpcClient(execution(), () => {}, {
      maxRecordBytes: 64,
      maxBufferedBytes: 128,
    });
    const recordPending = recordClient.request({ type: "get_state" });
    recordClient.push(utf8.encode(`${"x".repeat(65)}`));
    await expect(recordPending).rejects.toMatchObject({ code: "RECORD_LIMIT" });

    const chunkClient = createPiRpcClient(execution(), () => {}, {
      maxRecordBytes: 64,
      maxBufferedBytes: 128,
    });
    const chunkPending = chunkClient.request({ type: "get_state" });
    chunkClient.push(new Uint8Array(129));
    await expect(chunkPending).rejects.toMatchObject({ code: "BUFFER_LIMIT" });
  });

  it("cleans timed-out requests and rejects pending commands on EOF", async () => {
    const timeoutClient = createPiRpcClient(execution(), () => {});
    const timedOut = timeoutClient.request({ type: "get_state" }, 5);
    await expect(timedOut).rejects.toMatchObject({ name: "PiRpcTimeoutError" });
    expect(timeoutClient.pendingCount()).toBe(0);

    const eofClient = createPiRpcClient(execution(), () => {});
    const pending = eofClient.request({ type: "prompt", message: "hello" });
    eofClient.finish();
    await expect(pending).rejects.toMatchObject({
      name: "PiRpcTransportClosedError",
    });
    expect(eofClient.pendingCount()).toBe(0);

    const partialClient = createPiRpcClient(execution(), () => {});
    const partial = partialClient.request({ type: "get_state" });
    partialClient.push(utf8.encode('{"type":"event"}'));
    partialClient.finish();
    await expect(partial).rejects.toMatchObject({
      code: "UNTERMINATED_RECORD",
    });
  });

  it("serializes writes and waits for injected stdin backpressure", async () => {
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = createPiRpcClient(
      execution(async (bytes) => {
        writes.push(new TextDecoder().decode(bytes));
        if (writes.length === 1) await firstWrite;
      }),
      () => {},
    );
    const first = client.request({ type: "get_state" });
    const second = client.request({ type: "abort" });
    await tick();
    expect(writes).toHaveLength(1);
    releaseFirst();
    await tick();
    expect(writes).toHaveLength(2);

    client.fail(new Error("test shutdown"));
    await expect(first).rejects.toThrow("test shutdown");
    await expect(second).rejects.toThrow("test shutdown");
  });

  it("bounds queued writes when a stalled write outlives its request timeout", async () => {
    let releaseWrite!: () => void;
    const writeBarrier = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const client = createPiRpcClient(
      execution(() => writeBarrier),
      () => {},
      { maxPendingRequests: 1 },
    );
    const timedOut = client.request({ type: "get_state" }, 5);
    await expect(timedOut).rejects.toMatchObject({ name: "PiRpcTimeoutError" });
    await expect(client.request({ type: "abort" })).rejects.toMatchObject({
      code: "WRITE_QUEUE_LIMIT",
    });
    releaseWrite();
    client.fail(new Error("test shutdown"));
  });
});
