#!/usr/bin/env node
// Release certification gate for the shared yohn-jp npm publish workflow.
// Consumer-owned: it fails closed unless the exact release tarball, the
// release commit's CI, and the release note's certification record agree.
// It never modifies the tarball. ENVIRONMENT_BLOCKED lanes must be recorded
// explicitly; they are reported, never treated as passed.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "yohn-jp/tsukai";
const PACKAGE_NAME = "tsukai";
const CI_WORKFLOW_FILE = "ci.yml";
const LANE_STATUSES = ["PASSED", "ENVIRONMENT_BLOCKED"];
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export class ReleaseCertificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseCertificationError";
    this.code = code;
  }
}

function fail(code, message) {
  return new ReleaseCertificationError(code, message);
}

function requireEnv(env, key) {
  const value = env[key];
  if (typeof value !== "string" || value === "") {
    throw fail("CONTEXT_MISSING", `${key} is required`);
  }
  return value;
}

export function parseContext(env) {
  const sourceSha = requireEnv(env, "RELEASE_SOURCE_SHA");
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw fail("CONTEXT_INVALID", "RELEASE_SOURCE_SHA must be a full SHA-1");
  }
  const tag = requireEnv(env, "RELEASE_TAG");
  const tagMatch = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!tagMatch) {
    throw fail("CONTEXT_INVALID", "RELEASE_TAG must be v<semver>");
  }
  const digest = requireEnv(env, "RELEASE_ARTIFACT_SHA256").replace(
    /^sha256:/,
    "",
  );
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw fail(
      "CONTEXT_INVALID",
      "RELEASE_ARTIFACT_SHA256 must be hex SHA-256",
    );
  }
  const repository = requireEnv(env, "GITHUB_REPOSITORY");
  if (repository !== REPOSITORY) {
    throw fail("CONTEXT_INVALID", `GITHUB_REPOSITORY must be ${REPOSITORY}`);
  }
  return {
    sourceSha,
    tag,
    version: tagMatch[1],
    artifactPath: requireEnv(env, "RELEASE_ARTIFACT_PATH"),
    artifactSha256: digest,
    repository,
    token: requireEnv(env, "GITHUB_TOKEN"),
    apiBase: env.GITHUB_API_URL ?? "https://api.github.com",
  };
}

function readPackageJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw fail("PACKAGE_INVALID", `cannot read ${path}: ${error.message}`);
  }
}

export function verifyTarball(context, root) {
  if (!existsSync(context.artifactPath)) {
    throw fail("ARTIFACT_MISSING", "release artifact not found");
  }
  const actual = createHash("sha256")
    .update(readFileSync(context.artifactPath))
    .digest("hex");
  if (actual !== context.artifactSha256) {
    throw fail("ARTIFACT_DIGEST", "release artifact digest differs from pack");
  }
  const extracted = spawnSync(
    "tar",
    ["-xOf", context.artifactPath, "package/package.json"],
    { encoding: "utf8", maxBuffer: MAX_PACKAGE_JSON_BYTES },
  );
  if (extracted.error || extracted.status !== 0) {
    throw fail("ARTIFACT_INVALID", "tarball has no readable package.json");
  }
  const packed = JSON.parse(extracted.stdout);
  if (packed.name !== PACKAGE_NAME) {
    throw fail("ARTIFACT_INVALID", `tarball package name is ${packed.name}`);
  }
  if (packed.version !== context.version) {
    throw fail(
      "VERSION_MISMATCH",
      `tarball version ${packed.version} differs from tag ${context.tag}`,
    );
  }
  const source = readPackageJson(resolve(root, "package.json"));
  if (source.version !== context.version) {
    throw fail(
      "VERSION_MISMATCH",
      `package.json version ${source.version} differs from tag ${context.tag}`,
    );
  }
  return source;
}

export function verifyReleaseNote(context, root, sourcePackage) {
  const lanes = Object.keys(sourcePackage.scripts ?? {}).filter((name) =>
    name.startsWith("certify:"),
  );
  const notePath = resolve(root, "docs", "releases", `${context.version}.md`);
  if (!existsSync(notePath)) {
    throw fail("NOTE_MISSING", `docs/releases/${context.version}.md not found`);
  }
  const note = readFileSync(notePath, "utf8");
  const heading = /^## Certification\s*$/m.exec(note);
  if (!heading) {
    throw fail("NOTE_INVALID", "release note has no '## Certification'");
  }
  const rest = note.slice(heading.index + heading[0].length);
  const next = /^## /m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  const results = {};
  for (const lane of lanes) {
    const row = new RegExp(
      `^\\|\\s*\`${lane}\`\\s*\\|\\s*(${LANE_STATUSES.join("|")})\\s*\\|`,
      "m",
    ).exec(section);
    if (!row) {
      throw fail(
        "NOTE_INCOMPLETE",
        `release note lacks a ${LANE_STATUSES.join("/")} row for ${lane}`,
      );
    }
    results[lane] = row[1];
  }
  return results;
}

async function readBounded(response) {
  const reader = response.body?.getReader();
  if (!reader) throw fail("CI_LOOKUP", "empty CI lookup response");
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_API_RESPONSE_BYTES) {
      await reader.cancel();
      throw fail("CI_LOOKUP", "CI lookup response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function verifyCi(context, fetchImpl = fetch) {
  const url =
    `${context.apiBase}/repos/${context.repository}/actions/workflows/` +
    `${CI_WORKFLOW_FILE}/runs?head_sha=${context.sourceSha}` +
    `&status=completed&per_page=100`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${context.token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw fail("CI_LOOKUP", `CI lookup failed: ${error.message}`);
  }
  if (!response.ok) {
    throw fail("CI_LOOKUP", `CI lookup returned HTTP ${response.status}`);
  }
  let payload;
  try {
    payload = JSON.parse(await readBounded(response));
  } catch (error) {
    if (error instanceof ReleaseCertificationError) throw error;
    throw fail("CI_LOOKUP", "CI lookup response is not JSON");
  }
  const runs = Array.isArray(payload?.workflow_runs)
    ? payload.workflow_runs.filter((run) => run?.head_sha === context.sourceSha)
    : [];
  if (runs.length === 0) {
    throw fail("CI_MISSING", `no completed ${CI_WORKFLOW_FILE} run for source`);
  }
  runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const latest = runs[0];
  if (latest.conclusion !== "success") {
    throw fail(
      "CI_NOT_GREEN",
      `latest ${CI_WORKFLOW_FILE} run ${latest.id} concluded ${latest.conclusion}`,
    );
  }
  return latest.id;
}

export async function verifyReleaseCertification({
  env = process.env,
  root = resolve(fileURLToPath(import.meta.url), "..", ".."),
  fetchImpl = fetch,
} = {}) {
  const context = parseContext(env);
  const sourcePackage = verifyTarball(context, root);
  const lanes = verifyReleaseNote(context, root, sourcePackage);
  const ciRunId = await verifyCi(context, fetchImpl);
  return { version: context.version, lanes, ciRunId };
}

async function main() {
  try {
    const result = await verifyReleaseCertification();
    for (const [lane, status] of Object.entries(result.lanes)) {
      if (status !== "PASSED") {
        console.warn(`::warning::${lane} recorded as ${status}, not passed`);
      }
    }
    console.log(
      `release certification verified for ${PACKAGE_NAME}@${result.version} ` +
        `(CI run ${result.ciRunId})`,
    );
  } catch (error) {
    const code =
      error instanceof ReleaseCertificationError ? error.code : "ERROR";
    console.error(`::error::[${code}] ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
