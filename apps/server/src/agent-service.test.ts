import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { attachRunnerEvents } from "./errors.js";
import { loadConfig } from "./config.js";
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
        throw new Error("Codex exited with code 1: boom");
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
  });

  it("keeps the steps observed before a failure so the failing step is locatable", async () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.100Z",
        event: {
          type: "item.completed",
          item: { type: "command_execution", command: "npm test" },
        },
      },
      {
        observedAt: "2026-01-01T00:00:00.200Z",
        event: { type: "error", message: "tests failed" },
      },
    ];
    const runner: AgentRunner = {
      run: async () => {
        throw attachRunnerEvents(new Error("Codex exited with code 1: tests failed"), events);
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Partial" });
    const { run } = await service.sendMessage(agent.id, "run the tests");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    const spans = service.getTrace(run.id);
    expect(spans.map((span) => span.category)).toContain("tool.call");
    const failingStep = spans.find((span) => span.category === "runtime.error");
    expect(failingStep?.status).toBe("error");
    expect(failingStep?.errorMessage).toContain("tests failed");
  });

  it("redacts the Ark key and bearer tokens from the stored Run and Agent error", async () => {
    const runner: AgentRunner = {
      run: async () => {
        throw new Error(
          "Codex exited with code 1: key=test-key header=Authorization: Bearer abc.def-123",
        );
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Leaky" });
    const { run } = await service.sendMessage(agent.id, "leak the key");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    const failed = service.getRun(run.id);
    expect(failed.error).not.toContain("test-key");
    expect(failed.error).not.toContain("abc.def-123");
    expect(failed.error).toContain("[REDACTED]");
    expect(service.getAgent(agent.id).lastError).not.toContain("test-key");
  });

  it("removes an Agent's spans when the Agent is deleted", async () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: new Date().toISOString(),
        event: { type: "item.completed", item: { type: "agent_message", text: "hi" } },
      },
    ];
    const service = await makeService({
      run: async () => ({ output: "done", threadId: "t", usage: null, events }),
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

  it("exposes an open trace while the Run is still executing", async () => {
    let release!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      release = resolve;
    });
    let emit!: (event: RawCodexEvent) => void;
    const service = await makeService({
      run: (request) => {
        emit = (event) => request.onEvent?.(event);
        return pending;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Live" });
    const { run } = await service.sendMessage(agent.id, "take your time");

    // Root and process spans exist before the Runtime has returned anything.
    await expect.poll(() => service.getTrace(run.id).length).toBeGreaterThanOrEqual(2);
    const open = service.getTrace(run.id);
    expect(open.every((span) => span.status === "running")).toBe(true);
    expect(open.every((span) => span.completedAt === null)).toBe(true);

    // Events streamed mid-turn become spans without waiting for completion.
    emit({
      observedAt: new Date().toISOString(),
      event: {
        type: "item.completed",
        item: { type: "command_execution", command: "npm test" },
      },
    });
    await expect
      .poll(() => service.getTrace(run.id).some((span) => span.category === "tool.call"))
      .toBe(true);

    release({ output: "done", threadId: "thread", usage: null, events: [] });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const closed = service.getTrace(run.id);
    expect(closed.some((span) => span.status === "running")).toBe(false);
  });

  it("does not duplicate spans that were streamed and then finalised", async () => {
    const event: RawCodexEvent = {
      observedAt: new Date().toISOString(),
      event: { type: "item.completed", item: { type: "agent_message", text: "hi" } },
    };
    const service = await makeService({
      run: async (request) => {
        request.onEvent?.(event);
        await new Promise((resolve) => setTimeout(resolve, 900));
        return { output: "done", threadId: "t", usage: null, events: [event] };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Once" });
    const { run } = await service.sendMessage(agent.id, "say hi");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 5_000 }).toBe("completed");

    const spans = service.getTrace(run.id);
    expect(spans.filter((span) => span.category === "model.message")).toHaveLength(1);
    expect(spans).toHaveLength(3);
  });

  it("keeps streamed spans when the runner reports no events at completion", async () => {
    // A runner may stream events and return none; finalisation must not wipe
    // the trace the control plane already observed.
    const service = await makeService({
      run: async (request) => {
        request.onEvent?.({
          observedAt: new Date().toISOString(),
          event: {
            type: "item.completed",
            item: { type: "command_execution", command: "npm test" },
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 900));
        return { output: "done", threadId: "t", usage: null, events: [] };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "StreamOnly" });
    const { run } = await service.sendMessage(agent.id, "build it");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 5_000 }).toBe("completed");

    const spans = service.getTrace(run.id);
    expect(spans.filter((span) => span.category === "tool.call")).toHaveLength(1);
    expect(spans.some((span) => span.status === "running")).toBe(false);
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
    const makeInstance = () =>
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

    const crashed = makeInstance();
    await crashed.initialize();
    const agent = await crashed.createAgent({ name: "Interrupted" });
    const { run } = await crashed.sendMessage(agent.id, "never finishes");
    await expect.poll(() => crashed.getTrace(run.id).length).toBeGreaterThanOrEqual(2);

    // A second instance over the same store stands in for a process restart.
    const restarted = makeInstance();
    await restarted.initialize();

    expect(restarted.getRun(run.id).status).toBe("cancelled");
    const spans = restarted.getTrace(run.id);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans.every((span) => span.status === "cancelled")).toBe(true);
    expect(spans.every((span) => span.completedAt !== null)).toBe(true);
    expect(spans[0]?.errorMessage).toContain("Server restarted");
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
