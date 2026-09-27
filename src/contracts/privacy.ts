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
export const FORBIDDEN_JSON_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

export function isPrivateMetadataKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return (
    PRIVATE_EXACT.has(normalized) ||
    /(?:prompt|text|thinking|thought|content|message|argument|result|stderr|environment|credential|secret|password|authorization|cookie|rawinput|rawoutput|rawbytes)/i.test(
      normalized,
    ) ||
    /(?:access|refresh|api|auth)?token$|apikey/i.test(normalized)
  );
}

export function isPrivatePayloadKey(key: string, value: unknown): boolean {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  if (
    SAFE_USAGE_KEYS.has(normalized) &&
    typeof value === "number" &&
    Number.isFinite(value)
  )
    return false;
  return isPrivateMetadataKey(key);
}
