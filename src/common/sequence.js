import mongoose from "mongoose";

// Gap-free counters for human-facing numbers (order numbers, invoice series).
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    value: { type: Number, default: 0 },
  },
  { versionKey: false },
);

export const Counter = mongoose.models.Counter || mongoose.model("Counter", counterSchema);

/** Atomically increments and returns the next value of a named counter. */
export async function nextSequence(name, { session = null } = {}) {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { upsert: true, new: true, session: session || undefined },
  ).lean();
  return doc.value;
}

/** The Indian financial year label for a date, e.g. "2026-27" (April to March, IST). */
export function financialYear(date = new Date()) {
  const ist = new Date(new Date(date).getTime() + 330 * 60 * 1000);
  const year = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}
