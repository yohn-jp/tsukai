import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
await rm(resolve(root, "dist"), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.build.json",
  ],
  {
    cwd: root,
    stdio: "inherit",
    timeout: 30000,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
