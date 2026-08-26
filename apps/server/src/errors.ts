import type { RawCodexEvent } from "./types.js";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

const RUNNER_EVENTS = Symbol.for("launchpad.runnerEvents");

/**
 * Attach the Codex events observed before a Runtime failure to the thrown
 * error, so the trace for a failed or cancelled Run still shows the steps that
 * led up to the failure instead of only the two enclosing spans.
 */
export function attachRunnerEvents<T>(error: T, events: readonly RawCodexEvent[]): T {
  if (error instanceof Error && events.length > 0) {
    Object.defineProperty(error, RUNNER_EVENTS, {
      value: events,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}

export function runnerEventsFrom(error: unknown): readonly RawCodexEvent[] {
  if (!(error instanceof Error)) return [];
  const events = (error as unknown as Record<symbol, unknown>)[RUNNER_EVENTS];
  return Array.isArray(events) ? (events as RawCodexEvent[]) : [];
}
