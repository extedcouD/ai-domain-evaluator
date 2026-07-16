/**
 * Errors the harness raises on purpose.
 *
 * This module imports nothing. That's load-bearing: an entrypoint needs to catch a config failure,
 * but config failures happen while the config module is still being *imported*. An entrypoint can
 * only survive that if the error types it catches come from a module that cannot itself fail to
 * load. Keep it that way — no imports, not even type-only ones.
 */

/** Anything the harness threw deliberately, and can therefore explain. */
export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    // Without this, `new ConfigError(m).name` is "Error". The name is the only thing that survives
    // the trip across a process boundary (see `serializeError`), so it has to be right.
    this.name = new.target.name;
  }
}

/** The environment is missing or malformed. */
export class ConfigError extends HarnessError {}

export class LlmError extends HarnessError {}

/** The server isn't answering. Almost always "the server isn't running" or "wrong base URL". */
export class LlmUnreachableError extends LlmError {}

/** The server is up, but isn't serving the model we asked for. */
export class LlmModelNotFoundError extends LlmError {}

/**
 * The user hit ctrl-C, or a run was cancelled.
 *
 * The ONLY error the harness treats as "they meant to do that". It must never be reported as a
 * network failure — a cancelled request and a dead server look identical to the SDK, and telling
 * someone their server is down because they pressed ctrl-C is a genuinely maddening bug.
 */
export class LlmAbortedError extends LlmError {}

/** Something went wrong in the harness's own logic rather than at the model boundary. */
export class EngineError extends HarnessError {}

/**
 * The model never produced a value that satisfied the schema, even after being shown its own errors.
 *
 * Carries every raw attempt. A failure you cannot look at is a failure you cannot fix, and by the
 * time this throws you have spent three round trips learning something — none of which is in the
 * message. It belongs in the exception, not in a log line someone has to go find.
 */
export class SchemaRepairExhaustedError extends EngineError {
  constructor(
    message: string,
    readonly attempts: readonly string[],
  ) {
    super(message);
  }
}

/** The backend cannot do this, and there is no way to fake it. */
export class CapabilityUnavailableError extends EngineError {}
