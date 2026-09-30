import { lstatSync, type Stats } from "node:fs";
import { OwnerError } from "./protocol.js";

export function assertPosix(): void {
  if (process.platform === "win32") {
    throw new OwnerError(
      "OWNER_UNAVAILABLE",
      "The resident owner requires a POSIX Unix-domain socket; Windows named pipes are not supported",
    );
  }
}

function currentUid(): number {
  return process.getuid?.() ?? -1;
}

/** A state directory reachable only by the current user. */
export function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new OwnerError(
      "OWNER_UNAVAILABLE",
      "Owner state path is not a directory",
    );
  }
  assertOwnedPrivate(stat, "Owner state directory");
}

export function assertOwnedPrivate(stat: Stats, label: string): void {
  if (stat.uid !== currentUid()) {
    throw new OwnerError(
      "OWNER_UNAVAILABLE",
      `${label} is not owned by the current user`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new OwnerError(
      "OWNER_UNAVAILABLE",
      `${label} is accessible to group or others`,
    );
  }
}
