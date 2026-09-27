import { DEFAULT_LIMITS } from "../contracts/limits.js";
import type { RuntimeLimits } from "../contracts/limits.js";

export function resolveLimits(
  partial: Partial<RuntimeLimits> = {},
): RuntimeLimits {
  const limits = { ...DEFAULT_LIMITS, ...partial };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  return limits;
}
