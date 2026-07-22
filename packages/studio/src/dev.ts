/**
 * The dev runner: one command that boots BOTH halves of KB Studio.
 *
 * The node:http server (server.ts) owns `/api`; Vite owns the React UI + HMR and proxies `/api` back to
 * the node server (see vite.config.ts). Keeping them as two processes is why server.ts stays a lean API
 * with no bundler in its own graph — this file just wires the two together for `pnpm studio`.
 *
 * Mongo: connects to `MONGODB_URI`, or — with `KB_MONGO_MEMORY=1` — spins up a throwaway in-memory
 * mongod so `pnpm studio` needs no local database. The KB is auto-imported from `KB_DIR` on first boot.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_ACTOR } from "./actor";
import { connectDb } from "./db";
import { bootstrapKb, createStudioServer } from "./server";

async function resolveUri(): Promise<string> {
  if (process.env["KB_MONGO_MEMORY"] === "1") {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const mem = await MongoMemoryServer.create();
    process.stdout.write(`  (KB_MONGO_MEMORY) in-memory mongod at ${mem.getUri()}\n`);
    return mem.getUri();
  }
  return process.env["MONGODB_URI"] ?? "mongodb://127.0.0.1:27017";
}

async function main(): Promise<void> {
  const kbDir = process.env["KB_DIR"] ?? join(process.cwd(), "kb");
  const coverageDir = process.env["KB_COVERAGE_DIR"] ?? join(process.cwd(), "kb-coverage");
  const exportDir = process.env["KB_EXPORT_DIR"] ?? kbDir;
  const dbName = process.env["KB_DB_NAME"] ?? "kb_studio";
  const apiPort = Number(process.env["KB_API_PORT"] ?? "4318");
  const uiPort = Number(process.env["KB_STUDIO_PORT"] ?? "7674");
  const multiUser = process.env["KB_MULTI_USER"] === "1";
  const envAdmins = (process.env["KB_ADMINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const db = await connectDb(await resolveUri(), dbName);
  await bootstrapKb(db, { kbDir, seedAdmins: envAdmins.length ? envAdmins : [DEFAULT_ACTOR.email], actor: DEFAULT_ACTOR });

  const api = createStudioServer({ db, coverageDir, exportDir, multiUser });
  api.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `\n  KB Studio API port ${String(apiPort)} is already in use — another instance is likely running.\n` +
          `  Stop it (e.g. \`lsof -ti tcp:${String(apiPort)} | xargs kill\`) or set KB_API_PORT, then retry.\n\n`,
      );
    } else {
      process.stderr.write(`\n  KB Studio API failed to start: ${err.message}\n\n`);
    }
    process.exit(1);
  });

  api.listen(apiPort, "127.0.0.1", () => {
    process.stdout.write(`\n  KB Studio API  → http://127.0.0.1:${String(apiPort)}  (authoring ${kbDir})\n`);
    process.stdout.write(`  KB Studio UI   → http://127.0.0.1:${String(uiPort)}  (open this one)\n\n`);

    const pkgDir = fileURLToPath(new URL("..", import.meta.url));
    const vite = spawn("npx", ["--no-install", "vite", "--port", String(uiPort), "--strictPort"], {
      cwd: pkgDir,
      stdio: "inherit",
      env: { ...process.env, KB_API_PORT: String(apiPort) },
    });
    vite.on("exit", (code) => process.exit(code ?? 0));
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`kb-studio dev: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
