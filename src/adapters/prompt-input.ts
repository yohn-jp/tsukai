import type { RuntimeLimits } from "../contracts/limits.js";
import {
  FORBIDDEN_JSON_KEYS,
  isPrivateMetadataKey,
} from "../contracts/privacy.js";
import type { RunCreateInput } from "../contracts/types.js";

/**
 * Validates the harness-neutral part of a single-prompt AgentRun request.
 * Only a bounded prompt is accepted; it is delivered once and never persisted.
 */
export function validatePromptRunInput<Harness extends "pi" | "claude-code">(
  input: RunCreateInput<{ prompt: string }, Harness>,
  limits: RuntimeLimits,
  harness: Harness,
  label: string,
): RunCreateInput<{ prompt: string }, Harness> {
  if (!input || typeof input !== "object" || input.harness !== harness) {
    throw new TypeError(
      `${label} run input must select the ${harness} harness`,
    );
  }
  const request = input.request;
  if (
    !request ||
    typeof request !== "object" ||
    typeof request.prompt !== "string" ||
    request.prompt.length === 0 ||
    Buffer.byteLength(request.prompt, "utf8") > limits.maxRecordBytes - 128
  ) {
    throw new TypeError(`${label} prompt must be a bounded non-empty string`);
  }
  const metadata = input.metadata ?? {};
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).length > limits.maxMetadataEntries
  ) {
    throw new TypeError(
      `${label} run metadata is invalid or exceeds its limit`,
    );
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (
      key.length === 0 ||
      Buffer.byteLength(key, "utf8") > 128 ||
      FORBIDDEN_JSON_KEYS.has(key) ||
      isPrivateMetadataKey(key) ||
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > limits.maxMetadataValueBytes
    ) {
      throw new TypeError(
        `${label} run metadata contains an invalid or private value`,
      );
    }
  }
  const workspace = input.workspace;
  if (
    workspace !== undefined &&
    (!workspace ||
      typeof workspace.cwd !== "string" ||
      workspace.cwd.length === 0 ||
      (workspace.workspaceSessionId !== undefined &&
        (typeof workspace.workspaceSessionId !== "string" ||
          workspace.workspaceSessionId.length === 0 ||
          Buffer.byteLength(workspace.workspaceSessionId, "utf8") > 256)))
  ) {
    throw new TypeError(`${label} workspace configuration is invalid`);
  }
  if (
    input.parentRunId !== undefined &&
    (typeof input.parentRunId !== "string" || input.parentRunId.length === 0)
  ) {
    throw new TypeError("parentRunId must be a non-empty string");
  }
  if (
    input.spawnedBy !== undefined &&
    (typeof input.spawnedBy !== "string" ||
      input.spawnedBy !== input.parentRunId)
  ) {
    throw new TypeError("spawnedBy must equal parentRunId");
  }
  return {
    harness,
    request: { prompt: request.prompt },
    metadata: { ...metadata },
    ...(workspace === undefined ? {} : { workspace: { ...workspace } }),
    ...(input.parentRunId === undefined
      ? {}
      : { parentRunId: input.parentRunId }),
    ...(input.spawnedBy === undefined ? {} : { spawnedBy: input.spawnedBy }),
  };
}
