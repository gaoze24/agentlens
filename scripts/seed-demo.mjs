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
const base = Date.parse("2026-08-26T10:00:00.000Z");
const at = (seconds) => new Date(base + seconds * 1_000).toISOString();

/**
 * One Codex item rendered as an already-redacted span. Steps carry a real
 * duration, the way an item.started / item.completed pair does, so the
 * timeline in the trace view shows the shape of the Run rather than a row of
 * zero-width ticks.
 */
function eventSpan(runId, parentSpanId, startSeconds, durationSeconds, category, name, attributes, errorMessage = null) {
  return {
    id: randomUUID(),
    runId,
    agentId,
    parentSpanId,
    category,
    name,
    status: errorMessage ? "error" : "ok",
    startedAt: at(startSeconds),
    completedAt: at(startSeconds + durationSeconds),
    durationMs: Math.round(durationSeconds * 1_000),
    attributes,
    errorMessage,
  };
}

function buildRun({ offset, prompt, output, error, usage, steps }) {
  const runId = randomUUID();
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
      runId,
      agentId,
      parentSpanId: null,
      category: "orchestration",
      name: "run.orchestration",
      status: failed ? "error" : "ok",
      startedAt: at(offset),
      completedAt: at(last),
      durationMs: Math.round((last - offset) * 1_000),
      attributes: { promptLength: prompt.length },
      errorMessage: error,
    },
    {
      id: processId,
      runId,
      agentId,
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
        usage,
      },
      errorMessage: error,
    },
    ...steps.map((step, index) =>
      eventSpan(
        runId,
        processId,
        stepStarts[index],
        step.duration,
        step.category,
        step.name,
        step.attributes,
        step.errorMessage ?? null,
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
