/**
 * Error vocabulary the tools report to the model. Each code tells the caller
 * what to do next: fix the arguments, fix the configuration, or retry.
 */
export type ErrorCode =
  | "CONFIG_INVALID"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "AUTH_FAILED"
  | "FORBIDDEN"
  | "UPSTREAM_ERROR"
  | "CONNECTION_FAILED"
  | "TIMEOUT"
  | "INTERNAL_ERROR";

export class ImmichMcpError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "ImmichMcpError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Startup configuration is wrong; the server refuses to start. */
export class ConfigurationError extends ImmichMcpError {
  constructor(message: string) {
    super("CONFIG_INVALID", message);
    this.name = "ConfigurationError";
  }
}

/** The caller passed something that cannot be turned into a query. */
export class InputError extends ImmichMcpError {
  constructor(message: string) {
    super("INVALID_INPUT", message);
    this.name = "InputError";
  }
}

export class NotFoundError extends ImmichMcpError {
  constructor(message: string) {
    super("NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

/** Any thrown value as an {@link ImmichMcpError}, so the tool layer has one shape to report. */
export function toImmichError(err: unknown): ImmichMcpError {
  if (err instanceof ImmichMcpError) return err;
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return new ImmichMcpError("TIMEOUT", "Immich did not answer in time.", true);
    }
    return new ImmichMcpError("INTERNAL_ERROR", err.message);
  }
  return new ImmichMcpError("INTERNAL_ERROR", String(err));
}
