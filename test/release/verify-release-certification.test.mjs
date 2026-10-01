import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyReleaseCertification } from "../../scripts/verify-release-certification.mjs";

const SHA = "a".repeat(40);
const VERSION = "1.2.3";
let temp;

function makeFixture({ tarVersion = VERSION, note } = {}) {
  const root = join(temp, "root");
  mkdirSync(join(root, "docs", "releases"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "tsukai",
      version: VERSION,
      scripts: { "certify:pi": "x", "certify:owner": "x", build: "x" },
    }),
  );
  writeFileSync(
    join(root, "docs", "releases", `${VERSION}.md`),
    note ??
      [
        "# Tsukai",
        "",
        "## Certification",
        "",
        "| Lane | Status |",
        "| --- | --- |",
        "| `certify:pi` | PASSED |",
        "| `certify:owner` | ENVIRONMENT_BLOCKED |",
        "",
        "## Other",
      ].join("\n"),
  );
  const pack = join(temp, "pack");
  mkdirSync(join(pack, "package"), { recursive: true });
  writeFileSync(
    join(pack, "package", "package.json"),
    JSON.stringify({ name: "tsukai", version: tarVersion }),
  );
  const tarball = join(temp, "tsukai.tgz");
  const tar = spawnSync("tar", ["-czf", tarball, "-C", pack, "package"]);
  expect(tar.status).toBe(0);
  const sha256 = createHash("sha256")
    .update(readFileSync(tarball))
    .digest("hex");
  return {
    root,
    env: {
      RELEASE_SOURCE_SHA: SHA,
      RELEASE_TAG: `v${VERSION}`,
      RELEASE_ARTIFACT_PATH: tarball,
      RELEASE_ARTIFACT_SHA256: sha256,
      GITHUB_REPOSITORY: "yohn-jp/tsukai",
      GITHUB_TOKEN: "token",
    },
  };
}

function ciResponse(runs, status = 200) {
  return async () =>
    new Response(JSON.stringify({ workflow_runs: runs }), { status });
}

const green = [
  {
    id: 1,
    head_sha: SHA,
    conclusion: "success",
    created_at: "2026-01-01T00:00:00Z",
  },
];

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "tsukai-cert-"));
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

describe("verify-release-certification", () => {
  it("passes when tarball, note, and CI agree", async () => {
    const { root, env } = makeFixture();
    await expect(
      verifyReleaseCertification({ env, root, fetchImpl: ciResponse(green) }),
    ).resolves.toEqual({
      version: VERSION,
      lanes: { "certify:pi": "PASSED", "certify:owner": "ENVIRONMENT_BLOCKED" },
      ciRunId: 1,
    });
  });

  it("rejects a tarball whose digest differs from the pack", async () => {
    const { root, env } = makeFixture();
    env.RELEASE_ARTIFACT_SHA256 = "b".repeat(64);
    await expect(
      verifyReleaseCertification({ env, root, fetchImpl: ciResponse(green) }),
    ).rejects.toMatchObject({ code: "ARTIFACT_DIGEST" });
  });

  it("rejects a tarball version that differs from the tag", async () => {
    const { root, env } = makeFixture({ tarVersion: "1.2.2" });
    await expect(
      verifyReleaseCertification({ env, root, fetchImpl: ciResponse(green) }),
    ).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
  });

  it("rejects a repository other than yohn-jp/tsukai", async () => {
    const { root, env } = makeFixture();
    env.GITHUB_REPOSITORY = "other/repo";
    await expect(
      verifyReleaseCertification({ env, root, fetchImpl: ciResponse(green) }),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
  });

  it("rejects a release note missing a certify lane", async () => {
    const { root, env } = makeFixture({
      note: "## Certification\n\n| `certify:pi` | PASSED |\n",
    });
    await expect(
      verifyReleaseCertification({ env, root, fetchImpl: ciResponse(green) }),
    ).rejects.toMatchObject({ code: "NOTE_INCOMPLETE" });
  });

  it("rejects a lane recorded with an unknown status", async () => {
    const { root, env } = makeFixture({
      note: "## Certification\n\n| `certify:pi` | PASSED |\n| `certify:owner` | FAILED |\n",
    });
    await expect(
      verifyReleaseCertification({ env, root, fetchImpl: ciResponse(green) }),
    ).rejects.toMatchObject({ code: "NOTE_INCOMPLETE" });
  });

  it("rejects when the latest CI run for the source is not green", async () => {
    const { root, env } = makeFixture();
    const runs = [
      ...green,
      {
        id: 2,
        head_sha: SHA,
        conclusion: "failure",
        created_at: "2026-01-02T00:00:00Z",
      },
    ];
    await expect(
      verifyReleaseCertification({ env, root, fetchImpl: ciResponse(runs) }),
    ).rejects.toMatchObject({ code: "CI_NOT_GREEN" });
  });

  it("rejects when no CI run exists for the source", async () => {
    const { root, env } = makeFixture();
    await expect(
      verifyReleaseCertification({ env, root, fetchImpl: ciResponse([]) }),
    ).rejects.toMatchObject({ code: "CI_MISSING" });
  });

  it("fails closed on a CI lookup error", async () => {
    const { root, env } = makeFixture();
    await expect(
      verifyReleaseCertification({ env, root, fetchImpl: ciResponse([], 403) }),
    ).rejects.toMatchObject({ code: "CI_LOOKUP" });
  });
});
