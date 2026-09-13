import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AgentUsage, PreparedAgent } from "./adapter.js";
import type { Config } from "./config.js";
import { EventCollector } from "./events.js";
import { execute, minimalEnvironment } from "./process.js";
import { suiteBinDirectory, type SuiteCredentials } from "./suite.js";
import type { Metrics, Trial } from "./types.js";

const object = z.record(z.string(), z.unknown());
const count = z.number().int().nonnegative();
const usageSchema = z.object({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  reasoning: count.optional(),
  totalTokens: count,
});

export async function piAuth(binary: string, config: Config): Promise<void> {
  const result = await execute(
    binary,
    ["auth", "check", "--model", config.piModel, "--json", "--no-refresh"],
    { env: minimalEnvironment() },
  );
  if (result.code !== 0 || result.stopped)
    throw new Error("Cannot confirm an existing pi subscription login.");
}

export async function preparePi(
  directory: string,
  config: Config,
  trial: Trial,
  credentials: SuiteCredentials,
): Promise<PreparedAgent> {
  if (trial.agent !== "pi" || trial.technique !== "bash")
    throw new Error("pi is supported only for suite Bash trials.");
  directory = resolve(directory);
  const cwd = join(directory, "work");
  const dataPath = join(directory, "pi-events.jsonl");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const events = new EventCollector(trial, credentials.github, Object.values(credentials));
  const requests: Array<z.infer<typeof usageSchema> & { model: string }> = [];
  const pending = new Map<string, { name: string; command?: string }>();
  return {
    directory,
    cwd,
    env: {
      ...minimalEnvironment(),
      PATH: `${suiteBinDirectory}:${minimalEnvironment().PATH}`,
      HOME: process.env.HOME,
      PWD: cwd,
      GH_TOKEN: credentials.github,
      SUPABASE_ACCESS_TOKEN: credentials.supabase,
      CLOUDFLARE_API_TOKEN: credentials.cloudflare,
      CLOUDFLARE_ACCOUNT_ID: config.suite?.cloudflare.accountId,
      STRIPE_API_KEY: credentials.stripe,
      PI_TELEMETRY: "0",
    },
    args: [
      "--model",
      config.piModel,
      "--thinking",
      config.variant,
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--tools",
      "bash",
      "--",
    ],
    promptArgument: true,
    collectWithoutSession: true,
    configPath: "native CLI flags",
    dataPath,
    dataKind: "jsonl",
    settings: [
      `pi ${config.piVersion}; model=${config.piModel}; thinking=${config.variant}.`,
      "Bash only; extensions, skills, templates, themes, context files, session persistence, and telemetry disabled.",
      "Fresh work directory; existing pi subscription state is reused.",
    ],
    events,
    onLine(line) {
      if (!line.trim()) return;
      try {
        const event = object.parse(JSON.parse(line));
        if (event.type === "tool_execution_start") {
          const id = z.string().parse(event.toolCallId);
          const args = object.parse(event.args);
          pending.set(id, {
            name: z.string().parse(event.toolName),
            ...(typeof args.command === "string" ? { command: args.command } : {}),
          });
        }
        if (event.type === "tool_execution_end") {
          const id = z.string().parse(event.toolCallId);
          const tool = pending.get(id);
          if (!tool) throw new Error();
          events.line(
            JSON.stringify({
              type: "tool_use",
              part: {
                id,
                tool: tool.name,
                state: { status: event.isError === true ? "error" : "completed", input: tool },
              },
            }),
          );
          pending.delete(id);
        }
        if (event.type === "message_end") {
          const message = object.parse(event.message);
          if (message.role !== "assistant") return;
          const usage = usageSchema.parse(message.usage);
          const provider = z.string().parse(message.provider);
          const model = `${provider}/${z.string().parse(message.responseModel ?? message.model)}`;
          requests.push({ ...usage, model });
          for (const content of z.array(object).parse(message.content))
            if (content.type === "text" && typeof content.text === "string")
              events.answer += content.text;
          if (message.stopReason === "error" || message.stopReason === "aborted")
            events.error = true;
        }
      } catch {
        events.malformed = true;
      }
    },
    async collect(): Promise<AgentUsage> {
      const metrics: Metrics = {
        initialInput: requests[0]
          ? requests[0].input + requests[0].cacheRead + requests[0].cacheWrite
          : null,
        totalInput: requests.reduce(
          (sum, request) => sum + request.input + request.cacheRead + request.cacheWrite,
          0,
        ),
        totalOutput: requests.reduce((sum, request) => sum + request.output, 0),
        totalTokens: requests.reduce((sum, request) => sum + request.totalTokens, 0),
        cacheRead: requests.reduce((sum, request) => sum + request.cacheRead, 0),
        cacheWrite: requests.reduce((sum, request) => sum + request.cacheWrite, 0),
        freshInput: requests.reduce((sum, request) => sum + request.input, 0),
        reasoning: requests.reduce((sum, request) => sum + (request.reasoning ?? 0), 0),
        steps: requests.length,
        complete: requests.length > 0 && !events.error && !events.malformed,
      };
      if (
        requests.some(
          (request) =>
            request.totalTokens !==
            request.input + request.cacheRead + request.cacheWrite + request.output,
        )
      )
        metrics.complete = false;
      return {
        metrics,
        requests,
        warnings: [
          "pi stdout reports provider-normalized request usage; output includes reasoning.",
        ],
        models: [...new Set(requests.map((request) => request.model))],
        artifactPath: dataPath,
      };
    },
    cleanup: async () => {},
  };
}
