import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AgentUsage, PreparedAgent } from "./adapter.js";
import { agentProfile } from "./agents.js";
import { configSchema, type Config } from "./config.js";
import { redact } from "./credentials.js";
import { EventCollector } from "./events.js";
import { MCP_URL, type Catalog } from "./github.js";
import { execute, minimalEnvironment } from "./process.js";
import { suiteBinDirectory, suiteServers, type SuiteCredentials } from "./suite.js";
import { mcpHeaders } from "./techniques.js";
import type { Benchmark, Trial } from "./types.js";

function claudeEnvironment(toolSearch = false): NodeJS.ProcessEnv {
  return {
    ...minimalEnvironment(),
    HOME: process.env.HOME ?? homedir(),
    USER: userInfo().username,
    LOGNAME: userInfo().username,
    ...(process.env.CLAUDE_CONFIG_DIR === undefined
      ? {}
      : { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }),
    ENABLE_TOOL_SEARCH: toolSearch ? "true" : "false",
    MCP_DISCOVERY_CACHE: "0",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    CLAUDE_CODE_DISABLE_SESSION_TITLE: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_COMPACT: "1",
  };
}

export async function claudeAuth(binary: string): Promise<void> {
  try {
    const result = await execute(binary, ["auth", "status", "--json"], {
      env: claudeEnvironment(),
    });
    if (result.code !== 0 || result.stopped) throw new Error();
    const raw: unknown = JSON.parse(result.stdout);
    const status = z.object({ loggedIn: z.boolean(), authMethod: z.string() }).parse(raw);
    if (!status.loggedIn)
      throw new Error(
        `Claude reports no active subscription login (loggedIn=${status.loggedIn}, authMethod=${status.authMethod}). Run claude auth login, then retry the benchmark.`,
      );
    if (status.authMethod !== "claude.ai") throw new Error();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Claude reports no active")) throw error;
    throw new Error(
      "Cannot confirm an existing Claude subscription login. Auth output was not displayed or exported.",
    );
  }
}

const objectSchema = z.record(z.string(), z.unknown());
function object(value: unknown): Record<string, unknown> {
  const parsed = objectSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

const count = z.number().int().nonnegative();
const usageSchema = z.object({
  input_tokens: count.optional(),
  output_tokens: count.optional(),
  cache_read_input_tokens: count.optional(),
  cache_creation_input_tokens: count.optional(),
});
type Usage = z.infer<typeof usageSchema>;
interface Request {
  id: string;
  model: string | null;
  usage: Usage;
  streamed: boolean;
  stopped: boolean;
}

function totals(usage: Usage) {
  const freshInput = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const totalInput = freshInput + cacheRead + cacheWrite;
  const totalOutput = usage.output_tokens ?? 0;
  return {
    freshInput,
    cacheRead,
    cacheWrite,
    totalInput,
    totalOutput,
    totalTokens: totalInput + totalOutput,
  };
}

export class ClaudeCollector {
  readonly events: EventCollector;
  private readonly requests = new Map<string, Request>();
  private readonly pending = new Map<string, { name: string; command?: string }>();
  private readonly completed = new Set<string>();
  private readonly warnings = new Set<string>();
  private active: Request | undefined;
  private finalUsage: Usage | undefined;
  private initialized = false;
  private finished = false;
  private incomplete = false;
  private fallbackAnswer = "";

  constructor(
    config: Config,
    private readonly trial: Trial,
    private readonly catalog: Catalog | undefined,
    private readonly token: string,
    sessionID: string,
    benchmark: Benchmark = "github",
    private readonly extraSecrets: string[] = [],
  ) {
    this.events = new EventCollector(
      config,
      trial,
      catalog?.names ?? [],
      token,
      catalog?.readOnlyNames ?? [],
      benchmark,
      extraSecrets,
    );
    this.events.sessionID = sessionID;
  }

  private warn(message: string): void {
    this.incomplete = true;
    this.warnings.add(message);
  }

  private usage(value: unknown): Usage | undefined {
    const parsed = usageSchema.safeParse(value);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      this.warn("Claude usage was missing or invalid.");
      return undefined;
    }
    return parsed.data;
  }

  private request(message: Record<string, unknown>, streamed: boolean): Request | undefined {
    if (typeof message.id !== "string" || !/^msg_[A-Za-z0-9_-]+$/.test(message.id)) {
      this.warn("Claude returned a request without a valid native message ID.");
      return undefined;
    }
    const previous = this.requests.get(message.id);
    if (previous) return previous;
    const model =
      typeof message.model === "string" && /^claude-[A-Za-z0-9_.-]+$/.test(message.model)
        ? message.model
        : null;
    if (model === null) this.warn("Claude did not report a native model ID.");
    const request: Request = { id: message.id, model, usage: {}, streamed, stopped: false };
    this.requests.set(request.id, request);
    return request;
  }

  private toolResult(id: string, failed: boolean): void {
    if (this.completed.has(id)) return;
    const tool = this.pending.get(id);
    if (!tool) {
      this.warn("Claude returned an unmatched tool result.");
      return;
    }
    this.events.line(
      JSON.stringify({
        type: "tool_use",
        sessionID: this.events.sessionID,
        part: {
          id: redact(id, [this.token, ...this.extraSecrets]),
          tool: redact(tool.name, [this.token, ...this.extraSecrets]),
          state: { status: failed ? "error" : "completed", input: { command: tool.command } },
        },
      }),
    );
    this.pending.delete(id);
    this.completed.add(id);
  }

  line(line: string): void {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.events.malformed = true;
      this.warn("Claude emitted malformed JSON.");
      return;
    }
    const event = object(raw);
    if (typeof event.type !== "string") {
      this.events.malformed = true;
      this.warn("Claude emitted an invalid event.");
      return;
    }
    if (event.session_id !== undefined && event.session_id !== this.events.sessionID) {
      this.events.malformed = true;
      this.warn("Claude reported an unexpected session ID.");
      return;
    }
    if (event.parent_tool_use_id != null) {
      this.events.invalidRoute = true;
      this.warn("Claude emitted a subagent event; request accounting is incomplete.");
    }
    if (
      event.type === "error" ||
      event.is_error === true ||
      event.error != null ||
      (Array.isArray(event.errors) && event.errors.length > 0)
    ) {
      this.events.error = true;
      this.warn("Claude reported an error; raw error content was not exported.");
    }
    if (event.type === "system" && event.subtype === "init") {
      this.initialized = true;
      const catalogTools = (this.catalog?.names ?? []).map((name) =>
        name.replace(/^([^_]+)_/, "mcp__$1__"),
      );
      const expected =
        this.trial.technique === "bash"
          ? ["Bash"]
          : this.trial.technique === "tool-search"
            ? ["ToolSearch", ...catalogTools]
            : catalogTools;
      const tools = Array.isArray(event.tools) ? event.tools : [];
      if (
        !Array.isArray(event.tools) ||
        expected.some((name) => !tools.includes(name)) ||
        tools.some((name) => typeof name !== "string" || !expected.includes(name))
      ) {
        this.warn("Claude init tools did not match the expected route catalog.");
      }
      for (const name of tools) {
        if (typeof name !== "string") continue;
        if (/tool.?search/i.test(name) && this.trial.technique !== "tool-search") {
          this.events.invalidRoute = true;
          this.warn("Claude tool search was observed despite being disabled.");
        }
        if (/code.?mode|execute.?code|executor/i.test(name)) {
          this.events.codeMode = true;
          this.events.invalidRoute = true;
          this.warn("Claude code mode was observed.");
        }
      }
      for (const field of ["plugins", "skills"]) {
        if (
          event[field] !== undefined &&
          (!Array.isArray(event[field]) || event[field].length > 0)
        ) {
          this.warn("Claude init reported unexpected plugins or skills.");
        }
      }
      if (event.slash_commands !== undefined) {
        const commands = Array.isArray(event.slash_commands) ? event.slash_commands : [];
        if (
          !Array.isArray(event.slash_commands) ||
          commands.some(
            (name) =>
              this.trial.technique === "bash" ||
              typeof name !== "string" ||
              !name.startsWith("mcp__"),
          )
        ) {
          this.warn("Claude init reported unexpected slash commands.");
        } else if (commands.length) {
          this.warnings.add(
            `Claude advertised ${commands.length} prompts from the configured GitHub MCP server; these are not tool search.`,
          );
        }
      }
      if (Array.isArray(event.mcp_servers)) {
        for (const value of event.mcp_servers) {
          const server = object(value);
          if (
            !["github", "supabase", "cloudflare", "stripe"].includes(String(server.name)) ||
            this.trial.technique === "bash" ||
            server.status !== "connected"
          )
            this.warn("Claude init reported an unexpected or disconnected MCP server.");
        }
      }
      if (this.trial.technique !== "bash" && !this.catalog?.names.length)
        this.warn("Claude MCP catalog is missing.");
      if (!this.incomplete)
        this.warnings.add(
          this.trial.technique === "tool-search"
            ? "Claude init confirmed native ToolSearch and the expected MCP callable inventory."
            : "Claude init confirmed the eager tool catalog with no ToolSearch.",
        );
      return;
    }
    if (event.type === "system" && /compact/.test(String(event.subtype)))
      this.warn("Claude compaction was observed despite being disabled.");
    if (event.type === "stream_event") {
      const stream = object(event.event);
      if (stream.type === "message_start") {
        if (this.active) this.warn("Claude request streams overlapped or lacked message_stop.");
        const message = object(stream.message);
        const request = this.request(message, true);
        this.active = request;
        if (request?.stopped) this.warn("Claude restarted an already completed request stream.");
        if (request && !request.stopped) {
          request.streamed = true;
          request.usage = { ...request.usage, ...this.usage(message.usage) };
        }
      } else if (stream.type === "message_delta") {
        if (!this.active) this.warn("Claude usage delta had no matching request.");
        else if (!this.active.stopped && stream.usage !== undefined)
          this.active.usage = { ...this.active.usage, ...this.usage(stream.usage) };
      } else if (stream.type === "message_stop") {
        if (!this.active) this.warn("Claude message_stop had no matching request.");
        else this.active.stopped = true;
        this.active = undefined;
      } else if (stream.type === "error") {
        this.events.error = true;
        this.warn("Claude reported a stream error; raw error content was not exported.");
      }
      return;
    }
    if (event.type === "assistant") {
      const message = object(event.message);
      const request = this.request(message, false);
      // Assembled messages can carry placeholder usage after the complete stream.
      if (request && !request.streamed && !request.stopped) {
        request.usage = { ...request.usage, ...this.usage(message.usage) };
        request.stopped = typeof message.stop_reason === "string";
      }
      const text: string[] = [];
      for (const value of Array.isArray(message.content) ? message.content : []) {
        const block = object(value);
        if (block.type === "text" && typeof block.text === "string") text.push(block.text);
        if (block.type !== "tool_use") continue;
        if (typeof block.id !== "string" || typeof block.name !== "string") {
          this.warn("Claude emitted an invalid tool call.");
          continue;
        }
        const name = block.name === "Bash" ? "bash" : block.name.replace(/^mcp__([^_]+)__/, "$1_");
        if (
          this.trial.technique === "bash"
            ? name !== "bash"
            : name !== "ToolSearch" && !this.catalog?.names.includes(name)
        )
          this.warn("Claude called a tool outside the expected catalog.");
        if (/tool.?search/i.test(name) && this.trial.technique !== "tool-search") {
          this.events.invalidRoute = true;
          this.warn("Claude tool search was observed despite being disabled.");
        }
        if (/code.?mode|execute.?code|executor/i.test(name)) {
          this.events.codeMode = true;
          this.events.invalidRoute = true;
          this.warn("Claude code mode was observed.");
        }
        if (!this.completed.has(block.id) && !this.pending.has(block.id)) {
          const input = object(block.input);
          this.pending.set(block.id, {
            name,
            ...(typeof input.command === "string" ? { command: input.command } : {}),
          });
        }
      }
      if (text.length)
        this.fallbackAnswer = redact(text.join(""), [this.token, ...this.extraSecrets]);
      return;
    }
    if (event.type === "user") {
      const message = object(event.message);
      for (const value of Array.isArray(message.content) ? message.content : []) {
        const block = object(value);
        if (block.type !== "tool_result") continue;
        if (typeof block.tool_use_id === "string")
          this.toolResult(block.tool_use_id, block.is_error === true);
        else this.warn("Claude returned a tool result without a tool call ID.");
      }
      return;
    }
    if (event.type === "result") {
      if (this.finished) this.warn("Claude emitted more than one final result.");
      this.finished = true;
      this.finalUsage = this.usage(event.usage);
      if (event.subtype !== "success" || event.is_error === true) {
        this.events.error = true;
        this.warn("Claude did not report a successful final result; raw errors were not exported.");
      }
      this.events.answer =
        event.subtype === "success" && !this.events.error && typeof event.result === "string"
          ? redact(event.result, [this.token, ...this.extraSecrets])
          : this.fallbackAnswer;
      if (typeof event.result !== "string") this.warn("Claude final answer was missing.");
      if (Array.isArray(event.permission_denials) && event.permission_denials.length > 0) {
        this.events.invalidRoute = true;
        this.warn("Claude reported denied tool permissions.");
      }
    }
  }

  collect(): AgentUsage {
    if (!this.initialized) this.warn("Claude init evidence is missing.");
    if (!this.finished) {
      this.warn("Claude final result is missing.");
      this.events.answer = this.fallbackAnswer;
    }
    if (this.pending.size) {
      this.warn("Claude finished with unresolved tool calls.");
      this.events.error = true;
      for (const id of this.pending.keys()) this.toolResult(id, true);
    }
    const requests = [...this.requests.values()];
    if (
      !requests.length ||
      requests.some(
        (request) =>
          !request.stopped ||
          request.usage.input_tokens === undefined ||
          request.usage.output_tokens === undefined,
      )
    )
      this.warn("Claude request usage or request finality is incomplete.");
    const sum = totals({});
    for (const request of requests) {
      const value = totals(request.usage);
      sum.freshInput += value.freshInput;
      sum.cacheRead += value.cacheRead;
      sum.cacheWrite += value.cacheWrite;
      sum.totalInput += value.totalInput;
      sum.totalOutput += value.totalOutput;
      sum.totalTokens += value.totalTokens;
    }
    let aggregate = sum;
    if (
      this.finalUsage?.input_tokens !== undefined &&
      this.finalUsage.output_tokens !== undefined
    ) {
      aggregate = totals(this.finalUsage);
      if (
        sum.freshInput !== aggregate.freshInput ||
        sum.cacheRead !== aggregate.cacheRead ||
        sum.cacheWrite !== aggregate.cacheWrite ||
        sum.totalOutput !== aggregate.totalOutput
      )
        this.warn(
          "Claude final usage differs from observed requests; unmatched request usage is unknown.",
        );
    } else this.warn("Claude final usage totals are incomplete.");
    this.warnings.add(
      "Claude does not report a separate reasoning token count; reasoning is 0 and output includes reasoning.",
    );
    return {
      metrics: {
        ...aggregate,
        initialInput:
          requests[0]?.usage.input_tokens === undefined
            ? null
            : totals(requests[0].usage).totalInput,
        reasoning: 0,
        steps: requests.length,
        complete: !this.incomplete && !this.events.malformed && !this.events.error,
      },
      requests: requests.map((request) => ({
        id: redact(request.id, [this.token, ...this.extraSecrets]),
        model:
          request.model === null ? null : redact(request.model, [this.token, ...this.extraSecrets]),
        ...totals(request.usage),
        complete:
          request.stopped &&
          request.usage.input_tokens !== undefined &&
          request.usage.output_tokens !== undefined,
      })),
      models: [
        ...new Set(
          requests.flatMap((request) =>
            request.model === null
              ? []
              : [redact(request.model, [this.token, ...this.extraSecrets])],
          ),
        ),
      ],
      warnings: [...this.warnings],
    };
  }
}

export async function prepareClaude(
  directory: string,
  config: Config,
  trial: Trial,
  catalog: Catalog | undefined,
  token: string,
  benchmark: Benchmark = "github",
  credentials?: SuiteCredentials,
): Promise<PreparedAgent> {
  config = configSchema.parse(config);
  if (trial.agent !== "claude") throw new Error("Expected a Claude trial.");
  if (trial.technique !== "bash" && !catalog?.names.length)
    throw new Error("Claude MCP requires a catalog.");
  directory = resolve(directory);
  const cwd = join(directory, "work");
  const configPath = join(directory, "claude-settings.json");
  const mcpPath = join(directory, "claude-mcp.json");
  const dataPath = join(directory, "claude-events.jsonl");
  for (const child of ["work", "tmp", "gh"])
    await mkdir(join(directory, child), { recursive: true, mode: 0o700 });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        disableAllHooks: true,
        enabledPlugins: {},
        autoMemoryEnabled: false,
        claudeMdExcludes: ["**"],
        enableAllProjectMcpServers: false,
        attribution: { commit: "", pr: "" },
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    mcpPath,
    JSON.stringify(
      {
        mcpServers:
          trial.technique === "bash"
            ? {}
            : benchmark === "suite" && credentials
              ? Object.fromEntries(
                  Object.entries(
                    suiteServers(config, trial.technique, {
                      github: "${BENCH_GITHUB_TOKEN}",
                      supabase: "${BENCH_SUPABASE_TOKEN}",
                      cloudflare: "${BENCH_CLOUDFLARE_TOKEN}",
                      stripe: "${BENCH_STRIPE_TOKEN}",
                    }),
                  ).map(([name, server]) => [name, { type: "http", ...server }]),
                )
              : {
                  github: {
                    type: "http",
                    url: MCP_URL,
                    headers: mcpHeaders(trial.technique, "${BENCH_GITHUB_TOKEN}"),
                  },
                },
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  const profile = agentProfile(config, "claude");
  const sessionID = randomUUID();
  const collector = new ClaudeCollector(
    config,
    trial,
    catalog,
    token,
    sessionID,
    benchmark,
    credentials ? Object.values(credentials) : [],
  );
  // Match the other harnesses' CLI surface; the restricted PAT remains the remote write boundary.
  const allowed =
    trial.technique === "bash"
      ? [
          "Bash(gh api *)",
          "Bash(gh repo view *)",
          "Bash(jq *)",
          "Bash(gh --help)",
          "Bash(gh help api)",
          "Bash(gh help repo)",
          "Bash(gh api --help)",
          ...(benchmark === "suite"
            ? [
                "Bash(supabase functions list *)",
                "Bash(wrangler d1 list *)",
                "Bash(stripe webhook_endpoints list *)",
                "Bash(stripe webhook_endpoints retrieve *)",
              ]
            : []),
        ]
      : trial.technique === "tool-search"
        ? [
            "ToolSearch",
            "mcp__github__*",
            "mcp__supabase__*",
            "mcp__cloudflare__*",
            "mcp__stripe__*",
          ]
        : benchmark === "suite"
          ? ["mcp__github__*", "mcp__supabase__*", "mcp__cloudflare__*", "mcp__stripe__*"]
          : ["mcp__github__*"];
  return {
    directory,
    cwd,
    configPath,
    dataPath,
    dataKind: "jsonl",
    env: {
      ...claudeEnvironment(trial.technique === "tool-search"),
      ...(benchmark === "suite"
        ? { PATH: `${suiteBinDirectory}:${claudeEnvironment().PATH}` }
        : {}),
      TMPDIR: join(directory, "tmp"),
      PWD: cwd,
      GH_CONFIG_DIR: join(directory, "gh"),
      GH_PROMPT_DISABLED: "1",
      GH_HOST: "github.com",
      ...(trial.technique === "bash" ? { GH_TOKEN: token } : { BENCH_GITHUB_TOKEN: token }),
      ...(credentials
        ? {
            BENCH_SUPABASE_TOKEN: credentials.supabase,
            BENCH_CLOUDFLARE_TOKEN: credentials.cloudflare,
            BENCH_STRIPE_TOKEN: credentials.stripe,
            ...(trial.technique === "bash"
              ? {
                  SUPABASE_ACCESS_TOKEN: credentials.supabase,
                  CLOUDFLARE_API_TOKEN: credentials.cloudflare,
                  CLOUDFLARE_ACCOUNT_ID: config.suite?.cloudflare.accountId,
                  STRIPE_API_KEY: credentials.stripe,
                }
              : {}),
          }
        : {}),
    },
    args: [
      "--setting-sources",
      "",
      "--settings",
      configPath,
      "--strict-mcp-config",
      "--mcp-config",
      mcpPath,
      "--tools",
      trial.technique === "bash" ? "Bash" : trial.technique === "tool-search" ? "ToolSearch" : "",
      "--allowedTools",
      ...allowed,
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--disable-slash-commands",
      "--prompt-suggestions",
      "false",
      "--no-chrome",
      "--no-session-persistence",
      "--include-partial-messages",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      profile.model,
      "--effort",
      profile.variant,
      "--max-turns",
      String(config.maxSteps),
      "--session-id",
      sessionID,
      "--print",
    ],
    settings: [
      `Claude Code ${profile.version}; model ${profile.model}; effort ${profile.variant}; max-turns ${config.maxSteps}.`,
      `MCP configuration: ${mcpPath}`,
      "Fresh work, temporary, and GitHub config directories; original HOME and CLAUDE_CONFIG_DIR preserve the stored subscription login.",
      "Shared Claude app state remains in use. Settings sources are empty; explicit settings disable hooks, plugins, and auto memory; CLAUDE.md discovery is disabled. Managed policy can still apply.",
      "No login copies, new Keychain, API keys, or bare mode. Existing global app state and subscription auth can refresh or change during a run.",
      trial.technique === "tool-search"
        ? "Strict explicit MCP config; native ToolSearch enabled with MCP_DISCOVERY_CACHE=0. Init and runtime evidence are checked by the collector."
        : "Strict explicit MCP config; eager tools with ENABLE_TOOL_SEARCH=false and MCP_DISCOVERY_CACHE=0. Init must include all expected tools and no ToolSearch; runtime evidence is checked by the collector.",
      "Terminal title, background tasks, nonessential traffic, updates, and compaction are disabled; permission prompts, slash commands, suggestions, and Chrome are disabled.",
      "Native stream-json stdout is captured as redacted JSONL by the runner, not SQLite. Session persistence is disabled; no daily transcript cleanup is performed.",
    ],
    events: collector.events,
    onLine: (line) => collector.line(line),
    collect: async () => ({ ...collector.collect(), artifactPath: dataPath }),
    cleanup: async () => {},
  };
}
