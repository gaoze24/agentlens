import type { PolicyDecision, PolicyRule, RawCodexEvent } from "./types.js";

/**
 * What may precede a command word. Codex does not emit bare commands: it wraps
 * every one as `/usr/bin/bash -lc '<command>'`, so a rule anchored only on
 * whitespace never matches real traffic. Quotes, pipes, and subshell
 * punctuation all have to count as a boundary.
 */
const BOUNDARY = String.raw`(?:^|[\s;|&(){}'"\`])`;

function rulePattern(body: string): RegExp {
  return new RegExp(BOUNDARY + body, "i");
}

/**
 * Default rules. The Agent executes model-authored commands inside a container
 * that mounts one workspace, so the assets worth protecting are credentials and
 * anything outside that workspace. Each rule names the asset it protects, so a
 * denial explains itself rather than just refusing.
 */
export const DEFAULT_POLICY_RULES: readonly PolicyRule[] = [
  {
    id: "credential-read",
    description: "Reading credential stores outside the Agent workspace",
    asset: "Host and user credentials",
    pattern: rulePattern(
      String.raw`(cat|less|more|head|tail|strings|xxd|od)\s+[^\n|;&]*(~/\.ssh|/\.ssh/|~/\.aws|/\.aws/|/etc/shadow|/etc/passwd|\.netrc|id_rsa|id_ed25519)`,
    ),
  },
  {
    // Fetching is ordinary development work; *sending* is what leaves the box.
    // Matching any URL here would deny `curl https://registry.npmjs.org/...`.
    id: "credential-exfiltration",
    description: "Uploading data to a network endpoint from a shell command",
    asset: "Workspace contents and credentials",
    pattern: rulePattern(
      String.raw`(curl|wget)\s+[^\n]*(--data\b|--data-binary\b|--data-raw\b|--upload-file\b|--form\b|-d\s|-F\s|-T\s|--post-file\b)`,
    ),
  },
  {
    id: "file-transfer-tool",
    description: "Moving files off the Runtime with a transfer tool",
    asset: "Workspace contents",
    pattern: rulePattern(String.raw`(nc|ncat|netcat|scp|sftp|rsync|ftp)\s`),
  },
  {
    id: "host-filesystem-write",
    description: "Writing outside the Agent workspace",
    asset: "Host filesystem",
    pattern: rulePattern(
      String.raw`(rm|mv|cp|chmod|chown|tee|dd)\s+(?:[^\n]*\s)?(/etc/|/usr/|/bin/|/sbin/|/var/|/root/|~/)`,
    ),
  },
  {
    id: "destructive-root",
    description: "Recursive deletion of a root path",
    asset: "Host filesystem",
    pattern: rulePattern(String.raw`rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+/(\s|$|')`),
  },
  {
    id: "privilege-escalation",
    description: "Escalating privileges inside the Runtime",
    asset: "Runtime isolation",
    pattern: rulePattern(String.raw`(sudo|su|doas)\s`),
  },
];

export function parsePolicyRules(
  raw: string | undefined,
  fallback: readonly PolicyRule[] = DEFAULT_POLICY_RULES,
): readonly PolicyRule[] {
  if (!raw || !raw.trim()) return fallback;
  const parsed = JSON.parse(raw) as {
    id: string;
    description: string;
    asset: string;
    pattern: string;
  }[];
  if (!Array.isArray(parsed)) throw new Error("POLICY_RULES must be a JSON array");
  return parsed.map((rule) => {
    if (!rule.id || !rule.pattern) {
      throw new Error("Each policy rule needs an id and a pattern");
    }
    return {
      id: rule.id,
      description: rule.description ?? rule.id,
      asset: rule.asset ?? "unspecified",
      pattern: new RegExp(rule.pattern, "i"),
    };
  });
}

/** The command an event asks the Runtime to execute, if it is one. */
export function commandForEvent(event: Record<string, unknown>): string | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (type !== "item.started" && type !== "item.completed") return null;
  const item = event.item as Record<string, unknown> | undefined;
  if (!item || item.type !== "command_execution") return null;
  return typeof item.command === "string" ? item.command : null;
}

/**
 * Evaluates one observed action. Returns an allow decision when nothing
 * matches, so the trace records that the check ran rather than leaving its
 * absence ambiguous.
 */
export function evaluateCommand(
  command: string,
  rules: readonly PolicyRule[],
): PolicyDecision {
  for (const rule of rules) {
    if (rule.pattern.test(command)) {
      return {
        decision: "deny",
        ruleId: rule.id,
        reason: rule.description,
        protectedAsset: rule.asset,
        command,
      };
    }
  }
  return {
    decision: "allow",
    ruleId: null,
    reason: "No rule matched",
    protectedAsset: null,
    command,
  };
}

export function evaluateEvent(
  raw: RawCodexEvent,
  rules: readonly PolicyRule[],
): PolicyDecision | null {
  const command = commandForEvent(raw.event);
  if (command === null) return null;
  return evaluateCommand(command, rules);
}
