import type { HarnessNativeAvailability } from "./harness.js";
import type { HarnessName } from "./types.js";

/** Version of the execution-profile schema accepted by `runs.create`. */
export const EXECUTION_PROFILE_SCHEMA_VERSION = 1 as const;

/** A tool built into the harness itself, named by the harness's own tool name. */
export interface ExecutionProfileBuiltinTool {
  source: "builtin";
  name: string;
}

/** A tool registered by one admitted extension of the same profile. */
export interface ExecutionProfileExtensionTool {
  source: "extension";
  /** `id` of the declared extension that registers this tool. */
  extension: string;
  name: string;
}

export type ExecutionProfileTool =
  ExecutionProfileBuiltinTool | ExecutionProfileExtensionTool;

/**
 * One admitted harness extension (for example a governance guard). It is
 * code the caller admits, identified by content: Tsukai verifies the file's
 * SHA-256 before anything starts. The path is a locator, never a filesystem
 * grant, and is not persisted.
 */
export interface ExecutionProfileExtension {
  /** Caller-chosen stable identifier; extensions load in ascending `id` order. */
  id: string;
  /** Absolute, normalized path of a regular (non-symlink) file. */
  path: string;
  /** Lowercase hex SHA-256 of the file content. */
  sha256: string;
}

/**
 * Caller-admitted, immutable harness execution configuration for one
 * AgentRun. The caller (orchestrator) decides the policy; Tsukai validates it
 * against the selected adapter's capabilities, binds it to the run, and
 * projects it into the harness-native invocation. There is no argv,
 * environment, or workspace field: those stay outside this contract.
 *
 * Omitting a profile keeps default deny: no tools and no extensions.
 */
export interface ExecutionProfile {
  schemaVersion: typeof EXECUTION_PROFILE_SCHEMA_VERSION;
  provider?: string;
  model?: string;
  /** Admitted tool allowlist. Absent or empty admits no tools. */
  tools?: readonly ExecutionProfileTool[];
  extensions?: readonly ExecutionProfileExtension[];
}

/**
 * The safe, normalized form bound to a run, persisted, journaled, and
 * returned in snapshots. Extension paths are omitted; the extension content
 * digest is its identity. `fingerprint` covers every other field.
 */
export interface EffectiveExecutionProfile {
  schemaVersion: typeof EXECUTION_PROFILE_SCHEMA_VERSION;
  /** `sha256:<hex>` over the canonical form of the fields below. */
  fingerprint: string;
  provider?: string;
  model?: string;
  /** Sorted by `name`. */
  tools: ExecutionProfileTool[];
  /** Sorted by `id` (the harness load order). */
  extensions: { id: string; sha256: string }[];
}

/**
 * A validated profile ready for projection: the effective form plus the
 * extension locators, in load order. Never persisted.
 */
export interface AdmittedExecutionProfile {
  effective: EffectiveExecutionProfile;
  extensions: readonly ExecutionProfileExtension[];
}

/** How Tsukai handles one execution-profile dimension for an adapter. */
export type ExecutionProfileSupport = "configurable" | "unsupported";

export interface ExecutionProfileDimension {
  /** What Tsukai can safely configure for this adapter. */
  tsukai: ExecutionProfileSupport;
  /** Whether the harness itself offers the mechanism (verified authority). */
  native: HarnessNativeAvailability;
}

/**
 * Machine-readable execution-profile configurability of one adapter. It
 * describes what Tsukai validates and projects, not every native feature.
 */
export interface ExecutionProfileCapabilities {
  schemaVersion: typeof EXECUTION_PROFILE_SCHEMA_VERSION;
  provider: ExecutionProfileDimension & {
    /** The harness applies a provider selector only together with a model. */
    requiresModel: boolean;
  };
  model: ExecutionProfileDimension & {
    /**
     * `exact`: the run fails before its prompt unless the harness reports the
     * requested model exactly. `reported`: the selector is passed through
     * (aliases allowed) and the harness-reported model is recorded.
     * `none`: model selection is unsupported.
     */
    verification: "exact" | "reported" | "none";
  };
  tools: ExecutionProfileDimension & {
    /** Built-in tool names Tsukai admits for this harness. */
    builtin: readonly string[];
  };
  /** Extension tools additionally require `extensions` to be configurable. */
  extensions: ExecutionProfileDimension;
}

export type ExecutionProfileErrorCode =
  "EXECUTION_PROFILE_INVALID" | "EXECUTION_PROFILE_UNSUPPORTED";

/**
 * Stable typed failure raised before any execution starts: the profile is
 * malformed (`EXECUTION_PROFILE_INVALID`) or asks for a dimension the
 * selected adapter does not configure (`EXECUTION_PROFILE_UNSUPPORTED`).
 */
export class ExecutionProfileError extends Error {
  constructor(
    readonly code: ExecutionProfileErrorCode,
    readonly harness: HarnessName,
    readonly dimension: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionProfileError";
  }
}
