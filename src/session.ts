import { join } from "node:path";
import { z } from "zod";
import type { Result } from "./types.js";

export function sessionDetails(
  directory: string,
  configuration: unknown,
  variant: string,
): NonNullable<Result["session"]> {
  const paths = {
    configPath: join(directory, "bench.json"),
    databasePath: join(directory, "data", "opencode", "bench.db"),
    workDirectory: join(directory, "work"),
  };
  const decoded = z
    .object({
      model: z.string(),
      plugin: z.array(z.unknown()),
      instructions: z.array(z.string()),
      subagent_depth: z.number(),
      compaction: z.object({ auto: z.boolean(), prune: z.boolean() }),
      agent: z.object({
        bench: z.object({ steps: z.number(), permission: z.record(z.string(), z.unknown()) }),
      }),
      mcp: z.object({
        github: z
          .object({ enabled: z.boolean(), headers: z.record(z.string(), z.string()) })
          .optional(),
      }),
    })
    .safeParse(configuration);
  if (!decoded.success)
    return {
      ...paths,
      settings: [
        "Generated configuration is unavailable; paths show the recorded attempt location.",
      ],
    };
  const config = decoded.data;
  const github = config.mcp.github;
  const tools = Object.keys(config.agent.bench.permission).filter((name) =>
    name.startsWith("github_"),
  );
  return {
    ...paths,
    settings: [
      `Model: ${config.model}; reasoning variant: ${variant}`,
      `MCP: ${github?.enabled ? "enabled" : "disabled"}`,
      `Toolset filter: ${github ? (github.headers["X-MCP-Toolsets"] ?? "none") : "not applicable"}`,
      `MCP read-only mode: ${github ? (github.headers["X-MCP-Readonly"] === "true" ? "enabled" : "disabled") : "not applicable"}`,
      `Tool definitions: ${github ? `${tools.length} GitHub MCP tools (eager)` : "bash; no MCP tools"}`,
      `Additional instructions: ${config.instructions.length}; external plugins: ${config.plugin.length} (--pure)`,
      `Subagent depth: ${config.subagent_depth}; maximum steps: ${config.agent.bench.steps}`,
      `Automatic compaction: ${config.compaction.auto ? "enabled" : "disabled"}; pruning: ${config.compaction.prune ? "enabled" : "disabled"}`,
      "Model auth: shared ChatGPT subscription; GitHub auth: benchmark PAT (value omitted)",
    ],
  };
}
