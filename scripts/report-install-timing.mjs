import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Read timing JSON only. npm debug logs and timing metadata may contain credentials.
const context = {
  event: "npm-install-timing",
  schemaVersion: 1,
  revision: process.env.GITHUB_SHA,
  os: process.env.RUNNER_OS,
  concurrency: Number(process.env.PORTUS_TEST_CONCURRENCY),
  node: process.version,
  installOutcome: process.env.PORTUS_INSTALL_OUTCOME
};
const emit = (report) => console.log(JSON.stringify({ ...context, ...report }));
const validDuration = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

try {
  const logsDir = process.argv[2];
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const packages = new Set(Object.keys(lock.packages));
  const relevantPhase = (phase) => {
    if (/^(?:npm|command:ci|idealTree|reify|auditReport|build)(?::[A-Za-z][A-Za-z0-9]*)*$/.test(phase)) {
      return true;
    }
    const packagePhase = /^(?:build:run:(?:preinstall|install|postinstall|prepare)|build:link|reifyNode):(.+)$/.exec(phase);
    return packagePhase !== null && packages.has(packagePhase[1]);
  };
  let reports = 0;
  let unreadableFiles = 0;
  for (const filename of readdirSync(logsDir).filter((name) => name.endsWith("-timing.json")).sort()) {
    let timing;
    try {
      timing = JSON.parse(readFileSync(path.join(logsDir, filename), "utf8"));
    } catch {
      unreadableFiles += 1;
      continue;
    }
    const timers = timing.timers ?? {};
    const unfinished = timing.unfinishedTimers ?? {};
    // Native lifecycle scripts can invoke npm too. Do not confuse their timing files with npm ci.
    if (!Object.hasOwn(timers, "command:ci") && !Object.hasOwn(unfinished, "command:ci")) continue;
    const phases = Object.entries(timers)
      .filter(([phase, durationMs]) => relevantPhase(phase) && validDuration(durationMs))
      .map(([phase, durationMs]) => ({ phase, durationMs }))
      .sort((a, b) => b.durationMs - a.durationMs || a.phase.localeCompare(b.phase));
    const lifecycle = phases.filter(({ phase }) => phase.startsWith("build:run:"));
    const aggregate = phases.filter(({ phase }) => !phase.includes("node_modules/"));
    const slowPackages = phases.filter(({ phase }) => phase.startsWith("reifyNode:")).slice(0, 10);
    const slowBinLinks = phases.filter(({ phase }) => phase.startsWith("build:link:")).slice(0, 10);
    const unfinishedPhases = Object.entries(unfinished)
      .filter(([phase, interval]) => relevantPhase(phase) && Array.isArray(interval) && validDuration(interval[0]))
      .map(([phase, interval]) => ({ phase, startedAfterMs: interval[0] }));
    emit({
      status: "reported",
      aggregate,
      lifecycle,
      slowPackages,
      slowBinLinks,
      unfinishedPhases,
      // Timers overlap. Do not sum parent phases or concurrent package work.
      durationsOverlap: true
    });
    reports += 1;
  }
  if (reports === 0) emit({ status: "unavailable", reason: "no-ci-timing-file", unreadableFiles });
} catch {
  // Diagnostics must neither mask an install failure nor fail an otherwise successful job.
  emit({ status: "unavailable", reason: "timing-report-unreadable" });
}
