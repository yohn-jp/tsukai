import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Audited upstream provenance for the Pi RPC artifact that Tsukai certifies.
 * The version and upstream tag commit are the public SUPPORTED_PI_* values;
 * the values below identify the exact published npm artifact bytes.
 */
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_UPSTREAM_TAG = "v0.99.1";
/** npm registry `dist.integrity` of @earendil-works/pi-coding-agent@0.99.1. */
export const PI_TARBALL_INTEGRITY =
  "sha512-cWUrTOqA5M73cOYMgsh9PlhDrsBhavd+n5kVY6F7BGbGl1RjqCteVCoeVMVqhngoGACVDyw1tbLjajL8l9jrHg==";
/** sha256 over the sorted published file list and file digests; see artifactDigest. */
export const PI_ARTIFACT_FILES_DIGEST =
  "sha256:c118459afa0ac8fd2951eacd7367d773329d3a11230a77b61dc13bd578088b84";

const root = resolve(import.meta.dirname, "..");

function publishedFiles(packageRoot, directory = packageRoot) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Installed dependencies are not part of the published artifact.
      if (directory === packageRoot && entry.name === "node_modules") continue;
      files.push(...publishedFiles(packageRoot, path));
    } else if (entry.isFile()) {
      files.push(relative(packageRoot, path).split(sep).join("/"));
    } else {
      throw new Error(
        `Unexpected non-file entry in Pi artifact: ${entry.name}`,
      );
    }
  }
  return files;
}

/** Deterministic digest of every file the published tarball placed in packageRoot. */
export function artifactDigest(packageRoot) {
  const digest = createHash("sha256");
  for (const file of publishedFiles(packageRoot).sort()) {
    const content = createHash("sha256")
      .update(readFileSync(join(packageRoot, file)))
      .digest("hex");
    digest.update(`${file}\0${content}\n`);
  }
  return `sha256:${digest.digest("hex")}`;
}

function lockfileIntegrity(version) {
  const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const key = `'${PI_PACKAGE_NAME}@${version}':`;
  const start = lockfile.indexOf(`\n  ${key}\n`);
  if (start < 0) return undefined;
  const match = /resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/.exec(
    lockfile.slice(start, start + 512),
  );
  return match?.[1];
}

function findPackageRoot(executable) {
  let directory = dirname(executable);
  for (;;) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      if (manifest.name === PI_PACKAGE_NAME) return directory;
    } catch {
      // Continue towards the filesystem root.
    }
    const parent = dirname(directory);
    assert.notEqual(
      parent,
      directory,
      `Pi executable is not inside an installed ${PI_PACKAGE_NAME} package`,
    );
    directory = parent;
  }
}

/**
 * Resolves and verifies the exact published Pi npm artifact.
 *
 * Without TSUKAI_PI_EXECUTABLE the repository's exact devDependency is used and
 * its pnpm lockfile integrity must equal the audited registry integrity. An
 * explicit executable must be the `pi` bin of an installed package whose name,
 * version, and published file digest match the audited artifact. Both paths
 * then require `pi --version` to report the supported version.
 */
export function resolveCertifiedPi(version, executableOverride) {
  let packageRoot;
  let source;
  if (executableOverride) {
    assert(
      isAbsolute(executableOverride),
      "TSUKAI_PI_EXECUTABLE must be an absolute path",
    );
    packageRoot = findPackageRoot(realpathSync(executableOverride));
    source = "TSUKAI_PI_EXECUTABLE";
  } else {
    // The package's `exports` hide package.json; use the pnpm install link.
    packageRoot = realpathSync(join(root, "node_modules", PI_PACKAGE_NAME));
    source = "devDependency";
    assert.equal(
      lockfileIntegrity(version),
      PI_TARBALL_INTEGRITY,
      "pnpm lockfile does not pin the audited Pi tarball integrity",
    );
  }

  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, PI_PACKAGE_NAME, "Pi package name mismatch");
  assert.equal(
    manifest.version,
    version,
    "Installed Pi version is unsupported",
  );
  assert.equal(
    typeof manifest.bin?.pi,
    "string",
    "Pi package does not declare its pi bin",
  );
  const executable = join(packageRoot, manifest.bin.pi);
  assert(statSync(executable).isFile(), "Pi bin is missing");
  if (executableOverride) {
    assert.equal(
      realpathSync(executableOverride),
      realpathSync(executable),
      "TSUKAI_PI_EXECUTABLE must be the package's pi bin",
    );
  }
  const digest = artifactDigest(packageRoot);
  assert.equal(
    digest,
    PI_ARTIFACT_FILES_DIGEST,
    "Installed Pi files differ from the audited published artifact",
  );
  // Isolate Pi's configuration directory so the version probe never touches
  // the caller's home or auth state.
  const home = mkdtempSync(join(tmpdir(), "tsukai-pi-version-"));
  let reported;
  try {
    reported = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: join(home, "agent"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
    }).trim();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(reported, version, "Pi --version is unsupported");
  return {
    executable,
    provenance: {
      package: PI_PACKAGE_NAME,
      version,
      upstreamTag: PI_UPSTREAM_TAG,
      tarballIntegrity: PI_TARBALL_INTEGRITY,
      artifactDigest: digest,
      source,
    },
  };
}
