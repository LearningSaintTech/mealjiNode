// Summarises test-reports/load-cpu.cpuprofile: where the API spent its CPU time,
// by function (self time) and by source file (including node_modules packages).
import fs from "node:fs";

const profile = JSON.parse(fs.readFileSync(process.argv[2] || "test-reports/load-cpu.cpuprofile", "utf8"));
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const self = new Map();
const deltas = profile.timeDeltas;
profile.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + (deltas[i] || 0)));
const total = [...self.values()].reduce((a, b) => a + b, 0);

const fnTotals = new Map();
const fileTotals = new Map();
for (const [id, us] of self) {
  const frame = byId.get(id).callFrame;
  const file = frame.url.replace(/^file:\/\/\/?/, "").replace(/.*mealJiNode[\\/]/, "");
  const pkg = file.match(/node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/)?.[1];
  const fileKey = pkg ? `pkg:${pkg}` : file || `(${frame.functionName || "native"})`;
  const fnKey = `${frame.functionName || "(anonymous)"}  ${pkg ? `pkg:${pkg}` : file}:${frame.lineNumber + 1}`;
  fnTotals.set(fnKey, (fnTotals.get(fnKey) || 0) + us);
  fileTotals.set(fileKey, (fileTotals.get(fileKey) || 0) + us);
}
const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
console.log(`CPU profile: ${(total / 1e6).toFixed(1)} s sampled\n\nBy file / package (self time):`);
for (const [key, us] of top(fileTotals, 25)) console.log(`  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${key}`);
console.log("\nBy function (self time):");
for (const [key, us] of top(fnTotals, 30)) console.log(`  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${key}`);
