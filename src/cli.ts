#!/usr/bin/env node
import { Command } from "commander";
import { randomInt } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig, runtimePaths } from "./config.js";
import { techniqueSchema } from "./types.js";
import { agentSchema, agentProfile, agentLabel } from "./agents.js";
import { loadBatch, loadBatchHistory } from "./storage.js";
import { textReport, csvReport, renderReport } from "./display.js";
import { schedule } from "./schedule.js";
import { redact } from "./credentials.js";

const program = new Command()
  .name("tcb")
  .description("Point-in-time coding-agent GitHub tool-context benchmark")
  .version("0.1.0")
  .option(
    "--config <file>",
    "Benchmark configuration",
    fileURLToPath(new URL("../bench.json", import.meta.url)),
  )
  .option("--root <path>", "Private benchmark runtime/results root")
  .option("--auth-file <path>", "Existing OpenCode OAuth file to share; never copied")
  .showHelpAfterError();

async function context(command: Command) {
  const globals = z
    .object({ config: z.string(), root: z.string().optional(), authFile: z.string().optional() })
    .parse(command.optsWithGlobals());
  const paths = runtimePaths(globals.root);
  if (globals.authFile) paths.auth = resolve(globals.authFile);
  return { config: await loadConfig(resolve(globals.config)), paths };
}

const selectionSchema = z.object({
  repeats: z.coerce.number().int().min(1).max(10).optional(),
  seed: z.coerce.number().int().min(0).max(2147483647).optional(),
  techniques: z.string().default(techniqueSchema.options.join(",")),
  workloads: z.string().default("task,noop"),
  benchmark: z.literal("github").default("github"),
  agents: z.string().default(agentSchema.options.join(",")),
  tui: z.boolean().default(true),
});

function selected(command: Command, repeats: number) {
  const options = selectionSchema.parse(command.opts());
  return {
    ...options,
    repeats: options.repeats ?? repeats,
    seed: options.seed ?? randomInt(2147483647),
    agents: z
      .array(agentSchema)
      .min(1)
      .parse([...new Set(options.agents.split(","))])
      .sort(),
    techniques: z
      .array(techniqueSchema)
      .min(1)
      .parse([...new Set(options.techniques.split(","))]),
    workloads: z
      .array(z.enum(["task", "noop"]))
      .min(1)
      .parse([...new Set(options.workloads.split(","))]),
  };
}

function selectOptions(command: Command) {
  return command
    .option("--benchmark <name>", "Only github is implemented", "github")
    .option(
      "--agents <names>",
      "Comma-separated claude,codex,opencode",
      agentSchema.options.join(","),
    )
    .option(
      "--techniques <names>",
      "Comma-separated bash,mcp-raw,mcp-filter,mcp-filter-readonly",
      techniqueSchema.options.join(","),
    )
    .option("--workloads <names>", "Comma-separated task,noop", "task,noop")
    .option("--repeats <count>", "Attempts per combination (default from bench.json: 3)")
    .option("--seed <integer>", "Deterministic block-order seed");
}

program
  .command("doctor")
  .description("Check versions and existing subscription auth; no model calls")
  .option(
    "--agents <names>",
    "Comma-separated claude,codex,opencode",
    agentSchema.options.join(","),
  )
  .option(
    "--check-access",
    "Read Keychain, verify GitHub/MCP reads, and check isolated config/model catalog",
  )
  .action(async (_options: unknown, command: Command) => {
    const { config, paths } = await context(command);
    const options = z
      .object({ checkAccess: z.boolean().default(false), agents: z.string() })
      .parse(command.opts());
    const { doctor } = await import("./runner.js");
    console.log(
      (
        await doctor(
          config,
          paths,
          options.checkAccess,
          z
            .array(agentSchema)
            .min(1)
            .parse([...new Set(options.agents.split(","))]),
        )
      ).join("\n"),
    );
  });

selectOptions(
  program.command("plan").description("Show the schedule without credentials or model calls"),
).action(async (_options: unknown, command: Command) => {
  const { config } = await context(command);
  const options = selected(command, config.repeats);
  const trials = schedule(options.repeats, options.techniques, options.seed, options.agents).filter(
    (trial) => options.workloads.includes(trial.workload),
  );
  console.log(
    `${options.agents
      .map((agent) => {
        const profile = agentProfile(config, agent);
        return `${agentLabel(agent)} ${profile.version} | ${profile.model} (${profile.variant})`;
      })
      .join(
        "\n",
      )}\n${config.repository}:${config.branch} | ${trials.length} sessions | seed ${options.seed}\n`,
  );
  for (const trial of trials)
    console.log(
      `${trial.repetition}  ${trial.agent.padEnd(8)}  ${trial.technique.padEnd(19)}  ${trial.workload}`,
    );
  console.log(
    "\nNo model calls. A session can contain several model steps. Each technique fixes its MCP filtering/read-only configuration; all use the same restricted PAT.",
  );
});

selectOptions(
  program.command("run").description("Run fresh sessions serially using existing subscriptions"),
)
  .option("--no-tui", "Print final results without interactive terminal view")
  .action(async (_options: unknown, command: Command) => {
    const { config, paths } = await context(command);
    const options = selected(command, config.repeats);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const { run } = await import("./runner.js");
      const batch = await run(config, paths, {
        ...options,
        signal: controller.signal,
        progress: (message) => console.log(message),
      });
      if (options.tui && process.stdout.isTTY && process.stdin.isTTY && !controller.signal.aborted)
        await renderReport(batch, await loadBatchHistory(paths));
      else console.log(textReport(batch));
      console.log(`Results: ${paths.results}/${batch.manifest.id}`);
      if (controller.signal.aborted) process.exitCode = 130;
      else if (
        batch.results.length !== batch.manifest.schedule.length ||
        batch.results.some((result) => result.status !== "complete")
      )
        process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  });

program
  .command("view")
  .argument("[batch]", "Batch ID or latest", "latest")
  .option("--no-tui", "Plain text")
  .action(async (id: string, _options: unknown, command: Command) => {
    const globals = z
      .object({ root: z.string().optional(), tui: z.boolean() })
      .parse(command.optsWithGlobals());
    const paths = runtimePaths(globals.root);
    const batch = await loadBatch(paths, id);
    if (globals.tui && process.stdout.isTTY && process.stdin.isTTY)
      await renderReport(batch, await loadBatchHistory(paths));
    else console.log(textReport(batch));
  });

program
  .command("export")
  .argument("[batch]", "Batch ID or latest", "latest")
  .option("--format <format>", "csv or json", "csv")
  .action(async (id: string, _options: unknown, command: Command) => {
    const options = z
      .object({ root: z.string().optional(), format: z.enum(["csv", "json"]) })
      .parse(command.optsWithGlobals());
    const batch = await loadBatch(runtimePaths(options.root), id);
    console.log(options.format === "csv" ? csvReport(batch) : JSON.stringify(batch, null, 2));
  });

program
  .command("cleanup")
  .description("Preview cleanup of exact benchmark items; --apply is required to delete")
  .option("--credentials", "Delete only the registered benchmark GitHub Keychain item")
  .option(
    "--runtime",
    "Delete private attempts, native logs, saved results, and auth links (not shared auth)",
  )
  .option("--apply", "Perform the listed deletions")
  .action(async (_options: unknown, command: Command) => {
    const { config, paths } = await context(command);
    const options = z
      .object({
        credentials: z.boolean().default(false),
        runtime: z.boolean().default(false),
        apply: z.boolean().default(false),
      })
      .parse(command.opts());
    const { cleanup } = await import("./cleanup.js");
    console.log((await cleanup(config, paths, options)).join("\n"));
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(
    error instanceof z.ZodError
      ? "Invalid configuration or options. Check bench.json and --help."
      : redact(error instanceof Error ? error.message : "Benchmark failed."),
  );
  process.exitCode = 1;
}
