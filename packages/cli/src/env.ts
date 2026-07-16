/**
 * The one impure line, isolated. Reading the actual environment is the APPLICATION's privilege — core
 * is lint-forbidden from touching `process.env` or `dotenv`. `parseEnv` (pure, from core) is where
 * reading the world becomes a validated `Config`.
 *
 * This module throws while it is being IMPORTED if the environment is bad, which is exactly why the
 * CLI imports it lazily inside a try/catch (see cli.ts) — so a missing `LLM_MODEL` becomes a sentence,
 * not a stack trace.
 */
import "dotenv/config";

import { parseEnv, type Config } from "@evaluator/core";

export const config: Config = parseEnv(process.env);
