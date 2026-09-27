import type { JsonObject, JsonValue } from "../contracts/types.js";

const PRIVATE_EXACT = new Set([
  "prompt",
  "text",
  "reportedtext",
  "thinking",
  "thought",
  "content",
  "message",
  "arg",
  "args",
  "argument",
  "arguments",
  "result",
  "stderr",
  "environment",
  "env",
  "credential",
  "credentials",
  "secret",
  "authorization",
  "apikey",
  "key",
  "token",
  "password",
  "cookie",
  "input",
  "output",
  "delta",
  "error",
  "stack",
  "rawinput",
  "rawoutput",
  "rawbytes",
]);
const SAFE_USAGE_KEYS = new Set([
  "input",
  "output",
  "token",
  "tokens",
  "inputtokens",
  "outputtokens",
  "prompttokens",
  "completiontokens",
  "cachedinputtokens",
  "cachecreationinputtokens",
  "totaltokens",
  "reasoningtokens",
]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_JSON_DEPTH = 16;
const MAX_CONTAINER_ENTRIES = 1024;

function isPrivateKey(key: string, value: unknown): boolean {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  if (
    SAFE_USAGE_KEYS.has(normalized) &&
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return false;
  }
  if (PRIVATE_EXACT.has(normalized)) return true;
  return (
    /(?:prompt|text|thinking|thought|content|message|argument|result|stderr|environment|credential|secret|password|authorization|cookie|rawinput|rawoutput|rawbytes)/i.test(
      normalized,
    ) || /(?:access|refresh|api|auth)?token$|apikey/i.test(normalized)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Clone JSON data into plain containers while removing default-private content fields. */
export function metadataJson(
  value: unknown,
  maxStringBytes = 64 * 1024,
): JsonValue {
  const active = new WeakSet<object>();
  let visited = 0;
  let stringBytes = 0;

  const accountString = (value: string): void => {
    if (value.length > maxStringBytes) {
      throw new TypeError("JSON string exceeds the record byte limit");
    }
    stringBytes += utf8Bytes(value);
    if (stringBytes > maxStringBytes) {
      throw new TypeError("JSON strings exceed the record byte limit");
    }
  };

  const visit = (current: unknown, depth: number): JsonValue => {
    if (++visited > MAX_CONTAINER_ENTRIES * 4) {
      throw new TypeError("JSON payload contains too many values");
    }
    if (depth > MAX_JSON_DEPTH)
      throw new TypeError("JSON payload is too deeply nested");
    if (current === null || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "string") {
      accountString(current);
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current))
        throw new TypeError("JSON numbers must be finite");
      return current;
    }
    if (typeof current !== "object")
      throw new TypeError("Payload must contain JSON values");
    if (active.has(current))
      throw new TypeError("Payload must not contain cycles");
    active.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > MAX_CONTAINER_ENTRIES) {
          throw new TypeError("JSON array contains too many values");
        }
        return current.map((item) => visit(item, depth + 1));
      }
      if (!isRecord(current))
        throw new TypeError("Payload objects must be plain JSON objects");
      const copy: Record<string, JsonValue> = Object.create(null) as Record<
        string,
        JsonValue
      >;
      let entries = 0;
      for (const key of Object.keys(current)) {
        if (++entries > MAX_CONTAINER_ENTRIES) {
          throw new TypeError("JSON object contains too many fields");
        }
        if (FORBIDDEN_KEYS.has(key))
          throw new TypeError(`Forbidden JSON key: ${key}`);
        if (isPrivateKey(key, current[key])) continue;
        accountString(key);
        copy[key] = visit(current[key], depth + 1);
      }
      return copy;
    } finally {
      active.delete(current);
    }
  };

  return visit(value, 0);
}

export function jsonObject(
  value: unknown,
  maxStringBytes = 64 * 1024,
): JsonObject {
  const safe = metadataJson(value, maxStringBytes);
  if (safe === null || Array.isArray(safe) || typeof safe !== "object") {
    throw new TypeError("Expected a JSON object");
  }
  return safe;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
