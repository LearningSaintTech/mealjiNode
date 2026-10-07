import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "./logger.js";

let transactionsSupported = false;
let warnedNoTransactions = false;

export async function connectDatabase() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.mongoUri);
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  transactionsSupported = Boolean(hello.setName) || hello.msg === "isdbgrid";
  logger.info({ replicaSet: hello.setName || null, transactions: transactionsSupported }, "MongoDB connected");

  if (!transactionsSupported) {
    if (env.isProd || env.mongoRequireReplicaSet) {
      throw new Error("MongoDB must run as a replica set so multi-document transactions work");
    }
    logger.warn("MongoDB is standalone. Transactions are disabled in development; use the replica set in docker-compose.yml");
  }
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

export function supportsTransactions() {
  return transactionsSupported;
}

// Runs `work(session)` inside a transaction. On a standalone development
// database there are no transactions, so the work runs with `session = null`
// and is not atomic. Pass the session to every write: `Model.create([doc], { session })`.
export async function withTransaction(work) {
  if (!transactionsSupported) {
    if (!warnedNoTransactions) {
      warnedNoTransactions = true;
      logger.warn("Running without a transaction (standalone MongoDB)");
    }
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
