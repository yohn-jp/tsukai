import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, normalize } from "node:path";
import type { HarnessCapabilities } from "../contracts/harness.js";
import {
  EXECUTION_PROFILE_SCHEMA_VERSION,
  ExecutionProfileError,
  type AdmittedExecutionProfile,
  type EffectiveExecutionProfile,
  type ExecutionProfileCapabilities,
  type ExecutionProfileExtension,
  type ExecutionProfileTool,
} from "../contracts/profile.js";
import type { HarnessName } from "../contracts/types.js";
import {
  executionProfileFingerprint,
  EXTENSION_ID_PATTERN,
  isPlainObject,
  MAX_PROFILE_EXTENSIONS,
  MAX_PROFILE_TOOLS,
  MODEL_PATTERN,
  onlyKeys,
  PROVIDER_PATTERN,
  SHA256_PATTERN,
  TOOL_NAME_PATTERN,
} from "../domain/execution-profile.js";

export const MAX_EXTENSION_FILE_BYTES = 4 * 1024 * 1024;

/** Every dimension unsupported: adapters over a port that cannot project a profile. */
export const UNSUPPORTED_EXECUTION_PROFILE: Readonly<ExecutionProfileCapabilities> =
  Object.freeze({
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    provider: {
      tsukai: "unsupported",
      native: "unverified",
      requiresModel: false,
    },
    model: {
      tsukai: "unsupported",
      native: "unverified",
      verification: "none",
    },
    tools: { tsukai: "unsupported", native: "unverified", builtin: [] },
    extensions: { tsukai: "unsupported", native: "unverified" },
  } satisfies ExecutionProfileCapabilities) as Readonly<ExecutionProfileCapabilities>;

/**
 * Capabilities as advertised for a concrete execution port: a port that does
 * not declare profile projection cannot realize any configured dimension.
 */
export function capabilitiesForPort(
  capabilities: Readonly<HarnessCapabilities>,
  port: { readonly executionProfile?: "projected" },
): Readonly<HarnessCapabilities> {
  if (port.executionProfile === "projected") return capabilities;
  return Object.freeze({
    ...capabilities,
    executionProfile: {
      ...UNSUPPORTED_EXECUTION_PROFILE,
      provider: {
        ...UNSUPPORTED_EXECUTION_PROFILE.provider,
        native: capabilities.executionProfile.provider.native,
      },
      model: {
        ...UNSUPPORTED_EXECUTION_PROFILE.model,
        native: capabilities.executionProfile.model.native,
      },
      tools: {
        ...UNSUPPORTED_EXECUTION_PROFILE.tools,
        native: capabilities.executionProfile.tools.native,
      },
      extensions: {
        ...UNSUPPORTED_EXECUTION_PROFILE.extensions,
        native: capabilities.executionProfile.extensions.native,
      },
    },
  });
}

/**
 * Reads an extension file and checks it is the admitted content: an absolute,
 * normalized, non-symlink regular file whose SHA-256 equals the declaration.
 */
export function verifyExtensionFile(
  harness: HarnessName,
  extension: ExecutionProfileExtension,
): void {
  const fail = (message: string): never => {
    throw new ExecutionProfileError(
      "EXECUTION_PROFILE_INVALID",
      harness,
      "extensions",
      `Extension ${extension.id}: ${message}`,
    );
  };
  let fd: number | undefined;
  try {
    const link = lstatSync(extension.path);
    if (!link.isFile()) fail("path must be a regular, non-symlink file");
    if (realpathSync(extension.path) !== extension.path)
      fail("path must be canonical (no symlinked directories)");
    fd = openSync(extension.path, "r");
    const stat = fstatSync(fd);
    if (stat.ino !== link.ino || stat.dev !== link.dev)
      fail("file changed during verification");
    if (stat.size > MAX_EXTENSION_FILE_BYTES) fail("file exceeds 4 MiB");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(65_536);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_EXTENSION_FILE_BYTES) fail("file exceeds 4 MiB");
      hash.update(buffer.subarray(0, read));
    }
    if (hash.digest("hex") !== extension.sha256)
      fail("content does not match the admitted sha256");
  } catch (error) {
    if (error instanceof ExecutionProfileError) throw error;
    fail("file cannot be read");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Validates a caller-supplied execution profile against one adapter's
 * advertised configurability and returns its admitted form. Malformed input
 * is `EXECUTION_PROFILE_INVALID`; a dimension the adapter does not configure
 * is `EXECUTION_PROFILE_UNSUPPORTED`. Nothing starts before this succeeds.
 */
export function admitExecutionProfile(
  value: unknown,
  harness: HarnessName,
  capabilities: ExecutionProfileCapabilities | undefined,
): AdmittedExecutionProfile {
  const invalid = (dimension: string, message: string): never => {
    throw new ExecutionProfileError(
      "EXECUTION_PROFILE_INVALID",
      harness,
      dimension,
      message,
    );
  };
  const unsupported = (dimension: string): never => {
    throw new ExecutionProfileError(
      "EXECUTION_PROFILE_UNSUPPORTED",
      harness,
      dimension,
      `Harness ${harness} does not support execution-profile ${dimension} through Tsukai`,
    );
  };
  if (capabilities === undefined) unsupported("executionProfile");
  const caps = capabilities as ExecutionProfileCapabilities;
  if (!isPlainObject(value))
    invalid("profile", "Execution profile must be an object");
  const profile = value as Record<string, unknown>;
  onlyKeys(
    profile,
    ["schemaVersion", "provider", "model", "tools", "extensions"],
    (message) => invalid("profile", message),
    "Execution profile",
  );
  if (profile.schemaVersion !== EXECUTION_PROFILE_SCHEMA_VERSION) {
    invalid("schemaVersion", "Execution profile schemaVersion must be 1");
  }

  let provider: string | undefined;
  if (profile.provider !== undefined) {
    if (
      typeof profile.provider !== "string" ||
      !PROVIDER_PATTERN.test(profile.provider)
    )
      invalid("provider", "provider must be a bounded provider identifier");
    if (caps.provider.tsukai !== "configurable") unsupported("provider");
    provider = profile.provider as string;
  }
  let model: string | undefined;
  if (profile.model !== undefined) {
    if (typeof profile.model !== "string" || !MODEL_PATTERN.test(profile.model))
      invalid("model", "model must be a bounded model identifier");
    if (caps.model.tsukai !== "configurable") unsupported("model");
    model = profile.model as string;
  }
  if (
    provider !== undefined &&
    caps.provider.requiresModel &&
    model === undefined
  ) {
    invalid(
      "provider",
      `Harness ${harness} applies provider only together with model`,
    );
  }

  const extensions: ExecutionProfileExtension[] = [];
  const ids = new Set<string>();
  if (profile.extensions !== undefined) {
    if (
      !Array.isArray(profile.extensions) ||
      profile.extensions.length > MAX_PROFILE_EXTENSIONS
    )
      invalid(
        "extensions",
        `extensions must be an array of at most ${MAX_PROFILE_EXTENSIONS}`,
      );
    const entries = profile.extensions as unknown[];
    if (entries.length > 0 && caps.extensions.tsukai !== "configurable")
      unsupported("extensions");
    const paths = new Set<string>();
    const digests = new Set<string>();
    for (const entry of entries) {
      if (!isPlainObject(entry))
        invalid("extensions", "extension must be an object");
      const record = entry as Record<string, unknown>;
      onlyKeys(
        record,
        ["id", "path", "sha256"],
        (message) => invalid("extensions", message),
        "Extension",
      );
      const { id, path, sha256 } = record;
      if (typeof id !== "string" || !EXTENSION_ID_PATTERN.test(id))
        invalid("extensions", "extension id must be a lowercase identifier");
      if (
        typeof path !== "string" ||
        path.length === 0 ||
        Buffer.byteLength(path, "utf8") > 4096 ||
        !isAbsolute(path) ||
        normalize(path) !== path ||
        path.endsWith("/") ||
        /[\u0000-\u001f\u007f]/u.test(path)
      )
        invalid(
          "extensions",
          "extension path must be an absolute normalized file path",
        );
      if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256))
        invalid(
          "extensions",
          "extension sha256 must be 64 lowercase hex digits",
        );
      if (ids.has(id as string))
        invalid("extensions", `duplicate extension id: ${String(id)}`);
      if (paths.has(path as string))
        invalid("extensions", "duplicate extension path");
      if (digests.has(sha256 as string))
        invalid("extensions", "duplicate extension content");
      ids.add(id as string);
      paths.add(path as string);
      digests.add(sha256 as string);
      extensions.push({
        id: id as string,
        path: path as string,
        sha256: sha256 as string,
      });
    }
  }
  extensions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const tools: ExecutionProfileTool[] = [];
  if (profile.tools !== undefined) {
    if (
      !Array.isArray(profile.tools) ||
      profile.tools.length > MAX_PROFILE_TOOLS
    )
      invalid(
        "tools",
        `tools must be an array of at most ${MAX_PROFILE_TOOLS}`,
      );
    const entries = profile.tools as unknown[];
    if (entries.length > 0 && caps.tools.tsukai !== "configurable")
      unsupported("tools");
    const builtin = new Set(caps.tools.builtin);
    const names = new Set<string>();
    for (const entry of entries) {
      if (!isPlainObject(entry)) invalid("tools", "tool must be an object");
      const record = entry as Record<string, unknown>;
      const name = record.name;
      if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name))
        invalid("tools", "tool name must be a bounded identifier");
      if (names.has(name as string))
        invalid("tools", `duplicate tool: ${String(name)}`);
      names.add(name as string);
      if (record.source === "builtin") {
        onlyKeys(
          record,
          ["source", "name"],
          (message) => invalid("tools", message),
          "Tool",
        );
        if (!builtin.has(name as string))
          invalid(
            "tools",
            `Harness ${harness} has no admitted built-in tool ${String(name)}`,
          );
        tools.push({ source: "builtin", name: name as string });
      } else if (record.source === "extension") {
        onlyKeys(
          record,
          ["source", "extension", "name"],
          (message) => invalid("tools", message),
          "Tool",
        );
        if (caps.extensions.tsukai !== "configurable")
          unsupported("extensions");
        if (typeof record.extension !== "string" || !ids.has(record.extension))
          invalid(
            "tools",
            `tool ${String(name)} must name a declared extension`,
          );
        if (builtin.has(name as string))
          invalid(
            "tools",
            `extension tool ${String(name)} shadows a built-in tool name`,
          );
        tools.push({
          source: "extension",
          extension: record.extension as string,
          name: name as string,
        });
      } else {
        invalid("tools", "tool source must be builtin or extension");
      }
    }
  }
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const extension of extensions) verifyExtensionFile(harness, extension);

  const base = {
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    tools,
    extensions: extensions.map((extension) => ({
      id: extension.id,
      sha256: extension.sha256,
    })),
  };
  return {
    effective: { ...base, fingerprint: executionProfileFingerprint(base) },
    extensions: Object.freeze(
      extensions.map((extension) => Object.freeze({ ...extension })),
    ),
  };
}
