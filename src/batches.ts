import type { Batch } from "./types.js";
import { agentLabel, agentProfile, type Agent } from "./agents.js";

export function batchAgentProfiles(batch: Batch): NonNullable<Batch["profiles"]> {
  if (batch.profiles) return batch.profiles;
  return [
    ...new Set(
      [...batch.manifest.schedule, ...batch.results.map((result) => result.trial)].map(
        (trial) => trial.agent,
      ),
    ),
  ]
    .sort()
    .map((agent) => ({
      agent,
      ...agentProfile(batch.manifest.config, agent),
      version: batch.manifest.versions[agent] ?? "unknown",
    }));
}

export function selectionProblem(batches: readonly Batch[]): string | null {
  const first = batches[0];
  if (!first || batches.length < 2) return null;
  const settings = (batch: Batch): Record<string, string | number> => ({
    "GitHub CLI version": batch.manifest.versions.gh,
    repository: batch.manifest.config.repository,
    branch: batch.manifest.config.branch,
    "fixture commit": batch.manifest.expected.sha,
    "step limit": batch.manifest.config.maxSteps,
    "timeout limit": batch.manifest.config.timeoutSeconds,
    "exposure evidence": batch.manifest.exposure,
  });
  const reference = settings(first);
  const hashes = new Map<string, string | undefined>();
  const profiles = new Map<Agent, ReturnType<typeof batchAgentProfiles>[number]>();
  for (const batch of batches) {
    const current = settings(batch);
    for (const [key, value] of Object.entries(reference)) {
      if (current[key] !== value)
        return `Cannot combine: ${key} differs. Deselect conflicting batches first.`;
    }
    for (const profile of batchAgentProfiles(batch)) {
      const previous = profiles.get(profile.agent);
      if (previous) {
        const keys: ("version" | "model" | "variant")[] = ["version", "model", "variant"];
        for (const key of keys) {
          if (
            previous[key] !== profile[key] ||
            (key === "version" && profile.version === "unknown")
          )
            return `Cannot combine: ${agentLabel(profile.agent)} ${key === "variant" ? "reasoning variant" : key} differs or is unrecorded. Deselect conflicting batches first.`;
        }
      }
      profiles.set(profile.agent, profile);
    }
    for (const technique of new Set(
      [...batch.manifest.schedule, ...batch.results.map((result) => result.trial)].map(
        (trial) => trial.technique,
      ),
    )) {
      if (technique === "bash") continue;
      const catalog = batch.manifest.catalogs[technique];
      const previous = hashes.get(technique);
      if (hashes.has(technique) && (!previous || !catalog))
        return `Cannot combine: ${technique} has no recorded catalog hash.`;
      if (previous && previous !== catalog?.hash)
        return `Cannot combine: ${technique} catalog hashes differ.`;
      hashes.set(technique, catalog?.hash);
    }
  }
  return null;
}

/** An in-memory view. Original batches, trial IDs, and files are not modified. */
export function combineBatches(batches: readonly Batch[], fallback: Batch): Batch {
  const unique = [...new Map(batches.map((batch) => [batch.manifest.id, batch])).values()];
  const problem = selectionProblem(unique);
  if (problem) throw new Error(problem);
  const first = unique[0] ?? fallback;
  const config = { ...first.manifest.config };
  const versions = { ...first.manifest.versions };
  for (const batch of unique) {
    for (const { agent } of batchAgentProfiles(batch)) {
      versions[agent] = batch.manifest.versions[agent];
      if (agent === "claude") {
        config.claudeVersion = batch.manifest.config.claudeVersion;
        config.claudeModel = batch.manifest.config.claudeModel;
      } else if (agent === "codex") {
        config.codexVersion = batch.manifest.config.codexVersion;
        config.codexModel = batch.manifest.config.codexModel;
      } else if (agent === "opencode2") {
        config.opencode2Version = batch.manifest.config.opencode2Version;
        config.model = batch.manifest.config.model;
      } else {
        config.opencodeVersion = batch.manifest.config.opencodeVersion;
        config.model = batch.manifest.config.model;
      }
    }
  }
  return {
    profiles: [
      ...new Map(
        unique.flatMap(batchAgentProfiles).map((profile) => [profile.agent, profile]),
      ).values(),
    ].sort((a, b) => a.agent.localeCompare(b.agent)),
    manifest: {
      ...first.manifest,
      config,
      versions,
      id:
        unique.length === 0
          ? "No batches selected"
          : unique.length === 1
            ? first.manifest.id
            : `${unique.length} selected batches`,
      schedule: unique.flatMap((batch) =>
        batch.manifest.schedule.map((trial) => ({
          ...trial,
          id: `${batch.manifest.id}/${trial.id}`,
        })),
      ),
      catalogs: unique.reduce<Batch["manifest"]["catalogs"]>(
        (catalogs, batch) => ({ ...catalogs, ...batch.manifest.catalogs }),
        {},
      ),
    },
    results: unique
      .flatMap((batch) =>
        batch.results.map((result) => ({
          ...result,
          trial: { ...result.trial, id: `${batch.manifest.id}/${result.trial.id}` },
          origin: { batchID: batch.manifest.id, trialID: result.trial.id },
        })),
      )
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
  };
}

export function batchFields(batch: Batch) {
  const date = new Date(batch.manifest.createdAt);
  const timestamp = Number.isNaN(date.valueOf())
    ? "unknown time"
    : date.toLocaleString("sv-SE", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZoneName: "short",
      });
  const workloads = new Set(batch.manifest.schedule.map((trial) => trial.workload));
  const workload =
    workloads.size > 1
      ? "both"
      : workloads.has("task")
        ? "task"
        : workloads.has("noop")
          ? "no-op"
          : "empty";
  const finished = batch.results.filter((result) => result.status !== "running").length;
  const repeats = batch.manifest.config.repeats;
  const agents = batchAgentProfiles(batch)
    .map(({ agent }) => agentLabel(agent))
    .join("/");
  return {
    timestamp,
    workload,
    agents: agents || "no agents",
    repeats,
    sessions: `${finished}/${batch.manifest.schedule.length}`,
    id: batch.manifest.id,
  };
}
