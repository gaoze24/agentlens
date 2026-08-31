import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError, RunnerExecutionError } from "./errors.js";
import { JsonStore } from "./store.js";
import { redactSecrets } from "./trace.js";
import type { AgentRunner, AuditBundle, RawCodexEvent } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];
const syntheticKey = "demo-only-configured-credential";
const verifier = fileURLToPath(new URL("../../../scripts/verify-audit.mjs", import.meta.url));

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("audit-regression-")) {
      throw new Error("Refusing cleanup outside the isolated test directory");
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(runner?: AgentRunner) {
  const root = await mkdtemp(path.join(tmpdir(), "audit-regression-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test", ARK_API_KEY: syntheticKey, ARK_MODEL: "ep-test",
    APP_DATA_DIR: path.join(root, "data"), CODEX_HOME: path.join(root, "codex"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(config, store, new WorkspaceManager(config.workspaceRoot), runner ?? {
    isAvailable: async () => true,
    cancel: async () => false,
    run: async () => ({ output: '{"password":"demo-output-password"}', threadId: "test-thread", usage: null, events: [] }),
  });
  await service.initialize();
  const agent = await service.createAgent({ name: "Audit regression fixture" });
  async function execute(prompt = "hello") {
    const { run } = await service.sendMessage(agent.id, prompt);
    await expect.poll(() => service.getRun(run.id).status).not.toMatch(/^(queued|running)$/);
    return service.getAuditBundle(run.id);
  }
  async function verify(bundle: unknown) {
    const outputPath = path.join(root, "audit.json");
    await writeFile(outputPath, JSON.stringify(bundle));
    const result = spawnSync(process.execPath, [verifier, outputPath], { encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  }
  return { service, store, agent, execute, verify };
}

describe("audit privacy regressions", () => {
  it("accepts redacted assignments inside JSON strings without losing structure", async () => {
    const { execute, verify } = await fixture();
    const bundle = await execute();
    bundle.run.output = redactSecrets(JSON.stringify({ output: "DB_PASSWORD=demo-value" }), []);
    expect(JSON.parse(bundle.run.output)).toEqual({ output: "DB_PASSWORD=[REDACTED]" });
    const result = await verify(bundle);
    expect(result.status, result.output).toBe(0);
  });

  it("redacts before truncating a preview across the configured credential", async () => {
    const { execute, verify } = await fixture();
    const bundle = await execute("x".repeat(190) + syntheticKey);
    const preview = bundle.spans.find((span) => span.parentSpanId === null)?.attributes.promptPreview;
    expect(preview).toBe("x".repeat(190) + "[REDACTED]");
    expect(bundle.run.output).toBe('{"password":"[REDACTED]"}');
    const result = await verify(bundle);
    expect(result.status, result.output).toBe(0);
  });

  it.each([
    { password: "demo-leaked-password" },
    { nested: [{ api_key: ["demo-leaked-password"] }] },
    { output: '{"password":"demo-leaked-password"}' },
    { output: 'log: {"password":"demo-leaked-password"}' },
    { output: '{"pass\\u0077ord":"demo-leaked-password"}' },
    { output: "password=x" },
  ])("rejects unredacted data without printing it: %j", async (attributes) => {
    const { execute, verify } = await fixture();
    const bundle: AuditBundle = await execute();
    bundle.spans[0]!.attributes = attributes;
    const result = await verify(bundle);
    expect(result.status).toBe(1);
    expect(result.output).toContain("unredacted");
    expect(result.output).not.toContain("demo-leaked-password");
  });
});

describe("terminal trace regressions", () => {
  it.each(["completed", "failed", "cancelled", "policy-denied"])(
    "closes an unfinished step when the Run is %s and passes the verifier",
    async (outcome) => {
      const { execute, verify } = await fixture({
        isAvailable: async () => true,
        cancel: async () => true,
        run: async (request) => {
          const event: RawCodexEvent = {
            observedAt: new Date().toISOString(),
            event: { type: "item.started", item: {
              id: "unfinished", type: "command_execution",
              command: outcome === "policy-denied" ? "cat ~/.ssh/id_rsa" : "echo synthetic",
            } },
          };
          request.onEvent?.(event);
          if (outcome === "cancelled" || outcome === "policy-denied") throw new RunCancelledError([event]);
          if (outcome === "failed") throw new RunnerExecutionError("Synthetic timeout", [event]);
          return { output: "done", threadId: "test-thread", usage: null, events: [event] };
        },
      });
      const bundle = await execute();
      expect(bundle.run.status).toBe(outcome === "policy-denied" ? "failed" : outcome);
      const step = bundle.spans.find((span) => span.category === "tool.call")!;
      expect(step.completedAt).toBe(bundle.run.completedAt);
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
      expect(step.status).toBe(outcome === "completed" ? "warning" : outcome === "cancelled" ? "cancelled" : "error");
      expect(step.attributes.completionSource).toBe("run-end");
      const result = await verify(bundle);
      expect(result.status, result.output).toBe(0);
    },
  );

  it("repairs old unfinished steps using the recorded Run end, not restart time", async () => {
    const { execute, service, store, verify } = await fixture();
    const bundle = await execute();
    const historicalEnd = "2026-01-01T00:00:05.000Z";
    await store.mutate((database) => {
      const run = database.runs[0]!;
      run.status = "cancelled";
      run.startedAt = "2026-01-01T00:00:00.000Z";
      run.completedAt = historicalEnd;
      database.spans = database.spans.map((span) => ({
        ...span, startedAt: run.startedAt!, completedAt: null, durationMs: null, status: "warning",
      }));
    });
    await service.initialize();
    const repaired = service.getAuditBundle(bundle.run.id);
    expect(repaired.spans.every((span) => span.completedAt === historicalEnd)).toBe(true);
    expect(repaired.spans.every((span) => span.durationMs === 5_000)).toBe(true);
    const result = await verify(repaired);
    expect(result.status, result.output).toBe(0);
    const first = service.getTrace(bundle.run.id);
    await service.initialize();
    expect(service.getTrace(bundle.run.id)).toEqual(first);
  });
});

describe("legacy export regressions", () => {
  it("persists missing identities without reusing today's Agent version or session", async () => {
    const { execute, service, store, agent, verify } = await fixture();
    const bundle = await execute("x".repeat(190) + syntheticKey);
    const ids = bundle.spans.map((span) => [span.id, span.parentSpanId]);
    await service.updateAgent(agent.id, { instructions: "new version" });
    await store.mutate((database) => {
      for (const span of database.spans) {
        const legacy = span as Partial<typeof span>;
        delete legacy.traceId;
        delete legacy.agentVersion;
        delete legacy.actorType;
        delete legacy.sessionId;
        span.attributes.password = "demo-legacy-password";
        if (span.parentSpanId === null) span.attributes.promptPreview = "x".repeat(190) + syntheticKey.slice(0, 10);
      }
    });
    await service.initialize();
    const repaired = service.getAuditBundle(bundle.run.id);
    expect(service.getAgent(agent.id).version).toBe(2);
    expect(repaired.schemaVersion).toBe(2);
    expect(repaired.spans.map((span) => [span.id, span.parentSpanId])).toEqual(ids);
    expect(new Set(repaired.spans.map((span) => span.traceId)).size).toBe(1);
    expect(repaired.spans.every((span) => span.agentVersion === 1 && span.sessionId === null)).toBe(true);
    expect(repaired.spans[0]!.actorType).toBe("human");
    expect(repaired.spans[1]!.actorType).toBe("agent");
    expect(repaired.spans[0]!.attributes.legacyIdentityFields).toContain("agentVersion");
    const persisted = service.getTrace(bundle.run.id);
    expect(JSON.stringify(persisted)).not.toContain("demo-legacy-password");
    expect(persisted[0]!.attributes.promptPreview).toBe("x".repeat(190) + "[REDACTED]");
    const result = await verify(repaired);
    expect(result.status, result.output).toBe(0);
    await service.initialize();
    expect(service.getTrace(bundle.run.id)).toEqual(persisted);
  });

  it("accepts previously exported v1 identities without weakening v2 or tree checks", async () => {
    const { execute, verify } = await fixture();
    const bundle = await execute();
    const legacy = { ...bundle, schemaVersion: 1, spans: bundle.spans.map((span) => {
      const { traceId, agentVersion, actorType, sessionId, ...rest } = span;
      return rest;
    }) };
    const valid = await verify(legacy);
    expect(valid.status, valid.output).toBe(0);
    expect((await verify({ ...legacy, schemaVersion: 2 })).status).toBe(1);
    legacy.spans[1]!.parentSpanId = "nonexistent-parent";
    expect((await verify(legacy)).status).toBe(1);
  });
});
