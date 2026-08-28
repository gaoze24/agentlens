import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError, RunnerExecutionError } from "./errors.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RawCodexEvent, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("terminates a Run at the Runtime boundary when policy denies an action", async () => {
    // A runner that would keep going forever if nothing stopped it, and that
    // records whether the denied command was ever allowed to complete.
    let completedDeniedCommand = false;
    let abort!: (reason: unknown) => void;
    const pending = new Promise<RunnerResult>((resolve, reject) => {
      abort = reject;
      // If enforcement fails to stop it, the command completes shortly after
      // and this flag flips -- so the assertion below is not vacuous.
      setTimeout(() => {
        completedDeniedCommand = true;
        resolve({ output: "leaked the key", threadId: "t", usage: null, events: [] });
      }, 400);
    });
    let cancelCalls = 0;
    const service = await makeService({
      run: (request) => {
        request.onEvent?.({
          observedAt: new Date().toISOString(),
          event: {
            type: "item.started",
            item: { id: "i1", type: "command_execution", command: "cat ~/.ssh/id_rsa" },
          },
        });
        return pending;
      },
      cancel: async () => {
        cancelCalls += 1;
        abort(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Contained" });
    const { run } = await service.sendMessage(agent.id, "read my ssh key");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    // Enforcement happened at the boundary, not after the fact.
    expect(cancelCalls).toBeGreaterThan(0);
    expect(completedDeniedCommand).toBe(false);
    // It reads as blocked, not as an operator cancellation.
    expect(service.getRun(run.id).error).toContain("Blocked by policy");
    expect(service.getRun(run.id).error).toContain("credential-read");

    const decision = service
      .getTrace(run.id)
      .find((span) => span.category === "policy.decision");
    expect(decision?.status).toBe("error");
    expect(decision?.actorType).toBe("system");
    expect(decision?.attributes).toMatchObject({
      decision: "deny",
      ruleId: "credential-read",
      protectedAsset: "Host and user credentials",
    });
  });

  it("records an allow decision so the check is visible on a clean Run", async () => {
    const service = await makeService({
      run: async (request) => {
        request.onEvent?.({
          observedAt: new Date().toISOString(),
          event: {
            type: "item.started",
            item: { id: "i1", type: "command_execution", command: "npm test" },
          },
        });
        return { output: "done", threadId: "t", usage: null, events: [] };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Clean" });
    const { run } = await service.sendMessage(agent.id, "run the tests");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const decision = service
      .getTrace(run.id)
      .find((span) => span.category === "policy.decision");
    expect(decision?.status).toBe("ok");
    expect(decision?.attributes.decision).toBe("allow");
  });

  it("leaves the Agent usable after a policy denial", async () => {
    let deny = true;
    let abort!: (reason: unknown) => void;
    const service = await makeService({
      run: (request) => {
        if (deny) {
          // The promise must exist before the event fires: onEvent triggers
          // cancel synchronously, and cancel rejects this promise.
          const running = new Promise<RunnerResult>((_resolve, reject) => {
            abort = reject;
          });
          request.onEvent?.({
            observedAt: new Date().toISOString(),
            event: {
              type: "item.started",
              item: { id: "i1", type: "command_execution", command: "sudo rm -rf /" },
            },
          });
          return running;
        }
        return Promise.resolve({
          output: "recovered",
          threadId: "t",
          usage: null,
          events: [],
        });
      },
      cancel: async () => {
        abort(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Recoverable" });
    const blocked = await service.sendMessage(agent.id, "destroy everything");
    await expect.poll(() => service.getRun(blocked.run.id).status).toBe("failed");

    // Recovery: the Agent accepts work again once started.
    deny = false;
    await service.startAgent(agent.id);
    const after = await service.sendMessage(agent.id, "do something safe");
    await expect.poll(() => service.getRun(after.run.id).status).toBe("completed");
    expect(service.getAgent(agent.id).status).toBe("ready");
  });


  it("stamps every span of a Run with one shared identity", async () => {
    const service = await makeService({
      run: async () => ({
        output: "done",
        threadId: "thread-9",
        usage: null,
        events: [
          {
            observedAt: new Date().toISOString(),
            event: {
              type: "item.completed",
              item: { id: "i1", type: "command_execution", command: "ls" },
            },
          },
        ],
      }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Identified" });
    const { run } = await service.sendMessage(agent.id, "list the files");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const spans = service.getTrace(run.id);
    expect(spans.length).toBeGreaterThanOrEqual(3);
    // One traceId correlates the whole Run, and it is not the runId.
    const traceIds = new Set(spans.map((span) => span.traceId));
    expect(traceIds.size).toBe(1);
    expect([...traceIds][0]).not.toBe(run.id);
    expect(spans.every((span) => span.runId === run.id)).toBe(true);
    expect(spans.every((span) => span.agentVersion === 1)).toBe(true);

    // The human asked; the Agent acted.
    const root = spans.find((span) => span.parentSpanId === null);
    expect(root?.actorType).toBe("human");
    expect(
      spans.filter((span) => span.id !== root?.id).every((span) => span.actorType === "agent"),
    ).toBe(true);
  });

  it("records the model and infrastructure needed to diagnose a Run", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Diagnosable" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const process = service
      .getTrace(run.id)
      .find((span) => span.category === "runtime.process");
    expect(process?.attributes.model).toBe("ep-test");
    expect(process?.attributes.modelBaseUrl).toBeTruthy();
    expect(process?.attributes.sandboxMode).toBeTruthy();
    // Never the credential itself.
    expect(JSON.stringify(process?.attributes)).not.toContain("test-key");
  });

  it("keeps a redacted prompt preview on the root span", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Preview" });
    const { run } = await service.sendMessage(
      agent.id,
      "deploy using Authorization: Bearer abc.def-123 please",
    );
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const root = service.getTrace(run.id).find((span) => span.parentSpanId === null);
    expect(root?.attributes.promptPreview).toContain("deploy using");
    expect(root?.attributes.promptPreview).not.toContain("abc.def-123");
  });

  it("carries the Codex session id so Runs in one thread correlate", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Threaded" });
    const first = await service.sendMessage(agent.id, "turn one");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const second = await service.sendMessage(agent.id, "turn two");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");

    // The first Run had no thread yet; the second resumes the stored one.
    expect(service.getTrace(first.run.id)[0]?.sessionId).toBeNull();
    expect(service.getTrace(second.run.id)[0]?.sessionId).toBe("fake-thread");
    // Different Runs, different traces.
    expect(service.getTrace(first.run.id)[0]?.traceId).not.toBe(
      service.getTrace(second.run.id)[0]?.traceId,
    );
  });

  it("bumps the Agent version only on a real configuration change", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Versioned" });
    expect(agent.version).toBe(1);
    expect((await service.updateAgent(agent.id, { description: "now described" })).version)
      .toBe(2);
    // A no-op update is not a new version.
    expect((await service.updateAgent(agent.id, { description: "now described" })).version)
      .toBe(2);

    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getTrace(run.id).every((span) => span.agentVersion === 2)).toBe(true);
  });

  it("records what cancelled a Run rather than only that it was cancelled", async () => {
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    // A real runner rejects the in-flight run when cancelled; the fake has to
    // do the same or stopAgent waits on a promise that never settles.
    let abort!: (reason: unknown) => void;
    const pending = new Promise<RunnerResult>((_resolve, reject) => {
      abort = reject;
    });
    const service = await makeService({
      run: () => {
        started();
        return pending;
      },
      cancel: async () => {
        abort(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Stoppable" });
    const { run } = await service.sendMessage(agent.id, "long task");
    await begun;
    await service.stopAgent(agent.id);
    await expect.poll(() => service.getRun(run.id).status).toBe("cancelled");

    const spans = service.getTrace(run.id);
    expect(spans.every((span) => span.status === "cancelled")).toBe(true);
    expect(spans[0]?.attributes.cancelledBy).toBe("operator");
  });


  it("removes an Agent's spans when the Agent is deleted", async () => {
    const service = await makeService({
      run: async () => ({
        output: "done",
        threadId: "t",
        usage: null,
        events: [
          {
            observedAt: new Date().toISOString(),
            event: { type: "item.completed", item: { id: "i1", type: "agent_message", text: "hi" } },
          },
        ],
      }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Ephemeral" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getTrace(run.id).length).toBeGreaterThan(0);

    await service.deleteAgent(agent.id);
    expect(() => service.getTrace(run.id)).toThrowError(/Run not found/);
  });

  it("exposes an open trace before the Runtime returns", async () => {
    let release!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      release = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Live" });
    const { run } = await service.sendMessage(agent.id, "take your time");

    await expect.poll(() => service.getTrace(run.id).length).toBeGreaterThanOrEqual(2);
    const open = service.getTrace(run.id);
    expect(open.map((span) => span.category)).toEqual([
      "orchestration",
      "runtime.process",
    ]);
    expect(open.every((span) => span.status === "running")).toBe(true);
    expect(open.every((span) => span.completedAt === null)).toBe(true);

    release({ output: "done", threadId: "t", usage: null, events: [] });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const closed = service.getTrace(run.id);
    expect(closed.some((span) => span.status === "running")).toBe(false);
    // The open spans were replaced, not duplicated.
    expect(closed).toHaveLength(2);
    expect(new Set(closed.map((span) => span.id)).size).toBe(2);
  });

  it("closes spans left open by a crash when the server restarts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-restart-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const storePath = path.join(root, "data", "launchpad.json");
    const instance = () =>
      new AgentService(
        config,
        new JsonStore(storePath),
        new WorkspaceManager(path.join(root, "workspaces")),
        {
          run: () => new Promise<RunnerResult>(() => undefined),
          cancel: async () => false,
          isAvailable: async () => true,
        },
      );

    const crashed = instance();
    await crashed.initialize();
    const agent = await crashed.createAgent({ name: "Interrupted" });
    const { run } = await crashed.sendMessage(agent.id, "never finishes");
    await expect.poll(() => crashed.getTrace(run.id).length).toBeGreaterThanOrEqual(2);

    // A second service over the same store stands in for a process restart.
    const restarted = instance();
    await restarted.initialize();

    expect(restarted.getRun(run.id).status).toBe("cancelled");
    const spans = restarted.getTrace(run.id);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans.every((span) => span.status === "cancelled")).toBe(true);
    expect(spans.every((span) => span.completedAt !== null)).toBe(true);
    expect(spans.every((span) => (span.durationMs ?? -1) >= 0)).toBe(true);
    expect(spans[0]?.errorMessage).toContain("Server restarted");
  });

  it("retains only the most recent Runs' spans", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-retention-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      TRACE_RETENTION_RUNS: "2",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "launchpad.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Chatty" });

    const runIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const { run } = await service.sendMessage(agent.id, "turn " + index);
      await expect.poll(() => service.getRun(run.id).status).toBe("completed");
      runIds.push(run.id);
    }

    expect(service.getTrace(runIds[0]!)).toHaveLength(0);
    expect(service.getTrace(runIds[1]!).length).toBeGreaterThan(0);
    expect(service.getTrace(runIds[2]!).length).toBeGreaterThan(0);
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("records a correlated, successful trace for a completed run", async () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: new Date().toISOString(),
        event: { type: "item.completed", item: { type: "agent_message", text: "hi" } },
      },
    ];
    const runner: AgentRunner = {
      run: async (request) => ({
        output: "Completed: " + request.prompt,
        threadId: "fake-thread",
        usage: { inputTokens: 1, outputTokens: 1 },
        events,
      }),
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Traced" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const spans = service.getTrace(run.id);
    const root = spans.find((span) => span.parentSpanId === null);
    expect(root?.category).toBe("orchestration");
    expect(root?.status).toBe("ok");
    const process = spans.find((span) => span.parentSpanId === root?.id);
    expect(process?.category).toBe("runtime.process");
    expect(process?.status).toBe("ok");
    const eventSpan = spans.find((span) => span.parentSpanId === process?.id);
    expect(eventSpan?.category).toBe("model.message");
    expect(spans.every((span) => span.runId === run.id)).toBe(true);
  });

  it("identifies the failing step when a run fails", async () => {
    const runner: AgentRunner = {
      run: async () => {
        throw new RunnerExecutionError(
          "Codex exited with code 1: boom for test-key",
          [
            {
              observedAt: new Date().toISOString(),
              event: {
                type: "item.completed",
                item: { id: "item-failed", type: "error", message: "tool failed" },
              },
            },
          ],
          { inputTokens: 7, outputTokens: 1 },
        );
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Failing" });
    const { run } = await service.sendMessage(agent.id, "break things");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    const spans = service.getTrace(run.id);
    const root = spans.find((span) => span.parentSpanId === null);
    expect(root?.status).toBe("error");
    const process = spans.find((span) => span.parentSpanId === root?.id);
    expect(process?.status).toBe("error");
    expect(process?.errorMessage).toContain("boom");
    expect(process?.errorMessage).not.toContain("test-key");
    expect(process?.attributes.usage).toEqual({ inputTokens: 7, outputTokens: 1 });
    const failedEvent = spans.find((span) => span.parentSpanId === process?.id);
    expect(failedEvent?.category).toBe("runtime.error");
    expect(failedEvent?.errorMessage).toContain("tool failed");
    expect(service.getRun(run.id).error).not.toContain("test-key");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});
