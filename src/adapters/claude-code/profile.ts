import type {
  AdmittedExecutionProfile,
  ExecutionProfileCapabilities,
} from "../../contracts/profile.js";

/**
 * Verified against the installed Claude Code 2.1.285 `--help`: `--model`
 * accepts an alias or full model name and `system/init` reports the resolved
 * model. There is no provider selector. Tool enablement is not configurable
 * through Tsukai: the fixed `--permission-mode dontAsk` launch has no verified
 * permission contract for enabled tools, so `--tools ""` stays fixed. Plugins
 * and hooks are skipped by `--bare` and are not admitted.
 */
export const CLAUDE_CODE_EXECUTION_PROFILE_CAPABILITIES: Readonly<ExecutionProfileCapabilities> =
  Object.freeze({
    schemaVersion: 1,
    provider: { tsukai: "unsupported", native: "absent", requiresModel: false },
    model: {
      tsukai: "configurable",
      native: "available",
      verification: "reported",
    },
    tools: { tsukai: "unsupported", native: "available", builtin: [] },
    extensions: { tsukai: "unsupported", native: "unverified" },
  } satisfies ExecutionProfileCapabilities) as Readonly<ExecutionProfileCapabilities>;

/** Deterministic Claude Code argv suffix; only the model selector is projected. */
export function projectClaudeCodeExecutionProfile(
  profile: AdmittedExecutionProfile | undefined,
): string[] {
  if (profile?.effective.model === undefined) return [];
  return ["--model", profile.effective.model];
}
