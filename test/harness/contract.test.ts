import {
  CLAUDE_CODE_PROFILE,
  defineHarnessContract,
  PI_PROFILE,
} from "./contract.js";

// The same cross-harness contract runs against every harness adapter, all
// sharing one RunService (createHarnessRuntime) over a Jinushi-shaped port.
defineHarnessContract(PI_PROFILE);
defineHarnessContract(CLAUDE_CODE_PROFILE);
