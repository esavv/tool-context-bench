import { mkdir, readFile, writeFile, rename, readdir, lstat, rm, open } from "node:fs/promises";
import { join, basename } from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Paths } from "./config.js";
import {
  manifestSchema,
  resultSchema,
  type Batch,
  type BatchHistory,
  type Result,
} from "./types.js";
import { sessionDetails } from "./session.js";

const owner = "tool-context-bench/v1";
const markerSchema = z.object({ owner: z.literal(owner) });
const usageCount = z.number().int().nonnegative();
const claudeRequestUsageSchema = z.object({
  freshInput: usageCount,
  cacheRead: usageCount,
  cacheWrite: usageCount,
  totalInput: usageCount,
  totalOutput: usageCount,
  totalTokens: usageCount,
  complete: z.literal(true),
});

async function recoverClaudeUsage(directory: string, result: Result): Promise<void> {
  if (result.trial.agent !== "claude" || result.metrics === null || result.metrics.complete) return;
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(directory, `${basename(result.trial.id)}.requests.json`), "utf8"),
    );
    const requests = z.array(claudeRequestUsageSchema).parse(raw);
    if (requests.length === 0) return;
    const sums = {
      freshInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalInput: 0,
      totalOutput: 0,
      totalTokens: 0,
    };
    for (const request of requests) {
      sums.freshInput += request.freshInput;
      sums.cacheRead += request.cacheRead;
      sums.cacheWrite += request.cacheWrite;
      sums.totalInput += request.totalInput;
      sums.totalOutput += request.totalOutput;
      sums.totalTokens += request.totalTokens;
    }
    if (
      result.metrics.steps === requests.length &&
      result.metrics.initialInput === requests[0]?.totalInput &&
      result.metrics.freshInput === sums.freshInput &&
      result.metrics.cacheRead === sums.cacheRead &&
      result.metrics.cacheWrite === sums.cacheWrite &&
      result.metrics.totalInput === sums.totalInput &&
      result.metrics.totalOutput === sums.totalOutput &&
      result.metrics.totalTokens === sums.totalTokens
    ) {
      result.metrics.complete = true;
      if (result.status === "usage-incomplete") result.status = "complete";
    }
  } catch {
    // Older or partial sidecars keep their original incomplete classification.
  }
}

export async function saveJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function ensureRoot(paths: Paths): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  if ((await lstat(paths.root)).isSymbolicLink())
    throw new Error("Runtime root must not be a symlink.");
  const entries = await readdir(paths.root);
  if (entries.length === 0) await saveJson(paths.marker, { owner });
  await verifyRoot(paths);
  await mkdir(paths.attempts, { recursive: true, mode: 0o700 });
  await mkdir(paths.results, { recursive: true, mode: 0o700 });
}

export async function verifyRoot(paths: Paths): Promise<void> {
  try {
    if ((await lstat(paths.root)).isSymbolicLink()) throw new Error();
    const value: unknown = JSON.parse(await readFile(paths.marker, "utf8"));
    markerSchema.parse(value);
  } catch {
    throw new Error("Runtime root is not a recognized benchmark directory.");
  }
}

export async function acquireLock(paths: Paths): Promise<() => Promise<void>> {
  let handle;
  try {
    handle = await open(paths.lock, "wx", 0o600);
  } catch {
    throw new Error(
      "Runtime is locked. Stop the other run, or remove the stale run.lock after checking its PID.",
    );
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await handle.close();
  return () => rm(paths.lock);
}

export async function loadBatch(paths: Paths, id: string): Promise<Batch> {
  await verifyRoot(paths);
  let selected = id;
  if (selected === "latest") {
    const entries = await readdir(paths.results, { withFileTypes: true });
    selected = "";
    for (const candidate of entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()) {
      try {
        await lstat(join(paths.results, candidate, "manifest.json"));
        selected = candidate;
        break;
      } catch {
        /* An interrupted setup may not have written a manifest yet. */
      }
    }
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(selected)) throw new Error("No valid result batch selected.");
  const directory = join(paths.results, selected);
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Result directory must not be a symlink.");
  const raw: unknown = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const manifestData = z.record(z.string(), z.unknown()).parse(raw);
  const legacyVersion = manifestData.schemaVersion;
  const legacy = legacyVersion === 1 || legacyVersion === 2;
  const renameTechnique = (value: unknown) =>
    value === "raw-mcp"
      ? legacyVersion === 1
        ? "mcp-filter-readonly"
        : "mcp-raw"
      : value === "mcp-repos"
        ? "mcp-filter"
        : value === "mcp-repos-readonly"
          ? "mcp-filter-readonly"
          : value;
  const upgradeTrial = (value: unknown) => {
    const trial = z.record(z.string(), z.unknown()).parse(value);
    if (trial.workload === "baseline") return null;
    return {
      ...trial,
      agent: "opencode",
      technique: renameTechnique(trial.technique),
    };
  };
  if (legacy) {
    // Version 1's raw-mcp was actually repos-filtered and read-only. Do not relabel its data as unfiltered MCP.
    const config = { ...z.record(z.string(), z.unknown()).parse(manifestData.config) };
    delete config.githubToolsets;
    manifestData.config = config;
    manifestData.schemaVersion = 5;
    manifestData.schedule = z
      .array(z.unknown())
      .parse(manifestData.schedule)
      .map(upgradeTrial)
      .filter((trial) => trial !== null);
    if (legacyVersion === 1) {
      manifestData.catalogs =
        typeof manifestData.catalogHash === "string"
          ? { "mcp-filter-readonly": { hash: manifestData.catalogHash, toolCount: null } }
          : {};
    } else {
      const catalogs = z.record(z.string(), z.unknown()).parse(manifestData.catalogs ?? {});
      manifestData.catalogs = Object.fromEntries(
        Object.entries(catalogs).map(([key, value]) => [String(renameTechnique(key)), value]),
      );
    }
  }
  if (legacyVersion === 3 || legacyVersion === 4) manifestData.schemaVersion = 5;
  const manifest = manifestSchema.parse(manifestData);
  const results = [];
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".result.json")) continue;
    const value: unknown = JSON.parse(await readFile(join(directory, basename(entry)), "utf8"));
    const data = z.record(z.string(), z.unknown()).parse(value);
    if (legacy) {
      const trial = upgradeTrial(data.trial);
      if (!trial) continue;
      data.trial = trial;
    }
    if ([1, 2, 3, 4].includes(Number(legacyVersion))) {
      const grading = z.record(z.string(), z.unknown()).safeParse(data.grading);
      if (grading.success) {
        delete grading.data.routeValid;
        data.grading = grading.data;
      }
      if (data.status === "invalid-route" || data.status === "invalid-schema") {
        const metrics = z.record(z.string(), z.unknown()).safeParse(data.metrics);
        data.status =
          metrics.success && metrics.data.complete === true ? "complete" : "usage-incomplete";
        if (grading.success)
          data.success = grading.data.schemaValid === true && grading.data.valueMatches === true;
      }
    }
    const result = resultSchema.parse(data);
    await recoverClaudeUsage(directory, result);
    if (!result.session) {
      const attemptDirectory = join(paths.attempts, `${selected}_${basename(result.trial.id)}`);
      let configuration: unknown;
      try {
        configuration = JSON.parse(await readFile(join(attemptDirectory, "bench.json"), "utf8"));
      } catch {
        /* Saved results remain viewable if native attempt files were removed. */
      }
      result.session = sessionDetails(attemptDirectory, configuration, manifest.config.variant);
    }
    results.push(result);
  }
  results.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { manifest, results };
}

export async function loadBatchHistory(paths: Paths): Promise<BatchHistory> {
  await verifyRoot(paths);
  const history: BatchHistory = { batches: [], unavailable: 0 };
  const entries = await readdir(paths.results, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      history.batches.push(await loadBatch(paths, entry.name));
    } catch {
      history.unavailable++;
    }
  }
  history.batches.sort(
    (a, b) =>
      b.manifest.createdAt.localeCompare(a.manifest.createdAt) ||
      b.manifest.id.localeCompare(a.manifest.id),
  );
  return history;
}
