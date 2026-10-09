// Runs the release-step tests against a running API and writes a report the
// app-integration PDF uses.
//
//   npm run test:steps -- 01 02 03 04     (no args = every step file present)
//
// Needs the seeded demo data and FIXED_OTP (development). Every record a test
// creates is removed again.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, mongoose } from "./steps/harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const available = fs.readdirSync(path.join(here, "steps")).map((file) => /^step(\d{2})\.js$/.exec(file)?.[1]).filter(Boolean).sort();
const wanted = process.argv.slice(2).map((arg) => arg.padStart(2, "0"));
const steps = wanted.length ? wanted.filter((step) => available.includes(step)) : available;

const ctx = { cleanups: [] };
const suites = [];
console.log(`Release-step tests against ${BASE}: steps ${steps.join(", ")}`);
try {
  for (const step of steps) {
    const run = (await import(`./steps/step${step}.js`)).default;
    console.log(`\nStep ${step}`);
    const suite = await run(ctx);
    console.log(`  ${suite.cases.filter((c) => c.ok).length}/${suite.cases.length} passed`);
    suites.push(suite);
    ctx.cleanups.push(...suite.cleanups);
  }
} finally {
  for (const undo of ctx.cleanups.reverse()) await undo().catch(() => {});
  await mongoose.disconnect().catch(() => {});
}

const report = {
  runAt: new Date().toISOString(),
  api: BASE,
  steps: suites.map((suite) => ({ step: suite.step, title: suite.title, passed: suite.cases.filter((c) => c.ok).length, total: suite.cases.length, cases: suite.cases })),
};
const outDir = path.join(here, "..", "test-reports");
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `steps-${steps.join("-")}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));

const all = suites.flatMap((suite) => suite.cases);
const failed = all.filter((c) => !c.ok);
console.log(`\n${all.length - failed.length}/${all.length} passed · report ${path.relative(process.cwd(), file)}`);
failed.forEach((c) => console.log(`  ✗ ${c.id} ${c.name}: ${c.detail}`));
process.exit(failed.length ? 1 : 0);
