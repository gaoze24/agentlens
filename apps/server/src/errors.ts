import type { RawCodexEvent, RunUsage } from "./types.js";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunnerExecutionError extends Error {
  constructor(
    message: string,
    public readonly events: readonly RawCodexEvent[] = [],
    public readonly usage: RunUsage | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunnerExecutionError";
  }
}

export class RunCancelledError extends RunnerExecutionError {
  constructor(
    events: readonly RawCodexEvent[] = [],
    usage: RunUsage | null = null,
  ) {
    super("Run cancelled", events, usage);
    this.name = "RunCancelledError";
  }
}
