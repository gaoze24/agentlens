#!/usr/bin/env node
/**
 * Seed the JSON store with a fixture Agent and two complete traces so a
 * reviewer can inspect the Glass Box middleware without BytePlus ModelArk
 * credentials. See docs/GLASS_BOX.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

const force = process.argv.includes("--force");
const dataDirectory = path.resolve(process.env.APP_DATA_DIR ?? ".data");
const workspaceRoot = path.resolve(process.env.AGENT_WORKSPACE_ROOT ?? "workspaces");
const storePath = path.join(dataDirectory, "launchpad.json");

const agentId = randomUUID();
const agentVersion = 1;
// Both Runs continued one Codex thread, so their spans correlate on it.
const sessionId = "seeded-thread-0001";
const base = Date.parse("2026-08-26T10:00:00.000Z");
const at = (seconds) => new Date(base + seconds * 1_000).toISOString();

/**
 * The identity every span carries. A fixture span that is missing these is not
 * a fixture of anything the platform actually writes, so the seed builds them
 * with the same shape `trace.ts` does.
 */
const identity = (traceId, runId) => ({ traceId, runId, agentId, agentVersion, sessionId });

/**
 * One Codex item rendered as an already-redacted span. Steps carry a real
 * duration, the way an item.started / item.completed pair does, so the
 * timeline in the trace view shows the shape of the Run rather than a row of
 * zero-width ticks.
 */
function eventSpan(traceId, runId, parentSpanId, startSeconds, durationSeconds, category, name, attributes, errorMessage = null, status = null, actorType = "agent") {
  return {
    id: randomUUID(),
    ...identity(traceId, runId),
    actorType,
    parentSpanId,
    category,
    name,
    status: status ?? (errorMessage ? "error" : "ok"),
    startedAt: at(startSeconds),
    completedAt: at(startSeconds + durationSeconds),
    durationMs: Math.round(durationSeconds * 1_000),
    attributes,
    errorMessage,
  };
}

function buildRun({ offset, prompt, output, error, usage, steps }) {
  const runId = randomUUID();
  const traceId = randomUUID();
  const rootId = randomUUID();
  const processId = randomUUID();
  const failed = Boolean(error);
  // Lay the steps end to end, starting once the Runtime is up.
  const stepStarts = [];
  let cursor = offset + 1;
  for (const step of steps) {
    stepStarts.push(cursor);
    cursor += step.duration + 0.1;
  }
  const last = Math.round((cursor + 0.4) * 10) / 10;
  const spans = [
    {
      id: rootId,
      ...identity(traceId, runId),
      // The Run exists because a person asked for it.
      actorType: "human",
      parentSpanId: null,
      category: "orchestration",
      name: "run.orchestration",
      status: failed ? "error" : "ok",
      startedAt: at(offset),
      completedAt: at(last),
      durationMs: Math.round((last - offset) * 1_000),
      attributes: {
        promptLength: prompt.length,
        promptPreview: prompt.slice(0, 200),
      },
      errorMessage: error,
    },
    {
      id: processId,
      ...identity(traceId, runId),
      actorType: "agent",
      parentSpanId: rootId,
      category: "runtime.process",
      name: "runtime.container",
      status: failed ? "error" : "ok",
      startedAt: at(offset + 0.5),
      completedAt: at(last),
      durationMs: Math.round((last - offset - 0.5) * 1_000),
      attributes: {
        sandboxMode: "workspace-write",
        runtimeProvider: "container",
        containerEngine: "docker",
        model: "deepseek-v4-flash",
        modelBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        runtimeImage: "volc-agent-runtime:local",
        resourceLimits: { cpus: 2, memory: "2g", pids: 256 },
        usage,
      },
      errorMessage: error,
    },
    ...steps.map((step, index) =>
      eventSpan(
        traceId,
        runId,
        processId,
        stepStarts[index],
        step.duration,
        step.category,
        step.name,
        step.attributes,
        step.errorMessage ?? null,
        step.status ?? null,
        step.actorType ?? "agent",
      ),
    ),
  ];
  const run = {
    id: runId,
    agentId,
    status: failed ? "failed" : "completed",
    prompt,
    output,
    error,
    usage,
    startedAt: at(offset),
    completedAt: at(last),
    createdAt: at(offset),
  };
  const messages = [
    {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: at(offset),
    },
    ...(output
      ? [
          {
            id: randomUUID(),
            agentId,
            runId,
            role: "assistant",
            content: output,
            createdAt: at(last),
          },
        ]
      : []),
  ];
  return { run, messages, spans };
}

const successful = buildRun({
  offset: 0,
  prompt: "Create a TypeScript hello-world CLI, add a test, and run it.",
  output:
    "Created src/cli.ts and src/cli.test.ts, then ran the suite: 1 test passed.",
  error: null,
  usage: { inputTokens: 1_842, cachedInputTokens: 512, outputTokens: 613 },
  steps: [
    {
      duration: 3.4,
      category: "model.reasoning",
      name: "model.reasoning:reasoning",
      attributes: {
        type: "item.completed",
        item: {
          type: "reasoning",
          text: "I will scaffold a CLI entry point, add one test, then run the suite.",
        },
      },
    },
    {
      duration: 0.4,
      category: "tool.call",
      name: "tool.call:file_change",
      attributes: {
        type: "item.completed",
        item: { type: "file_change", path: "src/cli.ts", change: "added", lines_added: 9 },
      },
    },
    {
      duration: 0.3,
      category: "tool.call",
      name: "tool.call:file_change",
      attributes: {
        type: "item.completed",
        item: { type: "file_change", path: "src/cli.test.ts", change: "added", lines_added: 7 },
      },
    },
    {
      // The platform checked the command before it ran. An allow is recorded
      // too, so the trace shows the check happened rather than leaving its
      // absence ambiguous.
      duration: 0,
      category: "policy.decision",
      name: "policy.decision:allow",
      actorType: "system",
      attributes: {
        decision: "allow",
        ruleId: null,
        reason: "No rule matched",
        protectedAsset: null,
        command: "/usr/bin/bash -lc 'npx vitest run'",
      },
    },
    {
      duration: 2.6,
      category: "tool.call",
      name: "tool.call:command_execution",
      attributes: {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "npx vitest run",
          exit_code: 0,
          aggregated_output: "Test Files  1 passed (1)\n     Tests  1 passed (1)",
        },
      },
    },
    {
      duration: 0.6,
      category: "model.message",
      name: "model.message:agent_message",
      attributes: {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "Created src/cli.ts and src/cli.test.ts, then ran the suite: 1 test passed.",
        },
      },
    },
    {
      duration: 0.1,
      category: "model.turn",
      name: "model.turn",
      attributes: {
        type: "turn.completed",
        usage: { input_tokens: 1_842, cached_input_tokens: 512, output_tokens: 613 },
      },
    },
  ],
});

const failing = buildRun({
  offset: 120,
  prompt:
    "Add a second test that asserts 1 === 2 so the suite fails, then run the whole suite and report the result.",
  output: null,
  error: "Codex exited with code 1: 1 test failed",
  usage: { inputTokens: 2_140, cachedInputTokens: 1_024, outputTokens: 288 },
  steps: [
    {
      // A turn that starts and never completes, so the audit summary exercises
      // its turn.started fallback the way an interrupted turn would.
      duration: 0.1,
      category: "model.turn",
      name: "model.turn",
      attributes: { type: "turn.started" },
    },
    {
      duration: 2.8,
      category: "model.reasoning",
      name: "model.reasoning:reasoning",
      attributes: {
        type: "item.completed",
        item: {
          type: "reasoning",
          text: "I will append a deliberately failing assertion, then run the suite.",
        },
      },
    },
    {
      duration: 0.4,
      category: "tool.call",
      name: "tool.call:file_change",
      attributes: {
        type: "item.completed",
        item: { type: "file_change", path: "src/cli.test.ts", change: "modified", lines_added: 3 },
      },
    },
    {
      duration: 0,
      category: "policy.decision",
      name: "policy.decision:allow",
      actorType: "system",
      attributes: {
        decision: "allow",
        reason: "Fetching is not sending: no upload flag matched",
        ruleId: null,
        protectedAsset: null,
        command:
          '/usr/bin/bash -lc \'curl -H "Authorization: Bearer [REDACTED]" https://example.invalid/health\'',
      },
    },
    {
      // Demonstrates redaction: the planted key and bearer token are already
      // stored as [REDACTED], exactly as trace.ts would have written them.
      duration: 1.9,
      category: "tool.call",
      name: "tool.call:command_execution",
      attributes: {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: 'curl -H "Authorization: Bearer [REDACTED]" https://example.invalid/health',
          exit_code: 6,
          aggregated_output: "could not resolve host: example.invalid",
        },
      },
    },
    {
      duration: 3.1,
      category: "tool.call",
      name: "tool.call:command_execution",
      attributes: {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "npx vitest run",
          exit_code: 1,
          aggregated_output:
            "FAIL  src/cli.test.ts > fails on purpose\nAssertionError: expected 1 to be 2",
        },
      },
      errorMessage: null,
    },
    {
      // The Ark model-metadata fallback: noisy but harmless, and classified as
      // a warning rather than an error so red stays meaningful.
      duration: 0.2,
      category: "runtime.warning",
      name: "runtime.warning",
      status: "warning",
      attributes: {
        type: "item.completed",
        item: { type: "error", message: "Model metadata for deepseek-v4-flash not found." },
      },
      errorMessage: "Model metadata for deepseek-v4-flash not found.",
    },
    {
      duration: 0.1,
      category: "runtime.error",
      name: "runtime.error",
      attributes: {
        type: "error",
        message: "1 test failed: expected 1 to be 2 (src/cli.test.ts)",
      },
      errorMessage: "1 test failed: expected 1 to be 2 (src/cli.test.ts)",
    },
  ],
});

const database = {
  version: 1,
  agents: [
    {
      id: agentId,
      version: agentVersion,
      name: "Demo Tracer",
      description: "Seeded fixture Agent with a successful and a failing Run.",
      instructions: "Write small TypeScript utilities and always run the test suite.",
      status: "error",
      workspacePath: path.join(workspaceRoot, agentId),
      codexThreadId: "seeded-thread-0001",
      lastError: "Codex exited with code 1: 1 test failed",
      createdAt: at(-60),
      updatedAt: at(126),
    },
  ],
  messages: [...successful.messages, ...failing.messages],
  runs: [successful.run, failing.run],
  spans: [...successful.spans, ...failing.spans],
};

let existing = null;
try {
  existing = JSON.parse(await readFile(storePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (existing?.agents?.length && !force) {
  console.error(
    "Refusing to overwrite " +
      storePath +
      " (" +
      existing.agents.length +
      " existing Agent(s)). Re-run with --force to replace it.",
  );
  process.exit(1);
}

await mkdir(dataDirectory, { recursive: true });
await mkdir(path.join(workspaceRoot, agentId), { recursive: true });
await writeFile(storePath, JSON.stringify(database, null, 2) + "\n", {
  encoding: "utf8",
  mode: 0o600,
});

console.log("Seeded " + storePath);
console.log(
  "  1 Agent, " +
    database.runs.length +
    " Runs, " +
    database.spans.length +
    " spans (1 successful, 1 failing mid-execution).",
);
console.log("Restart the server, then open the Agent and select View trace.");
console.log(
  "  Set TRACE_COST_*_PER_MTOK in the server's environment to price these Runs;",
);
console.log("  unpriced, the trace view's cost card reads \"Not priced\".",
);
