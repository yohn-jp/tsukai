import { createHash } from "node:crypto";
import {
  EXECUTION_PROFILE_SCHEMA_VERSION,
  type EffectiveExecutionProfile,
  type ExecutionProfileCapabilities,
  type ExecutionProfileTool,
} from "../contracts/profile.js";

export const MAX_PROFILE_TOOLS = 32;
export const MAX_PROFILE_EXTENSIONS = 8;

/*
 * Selector grammars. A leading alphanumeric excludes option-like (`-`),
 * file-argument (`@`), and home-relative (`~`) values; commas and whitespace
 * are excluded because harness tool lists are comma-separated.
 */
export const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  fail: (message: string) => never,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} has an unknown field: ${key}`);
  }
}

/** Canonical identity of the safe profile fields, in a fixed key order. */
export function executionProfileFingerprint(
  profile: Omit<EffectiveExecutionProfile, "fingerprint">,
): string {
  const canonical = JSON.stringify([
    profile.schemaVersion,
    profile.provider ?? null,
    profile.model ?? null,
    profile.tools.map((tool) =>
      tool.source === "builtin"
        ? ["builtin", tool.name]
        : ["extension", tool.extension, tool.name],
    ),
    profile.extensions.map((extension) => [extension.id, extension.sha256]),
  ]);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** Copy of an effective profile (snapshots are immutable copies). */
export function cloneEffectiveProfile(
  profile: EffectiveExecutionProfile,
): EffectiveExecutionProfile {
  return {
    schemaVersion: profile.schemaVersion,
    fingerprint: profile.fingerprint,
    ...(profile.provider === undefined ? {} : { provider: profile.provider }),
    ...(profile.model === undefined ? {} : { model: profile.model }),
    tools: profile.tools.map((tool) =>
      tool.source === "builtin"
        ? { source: "builtin", name: tool.name }
        : { source: "extension", extension: tool.extension, name: tool.name },
    ),
    extensions: profile.extensions.map((extension) => ({
      id: extension.id,
      sha256: extension.sha256,
    })),
  };
}

/**
 * Restart check for a persisted effective profile: its fingerprint must still
 * cover its fields, and the adapter now registered must still configure every
 * dimension it uses. Returns the uncertainty reason, or undefined when the
 * run may be re-attached under unchanged semantics.
 */
export function persistedProfileProblem(
  profile: EffectiveExecutionProfile,
  capabilities: ExecutionProfileCapabilities | undefined,
): "execution-profile-drift" | "execution-profile-unsupported" | undefined {
  if (executionProfileFingerprint(profile) !== profile.fingerprint)
    return "execution-profile-drift";
  if (capabilities === undefined) return "execution-profile-unsupported";
  if (
    profile.provider !== undefined &&
    capabilities.provider.tsukai !== "configurable"
  )
    return "execution-profile-unsupported";
  if (
    profile.model !== undefined &&
    capabilities.model.tsukai !== "configurable"
  )
    return "execution-profile-unsupported";
  if (
    profile.extensions.length > 0 &&
    capabilities.extensions.tsukai !== "configurable"
  )
    return "execution-profile-unsupported";
  if (profile.tools.length > 0 && capabilities.tools.tsukai !== "configurable")
    return "execution-profile-unsupported";
  const builtin = new Set(capabilities.tools.builtin);
  for (const tool of profile.tools) {
    if (tool.source === "builtin" && !builtin.has(tool.name))
      return "execution-profile-unsupported";
  }
  return undefined;
}

/**
 * Strict whitelisting parse of a persisted or journaled effective profile.
 * Unknown fields, unsorted or duplicate entries, and malformed identifiers
 * are rejected. With `checkFingerprint`, the fingerprint must also match.
 */
export function parseEffectiveExecutionProfile(
  value: unknown,
  checkFingerprint: boolean,
): EffectiveExecutionProfile {
  const fail = (message: string): never => {
    throw new TypeError(`executionProfile ${message}`);
  };
  if (!isPlainObject(value)) fail("must be an object");
  const record = value as Record<string, unknown>;
  onlyKeys(
    record,
    [
      "schemaVersion",
      "fingerprint",
      "provider",
      "model",
      "tools",
      "extensions",
    ],
    fail,
    "",
  );
  if (record.schemaVersion !== EXECUTION_PROFILE_SCHEMA_VERSION)
    fail("schemaVersion is unsupported");
  if (
    typeof record.fingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(record.fingerprint)
  )
    fail("fingerprint is invalid");
  if (
    record.provider !== undefined &&
    (typeof record.provider !== "string" ||
      !PROVIDER_PATTERN.test(record.provider))
  )
    fail("provider is invalid");
  if (
    record.model !== undefined &&
    (typeof record.model !== "string" || !MODEL_PATTERN.test(record.model))
  )
    fail("model is invalid");
  if (
    !Array.isArray(record.extensions) ||
    record.extensions.length > MAX_PROFILE_EXTENSIONS
  )
    fail("extensions are invalid");
  const extensions = (record.extensions as unknown[]).map((entry) => {
    if (!isPlainObject(entry)) fail("extension is invalid");
    const item = entry as Record<string, unknown>;
    onlyKeys(item, ["id", "sha256"], fail, "extension");
    if (typeof item.id !== "string" || !EXTENSION_ID_PATTERN.test(item.id))
      fail("extension id is invalid");
    if (typeof item.sha256 !== "string" || !SHA256_PATTERN.test(item.sha256))
      fail("extension sha256 is invalid");
    return { id: item.id as string, sha256: item.sha256 as string };
  });
  for (let index = 1; index < extensions.length; index += 1) {
    if (!(extensions[index - 1]!.id < extensions[index]!.id))
      fail("extensions are not in canonical order");
  }
  const ids = new Set(extensions.map((extension) => extension.id));
  if (!Array.isArray(record.tools) || record.tools.length > MAX_PROFILE_TOOLS)
    fail("tools are invalid");
  const tools = (record.tools as unknown[]).map(
    (entry): ExecutionProfileTool => {
      if (!isPlainObject(entry)) fail("tool is invalid");
      const item = entry as Record<string, unknown>;
      if (typeof item.name !== "string" || !TOOL_NAME_PATTERN.test(item.name))
        fail("tool name is invalid");
      if (item.source === "builtin") {
        onlyKeys(item, ["source", "name"], fail, "tool");
        return { source: "builtin", name: item.name as string };
      }
      if (item.source === "extension") {
        onlyKeys(item, ["source", "extension", "name"], fail, "tool");
        if (typeof item.extension !== "string" || !ids.has(item.extension))
          fail("tool extension is undeclared");
        return {
          source: "extension",
          extension: item.extension as string,
          name: item.name as string,
        };
      }
      return fail("tool source is invalid");
    },
  );
  for (let index = 1; index < tools.length; index += 1) {
    if (!(tools[index - 1]!.name < tools[index]!.name))
      fail("tools are not in canonical order");
  }
  const profile: EffectiveExecutionProfile = {
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    fingerprint: record.fingerprint as string,
    ...(record.provider === undefined
      ? {}
      : { provider: record.provider as string }),
    ...(record.model === undefined ? {} : { model: record.model as string }),
    tools,
    extensions,
  };
  if (
    checkFingerprint &&
    executionProfileFingerprint(profile) !== profile.fingerprint
  )
    fail("fingerprint does not match its fields");
  return profile;
}
