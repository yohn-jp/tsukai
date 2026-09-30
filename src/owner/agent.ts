/**
 * Agent-facing control surface (M3): scoped projections over the canonical
 * RunService. This module holds no lifecycle state. Its only durable data is
 * the per-principal credential (hash only); the spawn relationship lives in the
 * AgentRun record itself (`spawnedBy`), written atomically with the child's
 * identity.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  RunCreateInput,
  RunResult,
  RunSnapshot,
  WaitOptions,
} from "../contracts/types.js";
import { RunNotFoundError } from "../contracts/types.js";
import type { OwnerService } from "./server.js";
import { OwnerError } from "./protocol.js";

export const AGENT_OPERATIONS = [
  "agent_spawn",
  "agent_status",
  "agent_wait",
  "agent_result",
  "agent_cancel",
] as const;
export type AgentOperation = (typeof AGENT_OPERATIONS)[number];

const AGENT_TOKEN_PREFIX = "tsk_agent_";
const MAX_GRANTS = 4096;
const GRANTS_FILE = "grants.json";

interface Grant {
  principalRunId: string;
  /** SHA-256 of the bearer secret. The secret itself is never stored. */
  tokenHash: string;
  issuedAt: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function forbidden(): OwnerError {
  // Unknown and unauthorized are indistinguishable: no run-existence oracle.
  return new OwnerError(
    "FORBIDDEN",
    "AgentRun is not accessible to this principal",
  );
}

/** Durable per-principal credentials; one active credential per AgentRun. */
export interface AgentGrantStore {
  issue(principalRunId: string): { token: string; issuedAt: string };
  revoke(principalRunId: string): boolean;
  /** Resolves a presented bearer token to its principal, if still current. */
  authenticate(
    token: string,
  ): { principalRunId: string; hash: string } | undefined;
  isCurrent(principalRunId: string, hash: string): boolean;
  /** Set when an unreadable grants file was preserved and grants were reset. */
  readonly corrupt: string | undefined;
}

export function openAgentGrantStore(
  dir: string,
  isActive: (principalRunId: string) => boolean,
): AgentGrantStore {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, GRANTS_FILE);
  const byPrincipal = new Map<string, Grant>();
  let corrupt: string | undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const list = (parsed as { grants?: unknown } | null)?.grants;
    if (!Array.isArray(list)) throw new Error("grants must be an array");
    for (const entry of list as Record<string, unknown>[]) {
      if (
        typeof entry.principalRunId !== "string" ||
        typeof entry.tokenHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.tokenHash) ||
        typeof entry.issuedAt !== "string"
      ) {
        throw new Error("grant entry is invalid");
      }
      byPrincipal.set(entry.principalRunId, {
        principalRunId: entry.principalRunId,
        tokenHash: entry.tokenHash,
        issuedAt: entry.issuedAt,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Fail closed: keep the evidence, start with no credentials.
      try {
        renameSync(path, `${path}.corrupt-${Date.now()}`);
      } catch {
        /* keep going with an empty in-memory set */
      }
      byPrincipal.clear();
      corrupt = "agent-grants-unreadable";
    }
  }

  const persist = (): void => {
    const tmp = `${path}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ version: 1, grants: [...byPrincipal.values()] }),
      { mode: 0o600 },
    );
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  };

  return {
    issue(principalRunId) {
      for (const [id] of byPrincipal) {
        if (!isActive(id)) byPrincipal.delete(id);
      }
      if (!byPrincipal.has(principalRunId) && byPrincipal.size >= MAX_GRANTS) {
        throw new OwnerError("OWNER_BUSY", "Too many active agent credentials");
      }
      const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
      const grant: Grant = {
        principalRunId,
        tokenHash: hashToken(token),
        issuedAt: new Date().toISOString(),
      };
      const previous = byPrincipal.get(principalRunId);
      byPrincipal.set(principalRunId, grant);
      try {
        persist();
      } catch (error) {
        if (previous === undefined) byPrincipal.delete(principalRunId);
        else byPrincipal.set(principalRunId, previous);
        throw error;
      }
      return { token, issuedAt: grant.issuedAt };
    },
    revoke(principalRunId) {
      const previous = byPrincipal.get(principalRunId);
      if (previous === undefined) return false;
      byPrincipal.delete(principalRunId);
      try {
        persist();
      } catch (error) {
        byPrincipal.set(principalRunId, previous);
        throw error;
      }
      return true;
    },
    authenticate(token) {
      if (!token.startsWith(AGENT_TOKEN_PREFIX)) return undefined;
      const hash = hashToken(token);
      for (const grant of byPrincipal.values()) {
        if (grant.tokenHash === hash) {
          return { principalRunId: grant.principalRunId, hash };
        }
      }
      return undefined;
    },
    isCurrent(principalRunId, hash) {
      return byPrincipal.get(principalRunId)?.tokenHash === hash;
    },
    corrupt,
  };
}

function sameWorkspace(
  a: RunSnapshot["workspace"],
  b: RunSnapshot["workspace"],
): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.cwd === b.cwd &&
    a.workspaceSessionId === b.workspaceSessionId
  );
}

export interface AgentPrincipal {
  principalRunId: string;
  hash: string;
}

export interface AgentSurface {
  spawn(
    principal: AgentPrincipal,
    request: Record<string, unknown>,
  ): Promise<RunSnapshot>;
  status(principal: AgentPrincipal, agentRunId: string): RunSnapshot;
  wait(
    principal: AgentPrincipal,
    agentRunId: string,
    options: WaitOptions,
  ): Promise<RunSnapshot>;
  result(principal: AgentPrincipal, agentRunId: string): RunResult;
  cancel(principal: AgentPrincipal, agentRunId: string): Promise<RunSnapshot>;
}

export function createAgentSurface(
  service: OwnerService,
  grants: AgentGrantStore,
): AgentSurface {
  const runs = service.runs;

  /** The credential must be current and its AgentRun still nonterminal. */
  const requireActive = (principal: AgentPrincipal): RunSnapshot => {
    if (!grants.isCurrent(principal.principalRunId, principal.hash)) {
      throw new OwnerError("UNAUTHENTICATED", "Agent credential is revoked");
    }
    let snapshot: RunSnapshot;
    try {
      snapshot = runs.get(principal.principalRunId);
    } catch {
      throw new OwnerError("UNAUTHENTICATED", "Agent credential is not active");
    }
    if (snapshot.lifecycle === "terminal") {
      throw new OwnerError("UNAUTHENTICATED", "Agent credential is not active");
    }
    return snapshot;
  };

  /**
   * Control is granted by the owner-recorded spawn relationship only. A
   * client-claimed parentRunId, a known ID, or lineage alone never qualifies.
   */
  const requireChild = (
    principal: AgentPrincipal,
    agentRunId: string,
  ): RunSnapshot => {
    requireActive(principal);
    let child: RunSnapshot;
    try {
      child = runs.get(agentRunId);
    } catch (error) {
      if (error instanceof RunNotFoundError) throw forbidden();
      throw error;
    }
    if (
      child.spawnedBy !== principal.principalRunId ||
      child.parentRunId !== principal.principalRunId
    ) {
      throw forbidden();
    }
    return child;
  };

  return {
    async spawn(principal, request) {
      const parent = requireActive(principal);
      if (
        request.parentRunId !== undefined &&
        request.parentRunId !== principal.principalRunId
      ) {
        throw forbidden();
      }
      // An execution profile is operator-admitted policy. A scoped agent
      // cannot confer one (its children keep default deny), and a supplied
      // profile is refused rather than silently dropped.
      if (request.executionProfile !== undefined) {
        throw new OwnerError(
          "FORBIDDEN",
          "An agent cannot admit an execution profile for a child run",
        );
      }
      // Tsukai is not a workspace authority: a child may carry exactly the
      // scope the owner already admitted for its parent, never a different or
      // wider one. Anything else needs external (Nawabari) admission through
      // the operator channel.
      let workspace: RunCreateInput["workspace"];
      if (request.workspace === undefined) {
        workspace = parent.workspace;
      } else {
        const requested = request.workspace as RunSnapshot["workspace"];
        if (!sameWorkspace(requested, parent.workspace)) {
          throw new OwnerError(
            "FORBIDDEN",
            "Child workspace must equal the parent's admitted workspace scope",
          );
        }
        workspace = parent.workspace;
      }
      const input = {
        harness: request.harness,
        request: request.request,
        ...(request.metadata === undefined
          ? {}
          : { metadata: request.metadata }),
        ...(workspace === undefined
          ? {}
          : {
              workspace: {
                cwd: workspace.cwd,
                ...(workspace.workspaceSessionId === undefined
                  ? {}
                  : { workspaceSessionId: workspace.workspaceSessionId }),
              },
            }),
        parentRunId: principal.principalRunId,
        spawnedBy: principal.principalRunId,
      };
      return runs.create(input as unknown as RunCreateInput<never, never>);
    },
    status: (principal, agentRunId) => {
      requireChild(principal, agentRunId);
      return runs.get(agentRunId);
    },
    wait: (principal, agentRunId, options) => {
      requireChild(principal, agentRunId);
      return runs.wait(agentRunId, options);
    },
    result: (principal, agentRunId) => {
      requireChild(principal, agentRunId);
      return runs.result(agentRunId);
    },
    cancel: (principal, agentRunId) => {
      requireChild(principal, agentRunId);
      return runs.cancel(agentRunId);
    },
  };
}
