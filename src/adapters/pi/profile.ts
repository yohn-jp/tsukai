import type {
  AdmittedExecutionProfile,
  ExecutionProfileCapabilities,
} from "../../contracts/profile.js";

/**
 * Pi 0.99.1 built-in tools Tsukai admits (`allToolNames` of the published
 * artifact; `powershell` is Windows-only and Jinushi runs on POSIX).
 */
export const PI_BUILTIN_TOOLS = Object.freeze([
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "write",
] as const);

/**
 * Verified against the published Pi 0.99.1 CLI (`dist/cli/args.js`,
 * `dist/main.js`, `dist/core/sdk.js`, `dist/core/resource-loader.js`):
 * `--provider` is applied only together with `--model`; `--tools` is an exact
 * allowlist over built-in and extension tools that overrides `--no-tools`;
 * explicit `--extension <path>` files load despite `--no-extensions`, and a
 * load failure or unresolved model exits before RPC starts.
 */
export const PI_EXECUTION_PROFILE_CAPABILITIES: Readonly<ExecutionProfileCapabilities> =
  Object.freeze({
    schemaVersion: 1,
    provider: {
      tsukai: "configurable",
      native: "available",
      requiresModel: true,
    },
    model: {
      tsukai: "configurable",
      native: "available",
      verification: "exact",
    },
    tools: {
      tsukai: "configurable",
      native: "available",
      builtin: PI_BUILTIN_TOOLS,
    },
    extensions: { tsukai: "configurable", native: "available" },
  } satisfies ExecutionProfileCapabilities) as Readonly<ExecutionProfileCapabilities>;

/**
 * Deterministic Pi argv suffix for an admitted profile. It is appended to the
 * fixed default-deny arguments (`--no-tools --no-extensions ...`), so an
 * absent or empty profile adds nothing.
 */
export function projectPiExecutionProfile(
  profile: AdmittedExecutionProfile | undefined,
): string[] {
  if (profile === undefined) return [];
  const { effective } = profile;
  const args: string[] = [];
  if (effective.provider !== undefined)
    args.push("--provider", effective.provider);
  if (effective.model !== undefined) args.push("--model", effective.model);
  if (effective.tools.length > 0)
    args.push("--tools", effective.tools.map((tool) => tool.name).join(","));
  for (const extension of profile.extensions)
    args.push("--extension", extension.path);
  return args;
}

/**
 * The model Pi reports in `get_state` must be the requested one: exact
 * provider (case-insensitive, as Pi canonicalizes providers) and exact model
 * id, optionally written as `provider/id`. Pi's fuzzy or `:thinking` pattern
 * resolution therefore fails closed instead of silently selecting another
 * model.
 */
export function piModelMatches(
  requested: { provider?: string; model?: string },
  reported: unknown,
): boolean {
  if (requested.model === undefined) return true;
  if (!reported || typeof reported !== "object") return false;
  const { provider, id } = reported as { provider?: unknown; id?: unknown };
  if (typeof provider !== "string" || typeof id !== "string") return false;
  if (
    requested.provider !== undefined &&
    requested.provider.toLowerCase() !== provider.toLowerCase()
  )
    return false;
  const wanted = requested.model.toLowerCase();
  return (
    wanted === id.toLowerCase() || wanted === `${provider}/${id}`.toLowerCase()
  );
}
