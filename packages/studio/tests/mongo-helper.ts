/**
 * Shared test scaffolding: one in-memory STANDALONE mongod per suite (matching prod's no-transactions
 * topology), plus a fresh, uniquely-named database per test so suites don't cross-contaminate.
 */
import { MongoMemoryServer } from "mongodb-memory-server";

import { connectDb, ensureIndexes, type DbHandle } from "../src/db";

let mem: MongoMemoryServer | null = null;
let counter = 0;

export async function startMongo(): Promise<void> {
  mem = await MongoMemoryServer.create();
}

export async function stopMongo(): Promise<void> {
  await mem?.stop();
  mem = null;
}

/** A fresh DbHandle on a new database (indexes ensured). Caller closes it. */
export async function freshDb(): Promise<DbHandle> {
  if (!mem) throw new Error("startMongo() must run first");
  const db = await connectDb(mem.getUri(), `t${String(++counter)}`);
  await ensureIndexes(db);
  return db;
}

export function actor(email = "tester@corp.com", name = "Tester"): { name: string; email: string } {
  return { name, email };
}
