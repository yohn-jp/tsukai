import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_EXECUTION_PROFILE_CAPABILITIES,
  collectLiveProjection,
  connectAgent,
  connectOwner,
  createClaudeCodeHarnessAdapter,
  createHarnessRuntime,
  createJinushiClaudeCodeExecutionPort,
  createJinushiPiExecutionPort,
  createPiHarnessAdapter,
  createPiRuntime,
  executionProfileFingerprint,
  ExecutionProfileError,
  OwnerError,
  PI_EXECUTION_PROFILE_CAPABILITIES,
  projectReplay,
  renderOperatorProjection,
  startResidentOwner,
  SUPPORTED_CLAUDE_CODE_VERSION,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
  type ExecutionProfile,
  type HarnessAdapter,
  type HarnessName,
  type HarnessRuntime,
  type PiDuplexExecutionPort,
  type RunCreateInput,
} from "../../src/index.js";
import { createMockRuntime } from "../../src/testing/index.js";
import { createFileDurableStore } from "../../src/durable/file-store.js";
import {
  FakeSupervisor,
  type FakeClientView,
} from "../durable/fake-supervisor.js";
import { tempDir, until, WORKSPACE } from "../durable/harness.js";

/** The fixed default-deny Pi RPC argv (M1b–M5), unchanged by #25. */
const PI_DEFAULT_ARGV = [
  "/opt/pi/bin/pi",
  "--mode",
  "rpc",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-approve",
  "--no-tools",
];
/** The fixed Claude Code argv (M5), unchanged by #25. */
const CLAUDE_DEFAULT_ARGV = [
  "/opt/claude-code/bin/claude",
  "-p",
  "--bare",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--permission-mode",
  "dontAsk",
  "--tools",
  "",
];

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Env {
  dir: string;
  sup: FakeSupervisor;
  guard: { path: string; sha256: string };
  context: { path: string; sha256: string };
}

function writeExtension(dir: string, name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, body);
  return {
    path,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function setup(): Env {
  const temp = tempDir();
  cleanups.push(temp.cleanup);
  const dir = realpathSync(temp.dir);
  mkdirSync(join(dir, "ext"));
  return {
    dir,
    sup: new FakeSupervisor(),
    guard: writeExtension(
      join(dir, "ext"),
      "guard.ts",
      "export default () => {};\n",
    ),
    context: writeExtension(
      join(dir, "ext"),
      "context.ts",
      "export default () => { /* registers governed_execution */ };\n",
    ),
  };
}

function piPort(view: FakeClientView) {
  return createJinushiPiExecutionPort({
    client: view,
    executable: "/opt/pi/bin/pi",
    environment: { mode: "replace", set: { PATH: "/usr/bin" } },
  });
}

function start(
  env: Env,
  options: { piPort?: PiDuplexExecutionPort; claude?: boolean } = {},
): { runtime: HarnessRuntime; view: FakeClientView; kill(): void } {
  const view = env.sup.view();
  const store = createFileDurableStore({
    dir: join(env.dir, "store"),
    fsync: false,
  });
  const adapters: HarnessAdapter<unknown, HarnessName>[] = [
    createPiHarnessAdapter({
      execution: options.piPort ?? piPort(view),
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
      commandTimeoutMs: 2_000,
    }) as HarnessAdapter<unknown, HarnessName>,
  ];
  if (options.claude !== false) {
    adapters.push(
      createClaudeCodeHarnessAdapter({
        execution: createJinushiClaudeCodeExecutionPort({
          client: view,
          executable: "/opt/claude-code/bin/claude",
          environment: { mode: "replace", set: { PATH: "/usr/bin" } },
        }),
        claudeCodeVersion: SUPPORTED_CLAUDE_CODE_VERSION,
        commandTimeoutMs: 2_000,
      }) as HarnessAdapter<unknown, HarnessName>,
    );
  }
  const runtime = createHarnessRuntime({ adapters, durableStore: store });
  let dead = false;
  const kill = (): void => {
    if (dead) return;
    dead = true;
    view.kill();
    store.close();
  };
  cleanups.push(async () => {
    if (!dead) await runtime.detach();
  });
  return { runtime, view, kill };
}

function codingProfile(env: Env): ExecutionProfile {
  return {
    schemaVersion: 1,
    provider: "acme",
    model: "coder-1",
    tools: [
      { source: "builtin", name: "write" },
      { source: "extension", extension: "context", name: "governed_execution" },
      { source: "builtin", name: "read" },
      { source: "builtin", name: "bash" },
      { source: "builtin", name: "edit" },
    ],
    extensions: [
      { id: "guard", path: env.guard.path, sha256: env.guard.sha256 },
      { id: "context", path: env.context.path, sha256: env.context.sha256 },
    ],
  };
}

async function rejects(
  promise: Promise<unknown>,
  code: "EXECUTION_PROFILE_INVALID" | "EXECUTION_PROFILE_UNSUPPORTED",
  dimension?: string,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ExecutionProfileError);
  expect((error as ExecutionProfileError).code).toBe(code);
  if (dimension !== undefined)
    expect((error as ExecutionProfileError).dimension).toBe(dimension);
}

/** Malformed profiles are deliberately passed through the typed surface. */
const piInput = (profile?: unknown): RunCreateInput<unknown, HarnessName> => ({
  harness: "pi",
  request: { prompt: "private prompt text" },
  workspace: WORKSPACE,
  ...(profile === undefined
    ? {}
    : { executionProfile: profile as ExecutionProfile }),
});

describe("execution profile: default deny and compatibility", () => {
  it("keeps the exact M5 Pi argv and no profile when none is supplied", async () => {
    const env = setup();
    const { runtime } = start(env);
    const run = await runtime.runs.create(piInput());
    const done = await runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
    expect(done.outcome).toBe("completed");
    expect(done.executionProfile).toBeUndefined();
    expect(env.sup.specs).toHaveLength(1);
    expect(env.sup.specs[0]!.argv).toEqual(PI_DEFAULT_ARGV);
    expect(env.sup.specs[0]!.argv).not.toContain("--tools");
    expect(env.sup.specs[0]!.argv).not.toContain("--extension");
  });

  it("keeps the exact M5 Claude Code argv when none is supplied", async () => {
    const env = setup();
    const { runtime } = start(env);
    const run = await runtime.runs.create({
      harness: "claude-code",
      request: { prompt: "private prompt text" },
      workspace: WORKSPACE,
    });
    const done = await runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
    expect(done.outcome).toBe("completed");
    expect(done.executionProfile).toBeUndefined();
    expect(env.sup.specs[0]!.argv).toEqual(CLAUDE_DEFAULT_ARGV);
  });

  it("an empty profile is still default deny (no tools, no extensions)", async () => {
    const env = setup();
    const { runtime } = start(env);
    const run = await runtime.runs.create(piInput({ schemaVersion: 1 }));
    await runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
    expect(env.sup.specs[0]!.argv).toEqual(PI_DEFAULT_ARGV);
    expect(run.executionProfile).toEqual({
      schemaVersion: 1,
      fingerprint: executionProfileFingerprint({
        schemaVersion: 1,
        tools: [],
        extensions: [],
      }),
      tools: [],
      extensions: [],
    });
  });
});

describe("execution profile: Pi projection", () => {
  it("accepts a coding profile and projects provider, model, tools, and extensions", async () => {
    const env = setup();
    env.sup.piModel = { provider: "acme", id: "coder-1" };
    const { runtime } = start(env);
    const run = await runtime.runs.create(piInput(codingProfile(env)));
    const done = await runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
    expect(done.outcome).toBe("completed");
    expect(env.sup.specs[0]!.argv).toEqual([
      ...PI_DEFAULT_ARGV,
      "--provider",
      "acme",
      "--model",
      "coder-1",
      "--tools",
      "bash,edit,governed_execution,read,write",
      // Extensions load in ascending id order.
      "--extension",
      env.context.path,
      "--extension",
      env.guard.path,
    ]);
    expect(done.executionProfile).toEqual({
      schemaVersion: 1,
      fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      provider: "acme",
      model: "coder-1",
      tools: [
        { source: "builtin", name: "bash" },
        { source: "builtin", name: "edit" },
        {
          source: "extension",
          extension: "context",
          name: "governed_execution",
        },
        { source: "builtin", name: "read" },
        { source: "builtin", name: "write" },
      ],
      extensions: [
        { id: "context", sha256: env.context.sha256 },
        { id: "guard", sha256: env.guard.sha256 },
      ],
    });
    const profileEvent = runtime.runs
      .eventsPage(run.agentRunId, 0, 100)
      .items.find((event) => event.kind === "harness.profile");
    expect(profileEvent?.payload).toMatchObject({
      fingerprint: done.executionProfile!.fingerprint,
      modelVerified: "exact",
      reportedProvider: "acme",
      reportedModel: "coder-1",
    });
  });

  it("projects model alone, and tools alone, deterministically", async () => {
    const env = setup();
    env.sup.piModel = { provider: "acme", id: "coder-1" };
    const { runtime } = start(env);
    const a = await runtime.runs.create(
      piInput({ schemaVersion: 1, model: "acme/coder-1" }),
    );
    await runtime.runs.wait(a.agentRunId, { timeoutMs: 2_000 });
    const b = await runtime.runs.create(
      piInput({
        schemaVersion: 1,
        tools: [{ source: "builtin", name: "read" }],
      }),
    );
    await runtime.runs.wait(b.agentRunId, { timeoutMs: 2_000 });
    expect(env.sup.specs[0]!.argv.slice(PI_DEFAULT_ARGV.length)).toEqual([
      "--model",
      "acme/coder-1",
    ]);
    expect(env.sup.specs[1]!.argv.slice(PI_DEFAULT_ARGV.length)).toEqual([
      "--tools",
      "read",
    ]);
  });

  it("fails before the prompt when Pi resolves a different model", async () => {
    const env = setup();
    env.sup.piModel = { provider: "acme", id: "coder-1-preview" };
    const { runtime } = start(env);
    const run = await runtime.runs.create(
      piInput({ schemaVersion: 1, provider: "acme", model: "coder-1" }),
    );
    const done = await runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
    expect(done.outcome).toBe("failed");
    expect(done.reason).toBe("pi-model-mismatch");
    expect(env.sup.prompts).toBe(0);
  });
});

describe("execution profile: validation before execution", () => {
  const malformed: [string, (env: Env) => unknown, string][] = [
    ["non-object", () => "tools=bash", "profile"],
    ["missing schemaVersion", () => ({ model: "m" }), "schemaVersion"],
    ["future schemaVersion", () => ({ schemaVersion: 2 }), "schemaVersion"],
    [
      "raw argv",
      () => ({ schemaVersion: 1, argv: ["--mode", "json"] }),
      "profile",
    ],
    ["raw args", () => ({ schemaVersion: 1, args: ["-e", "/x"] }), "profile"],
    [
      "environment",
      () => ({ schemaVersion: 1, env: { PI_X: "1" } }),
      "profile",
    ],
    ["cwd override", () => ({ schemaVersion: 1, cwd: "/" }), "profile"],
    [
      "workspace override",
      () => ({ schemaVersion: 1, workspace: { cwd: "/" } }),
      "profile",
    ],
    [
      "option-like provider",
      () => ({ schemaVersion: 1, provider: "--no-tools", model: "m" }),
      "provider",
    ],
    ["option-like model", () => ({ schemaVersion: 1, model: "-e" }), "model"],
    [
      "file-arg model",
      () => ({ schemaVersion: 1, model: "@/etc/passwd" }),
      "model",
    ],
    [
      "model with whitespace",
      () => ({ schemaVersion: 1, model: "m --tools bash" }),
      "model",
    ],
    [
      "provider without model",
      () => ({ schemaVersion: 1, provider: "acme" }),
      "provider",
    ],
    [
      "comma tool list",
      () => ({
        schemaVersion: 1,
        tools: [{ source: "builtin", name: "read,bash" }],
      }),
      "tools",
    ],
    ["string tool", () => ({ schemaVersion: 1, tools: ["read"] }), "tools"],
    [
      "unknown builtin",
      () => ({
        schemaVersion: 1,
        tools: [{ source: "builtin", name: "powershell" }],
      }),
      "tools",
    ],
    [
      "duplicate tool",
      () => ({
        schemaVersion: 1,
        tools: [
          { source: "builtin", name: "read" },
          { source: "builtin", name: "read" },
        ],
      }),
      "tools",
    ],
    [
      "tool from undeclared extension",
      () => ({
        schemaVersion: 1,
        tools: [{ source: "extension", extension: "ghost", name: "x" }],
      }),
      "tools",
    ],
    [
      "extension tool shadowing builtin",
      (env) => ({
        schemaVersion: 1,
        tools: [{ source: "extension", extension: "guard", name: "bash" }],
        extensions: [{ id: "guard", ...env.guard }],
      }),
      "tools",
    ],
    [
      "relative extension path",
      (env) => ({
        schemaVersion: 1,
        extensions: [
          { id: "guard", path: "ext/guard.ts", sha256: env.guard.sha256 },
        ],
      }),
      "extensions",
    ],
    [
      "non-normalized extension path",
      (env) => ({
        schemaVersion: 1,
        extensions: [
          {
            id: "guard",
            path: `${env.dir}/ext/../ext/guard.ts`,
            sha256: env.guard.sha256,
          },
        ],
      }),
      "extensions",
    ],
    [
      "package source extension",
      (env) => ({
        schemaVersion: 1,
        extensions: [
          { id: "guard", path: "npm:evil", sha256: env.guard.sha256 },
        ],
      }),
      "extensions",
    ],
    [
      "extension with extra field",
      (env) => ({
        schemaVersion: 1,
        extensions: [{ id: "guard", ...env.guard, args: ["x"] }],
      }),
      "extensions",
    ],
    [
      "bad digest format",
      (env) => ({
        schemaVersion: 1,
        extensions: [{ id: "guard", path: env.guard.path, sha256: "ABC" }],
      }),
      "extensions",
    ],
    [
      "digest mismatch",
      (env) => ({
        schemaVersion: 1,
        extensions: [
          { id: "guard", path: env.guard.path, sha256: env.context.sha256 },
        ],
      }),
      "extensions",
    ],
    [
      "duplicate extension id",
      (env) => ({
        schemaVersion: 1,
        extensions: [
          { id: "guard", ...env.guard },
          { id: "guard", ...env.context },
        ],
      }),
      "extensions",
    ],
    [
      "duplicate extension content",
      (env) => ({
        schemaVersion: 1,
        extensions: [
          { id: "a", ...env.guard },
          { id: "b", ...env.guard, path: env.guard.path },
        ],
      }),
      "extensions",
    ],
    [
      "missing extension file",
      (env) => ({
        schemaVersion: 1,
        extensions: [
          {
            id: "guard",
            path: join(env.dir, "ext", "missing.ts"),
            sha256: env.guard.sha256,
          },
        ],
      }),
      "extensions",
    ],
  ];
  for (const [name, build, dimension] of malformed) {
    it(`rejects ${name} as EXECUTION_PROFILE_INVALID without contacting Jinushi`, async () => {
      const env = setup();
      const { runtime } = start(env);
      await rejects(
        runtime.runs.create(piInput(build(env))),
        "EXECUTION_PROFILE_INVALID",
        dimension,
      );
      expect(env.sup.runCalls).toBe(0);
      expect(runtime.runs.list().items).toHaveLength(0);
    });
  }

  it("rejects a symlinked extension file", async () => {
    const env = setup();
    const link = join(env.dir, "ext", "link.ts");
    symlinkSync(env.guard.path, link);
    const { runtime } = start(env);
    await rejects(
      runtime.runs.create(
        piInput({
          schemaVersion: 1,
          extensions: [{ id: "guard", path: link, sha256: env.guard.sha256 }],
        }),
      ),
      "EXECUTION_PROFILE_INVALID",
      "extensions",
    );
    expect(env.sup.runCalls).toBe(0);
  });

  it("re-verifies extension content immediately before Jinushi submission", async () => {
    const env = setup();
    const view = env.sup.view();
    const inner = piPort(view);
    // Swap the file between admission and submission.
    const port: PiDuplexExecutionPort = {
      executionProfile: "projected",
      open(agentRunId, observer, workspace, profile) {
        writeFileSync(env.guard.path, "export default () => { evil(); };\n");
        return inner.open(agentRunId, observer, workspace, profile);
      },
      dispose: () => inner.dispose(),
    };
    const { runtime } = start(env, { piPort: port });
    // Admission passed, so the start was requested; the port refuses before
    // submitting anything and the existing M2 rule makes the run uncertain.
    const run = await runtime.runs.create(
      piInput({
        schemaVersion: 1,
        extensions: [{ id: "guard", ...env.guard }],
      }),
    );
    expect(run.lifecycle).toBe("uncertain");
    expect(run.reason).toBe("execution-start-outcome-uncertain");
    expect(env.sup.runCalls).toBe(0);
    expect(env.sup.prompts).toBe(0);
  });

  it("rejects dimensions Claude Code does not configure, before execution", async () => {
    const env = setup();
    const { runtime } = start(env);
    const claude = (
      profile: unknown,
    ): RunCreateInput<unknown, HarnessName> => ({
      harness: "claude-code",
      request: { prompt: "p" },
      workspace: WORKSPACE,
      executionProfile: profile as ExecutionProfile,
    });
    await rejects(
      runtime.runs.create(
        claude({ schemaVersion: 1, provider: "anthropic", model: "m" }),
      ),
      "EXECUTION_PROFILE_UNSUPPORTED",
      "provider",
    );
    await rejects(
      runtime.runs.create(
        claude({
          schemaVersion: 1,
          tools: [{ source: "builtin", name: "Read" }],
        }),
      ),
      "EXECUTION_PROFILE_UNSUPPORTED",
      "tools",
    );
    await rejects(
      runtime.runs.create(
        claude({
          schemaVersion: 1,
          extensions: [{ id: "guard", ...env.guard }],
        }),
      ),
      "EXECUTION_PROFILE_UNSUPPORTED",
      "extensions",
    );
    expect(env.sup.runCalls).toBe(0);
  });

  it("projects a Claude Code model selector and records the reported model", async () => {
    const env = setup();
    const { runtime } = start(env);
    const run = await runtime.runs.create({
      harness: "claude-code",
      request: { prompt: "p" },
      workspace: WORKSPACE,
      executionProfile: { schemaVersion: 1, model: "sonnet" },
    });
    const done = await runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
    expect(done.outcome).toBe("completed");
    expect(env.sup.specs[0]!.argv).toEqual([
      ...CLAUDE_DEFAULT_ARGV,
      "--model",
      "sonnet",
    ]);
    expect(done.executionProfile?.model).toBe("sonnet");
  });

  it("rejects a profile on the mock runtime and on a port that cannot project it", async () => {
    const mock = createMockRuntime();
    cleanups.push(() => mock.dispose());
    await expect(
      mock.runs.create({
        harness: "mock",
        request: { scenario: "normal" },
        executionProfile: { schemaVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_PROFILE_UNSUPPORTED" });

    const env = setup();
    const inner = piPort(env.sup.view());
    const legacyPort: PiDuplexExecutionPort = {
      open: (agentRunId, observer, workspace) =>
        inner.open(agentRunId, observer, workspace),
      dispose: () => inner.dispose(),
    };
    const { runtime } = start(env, { piPort: legacyPort, claude: false });
    expect(runtime.harnesses()[0]!.executionProfile.tools.tsukai).toBe(
      "unsupported",
    );
    await rejects(
      runtime.runs.create(
        piInput({
          schemaVersion: 1,
          tools: [{ source: "builtin", name: "read" }],
        }),
      ),
      "EXECUTION_PROFILE_UNSUPPORTED",
      "tools",
    );
    expect(env.sup.runCalls).toBe(0);
  });
});

describe("execution profile: identity and immutability", () => {
  it("normalizes equivalent profiles to one effective form and fingerprint", async () => {
    const env = setup();
    env.sup.piModel = { provider: "acme", id: "coder-1" };
    const { runtime } = start(env);
    const profile = codingProfile(env);
    const permuted: ExecutionProfile = {
      extensions: [...profile.extensions!].reverse(),
      tools: [...profile.tools!].reverse(),
      model: profile.model!,
      provider: profile.provider!,
      schemaVersion: 1,
    };
    const a = await runtime.runs.create(piInput(profile));
    const b = await runtime.runs.create(piInput(permuted));
    await runtime.runs.wait(a.agentRunId, { timeoutMs: 2_000 });
    await runtime.runs.wait(b.agentRunId, { timeoutMs: 2_000 });
    expect(b.executionProfile).toEqual(a.executionProfile);
    expect(env.sup.specs[1]!.argv).toEqual(env.sup.specs[0]!.argv);
    expect(executionProfileFingerprint(a.executionProfile!)).toBe(
      a.executionProfile!.fingerprint,
    );
    // Any semantic change changes the identity.
    const other = await runtime.runs.create(
      piInput({ ...profile, tools: profile.tools!.slice(1) }),
    );
    expect(other.executionProfile!.fingerprint).not.toBe(
      a.executionProfile!.fingerprint,
    );
  });

  it("has a stable, content-addressed fingerprint", () => {
    const fingerprint = executionProfileFingerprint({
      schemaVersion: 1,
      provider: "acme",
      model: "coder-1",
      tools: [
        { source: "builtin", name: "read" },
        { source: "extension", extension: "guard", name: "governed_execution" },
      ],
      extensions: [{ id: "guard", sha256: "0".repeat(64) }],
    });
    const canonical = JSON.stringify([
      1,
      "acme",
      "coder-1",
      [
        ["builtin", "read"],
        ["extension", "guard", "governed_execution"],
      ],
      [["guard", "0".repeat(64)]],
    ]);
    expect(fingerprint).toBe(
      `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    );
  });

  it("binds the profile at creation: snapshots are copies and later file edits change nothing", async () => {
    const env = setup();
    env.sup.piModel = { provider: "acme", id: "coder-1" };
    env.sup.holdTranscript = true;
    const { runtime } = start(env);
    const run = await runtime.runs.create(piInput(codingProfile(env)));
    const before = structuredClone(run.executionProfile);
    run.executionProfile!.tools.length = 0;
    (run.executionProfile as { model?: string }).model = "other";
    writeFileSync(env.guard.path, "export default () => { changed(); };\n");
    const current = runtime.runs.get(run.agentRunId);
    expect(current.executionProfile).toEqual(before);
    expect(env.sup.runCalls).toBe(1);
  });
});

describe("execution profile: durability and recovery", () => {
  it("preserves the same profile across owner restart without relaunch or prompt resend", async () => {
    const env = setup();
    env.sup.piModel = { provider: "acme", id: "coder-1" };
    env.sup.holdTranscript = true;
    const first = start(env);
    const run = await first.runtime.runs.create(piInput(codingProfile(env)));
    await until(() => env.sup.prompts === 1);
    first.kill();

    const second = start(env);
    await second.runtime.reconcile();
    const restored = second.runtime.runs.get(run.agentRunId);
    expect(restored.executionProfile).toEqual(run.executionProfile);
    expect(restored.lifecycle).toBe("running");
    expect(env.sup.runCalls).toBe(1);
    expect(env.sup.prompts).toBe(1);

    env.sup.emitTranscript(env.sup.only());
    const done = await second.runtime.runs.wait(run.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done.outcome).toBe("completed");
    expect(done.executionProfile).toEqual(run.executionProfile);
    expect(env.sup.runCalls).toBe(1);
  });

  it("marks a drifted persisted profile uncertain instead of re-attaching", async () => {
    const env = setup();
    env.sup.piModel = { provider: "acme", id: "coder-1" };
    env.sup.holdTranscript = true;
    const first = start(env);
    const run = await first.runtime.runs.create(piInput(codingProfile(env)));
    await until(() => env.sup.prompts === 1);
    first.kill();

    // Rewrite the durable record to another model, keeping the old fingerprint.
    const runsDir = join(env.dir, "store", "runs");
    const file = join(
      runsDir,
      readdirSync(runsDir).find((name) => name.startsWith(run.agentRunId))!,
    );
    const state = JSON.parse(readFileSync(file, "utf8")) as {
      snapshot: { executionProfile: { model: string } };
    };
    state.snapshot.executionProfile.model = "other-model";
    writeFileSync(file, JSON.stringify(state));

    const second = start(env);
    await second.runtime.reconcile();
    const restored = second.runtime.runs.get(run.agentRunId);
    expect(restored.lifecycle).toBe("uncertain");
    expect(restored.recovery?.reason).toBe("execution-profile-drift");
    expect(env.sup.runCalls).toBe(1);
    expect(env.sup.prompts).toBe(1);
  });

  it("never re-attaches a profiled run through an adapter that can no longer realize it", async () => {
    const env = setup();
    env.sup.piModel = { provider: "acme", id: "coder-1" };
    env.sup.holdTranscript = true;
    const first = start(env);
    const run = await first.runtime.runs.create(piInput(codingProfile(env)));
    await until(() => env.sup.prompts === 1);
    first.kill();

    const view = env.sup.view();
    const inner = piPort(view);
    const legacyPort: PiDuplexExecutionPort = {
      open: (agentRunId, observer, workspace) =>
        inner.open(agentRunId, observer, workspace),
      attach: (...args) => inner.attach!(...args),
      dispose: () => inner.dispose(),
    };
    const second = start(env, { piPort: legacyPort });
    await second.runtime.reconcile();
    const restored = second.runtime.runs.get(run.agentRunId);
    expect(restored.lifecycle).toBe("uncertain");
    expect(restored.recovery?.reason).toBe("execution-profile-unsupported");
    expect(restored.executionProfile).toEqual(run.executionProfile);
    expect(env.sup.runCalls).toBe(1);
    expect(env.sup.prompts).toBe(1);
  });
});

describe("execution profile: workspace and privacy boundaries", () => {
  it("never changes the admitted workspace scope", async () => {
    const env = setup();
    env.sup.piModel = { provider: "acme", id: "coder-1" };
    const { runtime } = start(env);
    const workspace = {
      cwd: "/tmp/tsukai-ws",
      workspaceSessionId: "nawabari-1",
    };
    const run = await runtime.runs.create({
      ...piInput(codingProfile(env)),
      workspace,
    });
    await runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
    expect(env.sup.specs[0]!.cwd).toBe(workspace.cwd);
    expect(run.workspace).toEqual(workspace);
    // The extension locator is code, not a filesystem root or a cwd.
    expect(env.sup.specs[0]!.cwd).not.toBe(join(env.dir, "ext"));
  });

  it("refuses an execution profile from a scoped agent (no widening via agent_spawn)", async () => {
    const env = setup();
    env.sup.holdTranscript = true;
    const stateDir = join(env.dir, "owner");
    const owner = await startResidentOwner({
      stateDir,
      fsync: false,
      reconcileIntervalMs: 0,
      createService: (store) =>
        createPiRuntime({
          execution: piPort(env.sup.view()),
          piVersion: SUPPORTED_PI_VERSION,
          piRevision: SUPPORTED_PI_REVISION,
          durableStore: store,
          commandTimeoutMs: 2_000,
        }),
    });
    cleanups.push(() => owner.close("detach"));
    const op = await connectOwner({ stateDir });
    cleanups.push(() => op.close());
    const parent = await op.runs.create(piInput());
    const { token } = await op.grantAgentControl(parent.agentRunId);
    const agent = await connectAgent({ stateDir, agentToken: token });
    cleanups.push(() => agent.close());
    const error = await agent
      .agent_spawn({
        harness: "pi",
        request: { prompt: "child" },
        executionProfile: {
          schemaVersion: 1,
          tools: [{ source: "builtin", name: "bash" }],
        },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OwnerError);
    expect((error as OwnerError).code).toBe("FORBIDDEN");
    expect(env.sup.runCalls).toBe(1);

    // Over operator IPC, profile errors keep their stable codes.
    const invalid = await op.runs
      .create(piInput({ schemaVersion: 1, argv: ["x"] }))
      .catch((caught: unknown) => caught);
    expect((invalid as OwnerError).code).toBe("EXECUTION_PROFILE_INVALID");
    expect((invalid as OwnerError).message).not.toContain(env.dir);
    const profiled = await op.runs.create(
      piInput({
        schemaVersion: 1,
        tools: [{ source: "builtin", name: "read" }],
      }),
    );
    expect(
      (await op.runs.get(profiled.agentRunId)).executionProfile?.tools,
    ).toEqual([{ source: "builtin", name: "read" }]);
  });

  it("journals only safe profile metadata", async () => {
    const env = setup();
    env.sup.piModel = { provider: "acme", id: "coder-1" };
    const { runtime } = start(env);
    const run = await runtime.runs.create(piInput(codingProfile(env)));
    await runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
    const exported = runtime.journal.export(run.agentRunId);
    expect(exported).toContain(run.executionProfile!.fingerprint);
    expect(exported).not.toContain(env.guard.path);
    expect(exported).not.toContain(env.dir);
    expect(exported).not.toContain("private prompt text");
    expect(exported).not.toContain("private answer");
    const stateDir = join(env.dir, "store", "runs");
    for (const name of readdirSync(stateDir)) {
      const text = readFileSync(join(stateDir, name), "utf8");
      expect(text).not.toContain(env.guard.path);
      expect(text).not.toContain("private prompt text");
    }
  });
});

describe("execution profile: operator observation", () => {
  it("projects the same safe profile live and from replay, and rejects tampered replay", async () => {
    const env = setup();
    env.sup.piModel = { provider: "acme", id: "coder-1" };
    const { runtime } = start(env);
    const run = await runtime.runs.create(piInput(codingProfile(env)));
    await runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
    const live = await collectLiveProjection({
      list: async (options) => runtime.runs.list(options),
      eventsPage: async (id, after, limit) =>
        runtime.runs.eventsPage(id, after, limit),
    });
    const exported = runtime.journal.export(run.agentRunId);
    const replay = projectReplay(exported);
    expect(replay).toEqual(live);
    expect(replay.fleet[0]!.executionProfile).toEqual(run.executionProfile);
    const text = renderOperatorProjection(replay);
    expect(text).toContain(`profile=${run.executionProfile!.fingerprint}`);
    expect(text).toContain("tools=bash,edit,governed_execution,read,write");
    expect(text).not.toContain(env.guard.path);

    const tampered = exported.replaceAll(
      '"model":"coder-1"',
      '"model":"coder-2"',
    );
    expect(tampered).not.toBe(exported);
    expect(() => projectReplay(tampered)).toThrow(/fingerprint/);
  });
});

describe("execution profile: capabilities", () => {
  it("advertises configurable dimensions per adapter", () => {
    const env = setup();
    const { runtime } = start(env);
    const [pi, claude] = runtime.harnesses();
    expect(pi!.executionProfile).toEqual(PI_EXECUTION_PROFILE_CAPABILITIES);
    expect(pi!.executionProfile).toMatchObject({
      provider: { tsukai: "configurable", requiresModel: true },
      model: { tsukai: "configurable", verification: "exact" },
      tools: {
        tsukai: "configurable",
        builtin: ["bash", "edit", "find", "grep", "ls", "read", "write"],
      },
      extensions: { tsukai: "configurable", native: "available" },
    });
    expect(claude!.executionProfile).toEqual(
      CLAUDE_CODE_EXECUTION_PROFILE_CAPABILITIES,
    );
    expect(claude!.executionProfile).toMatchObject({
      provider: { tsukai: "unsupported", native: "absent" },
      model: { tsukai: "configurable", verification: "reported" },
      tools: { tsukai: "unsupported", builtin: [] },
      extensions: { tsukai: "unsupported" },
    });
  });
});
