import { createRunService } from "../application/index.js";
import type { DurableStore } from "../contracts/durable.js";
import type {
  HarnessAdapter,
  HarnessCapabilities,
} from "../contracts/harness.js";
import { DEFAULT_LIMITS, type RuntimeLimits } from "../contracts/limits.js";
import type { JournalPort } from "../contracts/ports.js";
import type { RunService } from "../contracts/service.js";
import type { HarnessName } from "../contracts/types.js";
import { createMemoryJournal } from "../observation/journal.js";

export interface HarnessRuntimeOptions {
  /** One adapter per harness; a run stays bound to its adapter for life. */
  adapters: readonly HarnessAdapter<unknown, HarnessName>[];
  journal?: JournalPort;
  durableStore?: DurableStore;
  limits?: Partial<RuntimeLimits>;
}

export interface HarnessRuntime extends RunService<unknown, HarnessName> {
  journal: JournalPort;
  /** Capabilities of every registered harness adapter. */
  harnesses(): HarnessCapabilities[];
}

/**
 * One canonical RunService over several harness adapters. Harness
 * differences stay behind each adapter; lifecycle, durability, controls, and
 * observation are shared.
 */
export function createHarnessRuntime(
  options: HarnessRuntimeOptions,
): HarnessRuntime {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (
    options.durableStore !== undefined &&
    options.journal !== undefined &&
    options.journal !== options.durableStore
  ) {
    throw new TypeError("durableStore is also the journal; do not pass both");
  }
  const journal =
    options.durableStore ?? options.journal ?? createMemoryJournal(limits);
  const service = createRunService<unknown, HarnessName>({
    adapters: options.adapters,
    journal,
    ...(options.durableStore === undefined
      ? {}
      : { durableStore: options.durableStore }),
    limits,
  });
  const capabilities = options.adapters.map((adapter) =>
    structuredClone(adapter.capabilities),
  );
  return {
    runs: service.runs,
    reconcile: () => service.reconcile(),
    detach: () => service.detach(),
    dispose: () => service.dispose(),
    journal,
    harnesses: () => capabilities.map((entry) => structuredClone(entry)),
  };
}
