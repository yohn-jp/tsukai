/** Wire protocol between SDK/CLI clients and the resident owner (JSONL over a Unix socket). */

export const OWNER_PROTOCOL_VERSION = 1;
export const OWNER_SOCKET_NAME = "owner.sock";
export const OWNER_TOKEN_NAME = "owner.token";
export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;

export type OwnerErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "RUN_NOT_FOUND"
  | "WAIT_TIMEOUT"
  | "OWNER_BUSY"
  | "OWNER_UNAVAILABLE"
  | "HARNESS_CAPABILITY_UNSUPPORTED"
  | "INTERNAL";

export class OwnerError extends Error {
  constructor(
    readonly code: OwnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OwnerError";
  }
}

export type OwnerRequest = { id: number; op: string } & Record<string, unknown>;

export type OwnerResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: true; done: true }
  | { id: number; ok: true; event: unknown }
  | { id: number; ok: false; error: { code: OwnerErrorCode; message: string } };

/** Bounded LF-delimited frame reader; an oversized frame is a protocol error. */
export function createFrameReader(
  maxBytes: number,
  onFrame: (text: string) => void,
  onError: (error: Error) => void,
): (chunk: Uint8Array) => void {
  let pending: Uint8Array[] = [];
  let size = 0;
  return (input) => {
    const chunk = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      size += end - start;
      if (size > maxBytes) {
        pending = [];
        size = 0;
        onError(new OwnerError("INVALID_REQUEST", "Frame exceeds size limit"));
        return;
      }
      pending.push(chunk.subarray(start, end));
      if (newline === -1) return;
      const text = Buffer.concat(pending).toString("utf8");
      pending = [];
      size = 0;
      start = newline + 1;
      if (text.length > 0) onFrame(text);
    }
  };
}
