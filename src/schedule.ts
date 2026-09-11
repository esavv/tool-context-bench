import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import type { Benchmark, Technique, Trial } from "./types.js";
import type { Agent } from "./agents.js";
import { suitePrompt } from "./suite.js";

export function schedule(
  repeats: number,
  techniques: Technique[],
  seed: number,
  agents: Agent[] = ["opencode"],
  benchmark: Benchmark = "github",
): Trial[] {
  const trials: Trial[] = [];
  for (let repetition = 1; repetition <= repeats; repetition++) {
    const workloads: Trial["workload"][] = ["task", "noop"];
    const block: Trial[] = agents.flatMap((agent) =>
      techniques
        .filter((technique) => benchmark !== "suite" || agent !== "pi" || technique === "bash")
        .flatMap((technique) =>
          workloads.map((workload): Trial => {
            return {
              id: `${agent}-${technique}-${workload}-${repetition}`,
              agent,
              technique,
              workload,
              repetition,
            };
          }),
        ),
    );
    const hash = (trial: Trial) => createHash("sha256").update(`${seed}:${trial.id}`).digest("hex");
    block.sort((a, b) => hash(a).localeCompare(hash(b)));
    trials.push(...block);
  }
  return trials;
}

export function prompt(config: Config, trial: Trial, benchmark: Benchmark = "github"): string {
  if (benchmark === "suite") {
    // Keep the suite prompt with its fixture schema and route definitions.
    return suitePrompt(config, trial);
  }
  if (trial.workload !== "task") return "Reply with exactly OK. Do not call any tools.";
  const route =
    trial.technique === "bash"
      ? "Use only gh CLI read commands for remote service access. Do not use MCP, git, curl, SDKs, or change authentication."
      : "Use only the configured GitHub MCP tools for remote service access. Do not use bash, gh, git, curl, or SDKs.";
  return `Read the tip commit on branch ${config.branch} in GitHub repository ${config.repository}.
Return one JSON object with sha (full SHA), subject (first line of the commit message), committed_at (committer timestamp), and source_url (commit URL).
Use remote service data. Do not use a local repository or change any data.
${route}`;
}
