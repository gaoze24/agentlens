#!/usr/bin/env node
/**
 * Verify an exported audit bundle.
 *
 * The bundle is the artifact this middleware exists to produce: the thing that
 * leaves the machine and gets handed to someone who was not there. This script
 * is the check that it is worth handing over -- that it is well formed, that
 * its span tree is intact, and that nothing credential-shaped survived
 * redaction.
 *
 * The redaction patterns below are deliberately an INDEPENDENT re-statement of
 * the ones in apps/server/src/trace.ts rather than an import of them. A
 * verifier that shares code with the producer cannot catch a bug in the shared
 * code, and the point of this script is to disbelieve the producer.
 *
 *   node scripts/verify-audit.mjs agentlens-run-<id>-audit.json
 *
 * Exits 0 when the bundle passes, 1 when it does not.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

const SUPPORTED_SCHEMA_VERSIONS = [1, 2];

const CREDENTIAL_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/i, "a bearer token"],
  [/Basic\s+[A-Za-z0-9+/]{8,}={0,2}/i, "a basic authorization value"],
  [/\bsk-[A-Za-z0-9_-]{16,}/, "an sk- API key"],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub fine-grained token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAIza[A-Za-z0-9_-]{30,}/, "a Google API key"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, "an AWS access key id"],
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----/, "a private key block"],
];

const SENSITIVE_FIELD =
  /^[A-Za-z0-9_.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)$/i;
const SECRET_ASSIGNMENT =
  /[A-Za-z0-9_.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[=:]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&"']+)/gi;
const isRedacted = (value) =>
  typeof value === "string" && /^\[REDACTED(?: PRIVATE KEY)?\]$/.test(value);

const problems = [];
const fail = (message) => problems.push(message);

const [filePath] = process.argv.slice(2);
if (!filePath) {
  console.error("usage: node scripts/verify-audit.mjs <audit-bundle.json>");
  process.exit(1);
}

let bundle;
try {
  bundle = JSON.parse(await readFile(filePath, "utf8"));
} catch (error) {
  console.error("Could not read " + filePath + ": " + error.message);
  process.exit(1);
}

// --- Shape -----------------------------------------------------------------

if (!SUPPORTED_SCHEMA_VERSIONS.includes(bundle.schemaVersion)) {
  fail(
    "schemaVersion is " +
      JSON.stringify(bundle.schemaVersion) +
      "; this verifier understands " +
      SUPPORTED_SCHEMA_VERSIONS.join(" and "),
  );
}
for (const field of ["exportedAt", "agent", "run", "summary", "spans"]) {
  if (bundle[field] === undefined) fail("missing top-level field: " + field);
}

const spans = Array.isArray(bundle.spans) ? bundle.spans : [];
const run = bundle.run ?? {};
if (!Array.isArray(bundle.spans)) fail("spans is not an array");

// --- Identity --------------------------------------------------------------

const REQUIRED_SPAN_FIELDS = [
  "id",
  "runId",
  "agentId",
  "category",
  "name",
  "status",
  "startedAt",
  // Early v1 exports predate span identities. Current v2 exports must carry
  // them, but a previously exported v1 file cannot be migrated in place.
  ...(bundle.schemaVersion === 2 ? ["traceId", "agentVersion", "actorType"] : []),
];
for (const [index, span] of spans.entries()) {
  const where = "span " + (span?.id ?? "#" + index);
  for (const field of REQUIRED_SPAN_FIELDS) {
    if (span?.[field] === undefined || span?.[field] === null) {
      fail(where + " has no " + field + ", so it cannot be interpreted on its own");
    }
  }
  if (span?.runId !== undefined && run.id !== undefined && span.runId !== run.id) {
    fail(where + " belongs to run " + span.runId + ", not " + run.id);
  }
}

const traceIds = new Set(spans.map((span) => span.traceId).filter(Boolean));
if (traceIds.size > 1) {
  fail("spans carry " + traceIds.size + " different traceIds; a Run is one trace");
}

const ids = spans.map((span) => span.id);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length > 0) {
  fail("duplicate span ids: " + [...new Set(duplicates)].join(", "));
}

// --- Tree ------------------------------------------------------------------

const byId = new Map(spans.map((span) => [span.id, span]));
const roots = spans.filter((span) => !span.parentSpanId);
if (spans.length > 0 && roots.length !== 1) {
  fail("expected exactly one root span, found " + roots.length);
}
for (const span of spans) {
  if (span.parentSpanId && !byId.has(span.parentSpanId)) {
    fail("span " + span.id + " points at a parent that is not in the bundle");
  }
}
for (const span of spans) {
  const seen = new Set();
  let current = span;
  while (current?.parentSpanId) {
    if (seen.has(current.id)) {
      fail("span " + span.id + " sits in a parent cycle");
      break;
    }
    seen.add(current.id);
    current = byId.get(current.parentSpanId);
  }
}

// --- Timing ----------------------------------------------------------------

for (const span of spans) {
  const started = Date.parse(span.startedAt);
  if (!Number.isFinite(started)) {
    fail("span " + span.id + " has an unparseable startedAt");
    continue;
  }
  if (span.completedAt) {
    const completed = Date.parse(span.completedAt);
    if (!Number.isFinite(completed)) {
      fail("span " + span.id + " has an unparseable completedAt");
    } else if (completed < started) {
      fail("span " + span.id + " completed before it started");
    } else if (
      typeof span.durationMs === "number" &&
      Math.abs(span.durationMs - (completed - started)) > 1
    ) {
      fail(
        "span " +
          span.id +
          " reports " +
          span.durationMs +
          " ms but its timestamps say " +
          (completed - started) +
          " ms",
      );
    }
  }
}

const TERMINAL = ["completed", "failed", "cancelled"];
if (TERMINAL.includes(run.status)) {
  const open = spans.filter((span) => span.status === "running" || !span.completedAt);
  if (open.length > 0) {
    fail(
      "run is " +
        run.status +
        " but " +
        open.length +
        " span(s) were never closed: " +
        open.map((span) => span.name).join(", "),
    );
  }
}

// --- Redaction -------------------------------------------------------------

function inspectSecrets(value) {
  if (Array.isArray(value)) {
    value.forEach(inspectSecrets);
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      inspectSecrets(key);
      if (SENSITIVE_FIELD.test(key) && nested !== null && nested !== "" && !isRedacted(nested)) {
        fail("the bundle contains an unredacted sensitive field");
      }
      inspectSecrets(nested);
    }
  } else if (typeof value === "string") {
    if (/^\s*[\[{]/.test(value)) {
      try {
        const decoded = JSON.parse(value);
        inspectSecrets(decoded);
        return;
      } catch {
        // Partial JSON still needs the text checks below.
      }
    }
    // Scan decoded strings, not their JSON serialization (which hides quoted
    // keys behind escaping). No credential values or field names are printed.
    for (const [pattern, description] of CREDENTIAL_PATTERNS) {
      if (pattern.test(value)) fail("the bundle appears to contain " + description);
    }
    for (const match of value.matchAll(SECRET_ASSIGNMENT)) {
      const candidate = match[1].replace(/^(["'])([\s\S]*)\1$/, "$2");
      if (candidate && candidate !== "null" && !isRedacted(candidate)) {
        fail("the bundle contains an unredacted secret assignment");
      }
    }
  }
}
inspectSecrets(bundle);

// --- Report ----------------------------------------------------------------

if (problems.length > 0) {
  console.error("FAILED: " + filePath);
  for (const problem of problems) console.error("  - " + problem);
  console.error("\n" + problems.length + " problem(s).");
  process.exit(1);
}

const summary = bundle.summary ?? {};
console.log("OK: " + filePath);
console.log(
  "  schema v" +
    bundle.schemaVersion +
    " · run " +
    (run.id ?? "?") +
    " (" +
    (run.status ?? "?") +
    ") · " +
    spans.length +
    " spans in one connected tree",
);
console.log(
  "  " +
    (summary.totalTokens ?? 0).toLocaleString() +
    " tokens · " +
    (summary.cost ? summary.cost.estimatedTotal + " " + summary.cost.currency : "unpriced") +
    " · " +
    (summary.errors ?? 0) +
    " error(s), " +
    (summary.warnings ?? 0) +
    " warning(s), " +
    (summary.policyDenials ?? 0) +
    " policy denial(s)",
);
console.log("  no credential-shaped strings found");
