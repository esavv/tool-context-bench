import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "shell-quote";
import { z } from "zod";
import type { AgentUsage, PreparedAgent } from "./adapter.js";
import type { Config } from "./config.js";
import { EventCollector } from "./events.js";
import { MCP_URL, type Catalog } from "./github.js";
import { minimalEnvironment } from "./process.js";
import { techniqueSettings } from "./techniques.js";
import type { Metrics, Trial } from "./types.js";

const catalogSource =
  "https://raw.githubusercontent.com/openai/codex/b1a547b1f73ce86205d9222ac19cff334b3b7a2e/codex-rs/models-manager/models.json";
const object = z.record(z.string(), z.unknown());
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({
  input_tokens: count,
  cached_input_tokens: count,
  cache_write_input_tokens: count.default(0),
  output_tokens: count,
  reasoning_output_tokens: count,
  total_tokens: count,
});
type Usage = z.infer<typeof usageSchema>;

function authPath(): string {
  return resolve(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

async function inspectAuth(path: string): Promise<void> {
  try {
    if (!(await lstat(await realpath(path))).isFile()) throw new Error();
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    z.object({
      auth_mode: z.literal("chatgpt").optional(),
      OPENAI_API_KEY: z.union([z.null(), z.literal("")]).optional(),
      tokens: z.object({
        id_token: z.string().min(1),
        access_token: z.string().min(1),
        refresh_token: z.string().min(1),
      }),
    }).parse(value);
  } catch {
    throw new Error(
      "Codex requires an existing file-backed ChatGPT token login, not API-key auth. Auth values were not displayed.",
    );
  }
}

export async function codexAuth(): Promise<void> {
  await inspectAuth(authPath());
}

async function containedPath(root: string, path: string): Promise<string> {
  const actual = await realpath(path);
  const child = relative(await realpath(root), actual);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("Codex artifact is outside its private runtime.");
  return actual;
}

export async function prepareCodex(
  directory: string,
  config: Config,
  trial: Trial,
  catalog: Catalog | undefined,
  token: string,
): Promise<PreparedAgent> {
  if (config.codexVersion !== "0.153.3" || config.codexModel !== "gpt-5.6-terra")
    throw new Error("Codex requires version 0.153.3 and gpt-5.6-terra.");
  const sourceAuth = authPath();
  await inspectAuth(sourceAuth);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runtime = await mkdtemp(join(resolve(directory), "codex-"));
  const home = join(runtime, "home");
  const codexHome = join(home, ".codex");
  const cwd = join(runtime, "work");
  for (const path of [
    home,
    codexHome,
    cwd,
    ...["config", "data", "cache", "state", "tmp", "gh"].map((name) => join(runtime, name)),
  ])
    await mkdir(path, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...minimalEnvironment(),
    HOME: home,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(runtime, "config"),
    XDG_DATA_HOME: join(runtime, "data"),
    XDG_CACHE_HOME: join(runtime, "cache"),
    XDG_STATE_HOME: join(runtime, "state"),
    TMPDIR: join(runtime, "tmp"),
    PWD: cwd,
    GH_CONFIG_DIR: join(runtime, "gh"),
    GH_PROMPT_DISABLED: "1",
    GH_HOST: "github.com",
    ...(trial.technique === "bash" ? { GH_TOKEN: token } : { BENCH_GITHUB_TOKEN: token }),
  };

  // Fetch only during preparation. Keep every upstream model field, including Responses Lite.
  let source: string;
  let terra: Record<string, unknown>;
  try {
    const response = await fetch(catalogSource, {
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error();
    source = await response.text();
    const raw: unknown = JSON.parse(source);
    const models = z.object({ models: z.array(object) }).parse(raw).models;
    const matches = models.filter((model) => model.slug === config.codexModel);
    const model = matches[0];
    if (
      matches.length !== 1 ||
      !model ||
      typeof model.tool_mode !== "string" ||
      typeof model.supports_search_tool !== "boolean" ||
      typeof model.use_responses_lite !== "boolean"
    )
      throw new Error();
    terra = { ...model, tool_mode: "direct", supports_search_tool: false };
  } catch {
    throw new Error("Cannot load the pinned Codex Terra model descriptor. No substitute was used.");
  }
  const modelPath = join(codexHome, "models.json");
  const modified = `${JSON.stringify({ models: [terra] }, null, 2)}\n`;
  const sourceSHA = createHash("sha256").update(source).digest("hex");
  const modifiedSHA = createHash("sha256").update(modified).digest("hex");
  await writeFile(modelPath, modified, { mode: 0o600, flag: "wx" });
  const exposure = techniqueSettings(trial.technique);
  const bash = trial.technique === "bash";
  const configPath = join(codexHome, "config.toml");
  const settings = [
    `Codex ${config.codexVersion}; model=${config.codexModel}; reasoning=${config.variant}`,
    `model_catalog_json=${modelPath}`,
    `model catalog source=${catalogSource}; sourceSHA256=${sourceSHA}; modifiedSHA256=${modifiedSHA}`,
    "Terra descriptor preserved except tool_mode=direct and supports_search_tool=false; use_responses_lite unchanged.",
    "Native Terra code_mode_only overrides feature flags; the model catalog override is required.",
    "Direct MCP definitions are not filtered by enabled_tools; deferred and code_mode surfaces are omitted.",
    "Private HOME, XDG directories and regular HOME/.codex; original auth symlink permits normal token refresh writes.",
    "Project documents, bundled skills, apps, plugins, hooks, memories, search and Code Mode disabled; login shells disabled.",
    `approval_policy=never; sandbox=${bash ? "workspace-write; network_access=true for gh" : "read-only; shell_tool=false"}`,
    "Source-verified settings, not a live request capture; native response usage is best effort.",
  ];
  const disabled = [
    "code_mode",
    "code_mode_only",
    "code_mode_host",
    "code_mode_prewarm",
    "standalone_web_search",
    "apps",
    "enable_mcp_apps",
    "plugins",
    "remote_plugin",
    "plugin_sharing",
    "tool_suggest",
    "recommended_plugins",
    "hooks",
    "memories",
    "external_agent_memory_import",
    "skill_search",
    "skill_mcp_dependency_install",
    "multi_agent",
    "multi_agent_v2",
    "shell_snapshot",
    "shell_snapshot_v2",
    "view_image",
    "image_generation",
    "sleep_tool",
    "goals",
    "context_management",
    "workspace_dependencies",
    "guardian_approval",
  ];
  const toml = [
    `model = ${JSON.stringify(config.codexModel)}`,
    'model_provider = "openai"',
    `model_reasoning_effort = ${JSON.stringify(config.variant)}`,
    `model_catalog_json = ${JSON.stringify(modelPath)}`,
    'forced_login_method = "chatgpt"',
    'cli_auth_credentials_store = "file"',
    'mcp_oauth_credentials_store = "file"',
    'approval_policy = "never"',
    `sandbox_mode = "${bash ? "workspace-write" : "read-only"}"`,
    'web_search = "disabled"',
    "project_doc_max_bytes = 0",
    "project_root_markers = []",
    "allow_login_shell = false",
    "check_for_update_on_startup = false",
    "[features]",
    `shell_tool = ${bash}`,
    ...disabled.map((name) => `${name} = false`),
    "[shell_environment_policy]",
    'inherit = "all"',
    `ignore_default_excludes = ${bash}`,
    `include_only = ${JSON.stringify(Object.keys(env).filter((key) => key !== "BENCH_GITHUB_TOKEN"))}`,
    "[skills.bundled]",
    "enabled = false",
    "[memories]",
    "generate_memories = false",
    "use_memories = false",
    ...(bash
      ? [
          "[sandbox_workspace_write]",
          "network_access = true",
          "exclude_slash_tmp = true",
          "exclude_tmpdir_env_var = true",
        ]
      : []),
    ...(exposure.mcpEnabled
      ? [
          "[mcp_servers.github]",
          `url = ${JSON.stringify(MCP_URL)}`,
          "enabled = true",
          "required = true",
          'bearer_token_env_var = "BENCH_GITHUB_TOKEN"',
          'omit_tools_from = ["deferred", "code_mode"]',
          ...(exposure.toolsets || exposure.readOnly
            ? [
                "[mcp_servers.github.http_headers]",
                ...(exposure.toolsets
                  ? [`"X-MCP-Toolsets" = ${JSON.stringify(exposure.toolsets)}`]
                  : []),
                ...(exposure.readOnly ? ['"X-MCP-Readonly" = "true"'] : []),
              ]
            : []),
        ]
      : []),
    "",
  ].join("\n");
  await writeFile(configPath, toml, { mode: 0o600, flag: "wx" });
  await writeFile(
    join(codexHome, "catalog-evidence.json"),
    `${JSON.stringify({ source: catalogSource, sourceSHA256: sourceSHA, modifiedSHA256: modifiedSHA, model: config.codexModel, changes: { tool_mode: "direct", supports_search_tool: false } }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  const authLink = join(codexHome, "auth.json");
  await symlink(sourceAuth, authLink);
  const events = new EventCollector(
    config,
    trial,
    catalog?.names ?? [],
    token,
    catalog?.readOnlyNames ?? [],
  );
  const stdoutUsage: unknown[] = [];
  const seenItems = new Set<string>();
  const dataPath = join(codexHome, "state_5.sqlite");
  const observeNativeTool = (name: string): boolean => {
    if (name.startsWith("github_")) return false;
    const code = /code.?mode|execute.?code|executor|node_repl|cua_repl/.test(name);
    if (!code && !/^(?:tool_search|web_search)(?:_call)?$/.test(name)) return false;
    events.codeMode ||= code;
    events.invalidRoute = true;
    const warning = "Codex search or Code Mode use was observed despite direct-tool settings.";
    if (!events.warnings.includes(warning)) events.warnings.push(warning);
    return true;
  };
  return {
    directory,
    cwd,
    env,
    configPath,
    dataPath,
    dataKind: "sqlite",
    settings,
    events,
    args: [
      "exec",
      "--json",
      "--strict-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--cd",
      cwd,
      "-",
    ],
    onLine(line) {
      if (!line.trim()) return;
      try {
        const raw: unknown = JSON.parse(line);
        const event = z
          .object({
            type: z.string(),
            thread_id: z.string().optional(),
            item: object.optional(),
            usage: z.unknown().optional(),
          })
          .parse(raw);
        if (event.type === "thread.started") {
          if (!event.thread_id) events.malformed = true;
          else events.line(JSON.stringify({ type: "session", sessionID: event.thread_id }));
        }
        if (event.type === "turn.completed") stdoutUsage.push(event.usage);
        if (event.type === "error" || event.type === "turn.failed") {
          events.error = true;
          events.warnings.push(
            "Codex reported an error or failed turn; raw error content was not exported.",
          );
        }
        if (event.type !== "item.completed") return;
        const item = event.item;
        if (!item || typeof item.type !== "string" || typeof item.id !== "string") {
          events.malformed = true;
          return;
        }
        if (item.type === "agent_message" && typeof item.text === "string") {
          events.answer = "";
          // Final messages can repeat an item ID; the last completed text is authoritative.
          events.line(JSON.stringify({ type: "text", part: { text: item.text } }));
          return;
        }
        if (seenItems.has(item.id)) return;
        seenItems.add(item.id);
        if (item.type === "reasoning") return;
        if (item.type === "error") {
          events.error = true;
          events.warnings.push("Codex reported an item error; raw error content was not exported.");
          return;
        }
        let name = item.type;
        let command = typeof item.command === "string" ? item.command : undefined;
        if (item.type === "command_execution") {
          name = "bash";
          if (command) {
            try {
              const words = parse(command, () => {
                throw new Error("Shell expansion");
              });
              if (
                words.length === 3 &&
                typeof words[0] === "string" &&
                [
                  "/bin/bash",
                  "/bin/zsh",
                  "/opt/homebrew/bin/bash",
                  "/opt/homebrew/bin/zsh",
                  "/usr/local/bin/bash",
                  "/usr/local/bin/zsh",
                ].includes(words[0]) &&
                (words[1] === "-c" || words[1] === "-lc") &&
                typeof words[2] === "string"
              )
                command = words[2];
            } catch {
              // Keep unrecognized shell syntax for the canonical route validator to reject.
            }
          }
        } else if (
          item.type === "mcp_tool_call" &&
          typeof item.server === "string" &&
          typeof item.tool === "string"
        ) {
          name = `${item.server}_${item.tool}`;
        }
        observeNativeTool(name);
        events.line(
          JSON.stringify({
            type: "tool_use",
            part: {
              id: item.id,
              tool: name,
              state: {
                status:
                  item.status === "completed" &&
                  (item.type !== "command_execution" || item.exit_code === 0)
                    ? "completed"
                    : "error",
                input: command === undefined ? {} : { command },
              },
            },
          }),
        );
      } catch {
        events.malformed = true;
      }
    },
    async collect(): Promise<AgentUsage> {
      const metrics: Metrics = {
        initialInput: null,
        totalInput: 0,
        totalOutput: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        freshInput: 0,
        reasoning: 0,
        steps: 0,
        complete: true,
      };
      const warnings = [
        "Codex native observed response usage is best effort, not a billing or live request capture.",
      ];
      const requests: { response_id: string; turn_id?: string; model?: string; usage: Usage }[] =
        [];
      const models = new Set<string>();
      let artifactPath: string | undefined;
      const incomplete = (warning: string) => {
        metrics.complete = false;
        if (!warnings.includes(warning)) warnings.push(warning);
      };
      try {
        const id = events.sessionID;
        if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || events.malformed) throw new Error();
        let rollout: string | undefined;
        try {
          const dbPath = await containedPath(runtime, dataPath);
          const db = new DatabaseSync(dbPath, { readOnly: true });
          try {
            const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(id);
            if (row && typeof row.rollout_path === "string")
              rollout = resolve(codexHome, row.rollout_path);
          } finally {
            db.close();
          }
        } catch {
          // SQLite can be absent after an early exit; only this runtime's exact ID is eligible.
        }
        if (!rollout) {
          const pending = [codexHome];
          const matches: string[] = [];
          while (pending.length) {
            const parent = pending.pop();
            if (!parent) break;
            for (const entry of await readdir(parent, { withFileTypes: true })) {
              const path = join(parent, entry.name);
              if (entry.isDirectory()) pending.push(path);
              else if (
                entry.isFile() &&
                entry.name.startsWith("rollout-") &&
                entry.name.endsWith(`-${id}.jsonl`)
              )
                matches.push(path);
            }
          }
          if (matches.length !== 1) throw new Error();
          rollout = matches[0];
        }
        if (!rollout) throw new Error();
        const path = await containedPath(runtime, rollout);
        if (!(await lstat(path)).isFile()) throw new Error();
        const lines: Record<string, unknown>[] = [];
        for (const line of (await readFile(path, "utf8")).split("\n")) {
          if (!line.trim()) continue;
          try {
            const raw: unknown = JSON.parse(line);
            lines.push(object.parse(raw));
          } catch {
            incomplete("Codex rollout contains malformed records.");
          }
        }
        const metadata = lines.filter((line) => line.type === "session_meta");
        if (metadata.length !== 1 || object.parse(metadata[0]?.payload).id !== id)
          throw new Error();
        artifactPath = path;
        let model: string | undefined;
        let cumulative: Usage | undefined;
        const seen = new Map<string, Usage>();
        const turnTotals = new Map<string, Usage>();
        const empty = (): Usage => ({
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: 0,
        });
        const total = empty();
        const equal = (a: Usage, b: Usage) =>
          Object.entries(a).every(([key, value]) => object.parse(b)[key] === value);
        const add = (a: Usage, b: Usage) => {
          a.input_tokens += b.input_tokens;
          a.cached_input_tokens += b.cached_input_tokens;
          a.cache_write_input_tokens += b.cache_write_input_tokens;
          a.output_tokens += b.output_tokens;
          a.reasoning_output_tokens += b.reasoning_output_tokens;
          a.total_tokens += b.total_tokens;
        };
        const record = (raw: unknown) => {
          const parsed = z
            .object({
              response_id: z.string().min(1),
              thread_id: z.string().optional(),
              turn_id: z.string().optional(),
              usage: usageSchema,
              thread_token_usage: usageSchema.optional(),
              turn_token_usage: usageSchema.optional(),
            })
            .safeParse(raw);
          if (!parsed.success) {
            incomplete("Codex response usage is missing or invalid.");
            return;
          }
          const value = parsed.data;
          if (value.thread_id !== undefined && value.thread_id !== id) {
            incomplete("Codex usage has a different thread ID.");
            return;
          }
          const usage = value.usage;
          const previous = seen.get(value.response_id);
          if (previous) {
            if (!equal(previous, usage))
              incomplete("Codex response ID has conflicting usage snapshots.");
            return;
          }
          seen.set(value.response_id, usage);
          if (
            usage.total_tokens !== usage.input_tokens + usage.output_tokens ||
            usage.cached_input_tokens + usage.cache_write_input_tokens > usage.input_tokens ||
            usage.reasoning_output_tokens > usage.output_tokens
          )
            incomplete("Codex response token categories do not reconcile.");
          requests.push({
            response_id: value.response_id,
            ...(value.turn_id === undefined ? {} : { turn_id: value.turn_id }),
            ...(model === undefined ? {} : { model }),
            usage,
          });
          metrics.initialInput ??= usage.input_tokens;
          add(total, usage);
          if (value.thread_token_usage && !equal(total, value.thread_token_usage))
            incomplete("Codex thread cumulative usage does not reconcile with response deltas.");
          if (value.turn_id) {
            const turn = turnTotals.get(value.turn_id) ?? empty();
            add(turn, usage);
            turnTotals.set(value.turn_id, turn);
            if (value.turn_token_usage && !equal(turn, value.turn_token_usage))
              incomplete("Codex turn cumulative usage does not reconcile with response deltas.");
          }
        };
        for (const line of lines) {
          const payload = object.safeParse(line.payload);
          if (line.type === "response_item" && payload.success) {
            const item = payload.data;
            const name =
              item.type === "function_call" || item.type === "custom_tool_call"
                ? [item.namespace, item.name].filter((part) => typeof part === "string").join("_")
                : typeof item.type === "string"
                  ? item.type
                  : "";
            if (
              observeNativeTool(name) &&
              !warnings.includes("Codex rollout records native search or Code Mode use.")
            )
              warnings.push("Codex rollout records native search or Code Mode use.");
          }
          if (
            line.type === "turn_context" &&
            payload.success &&
            typeof payload.data.model === "string"
          ) {
            model = payload.data.model.replace(/^openai\//, "");
            models.add(model);
            if (model !== config.codexModel)
              incomplete("Codex observed a model other than the pinned Terra model.");
          }
          if (line.type === "token_usage_record") record(line.payload);
          if (
            line.type === "compacted" ||
            (line.type === "event_msg" &&
              payload.success &&
              payload.data.type === "context_compacted")
          ) {
            incomplete("Codex compaction was observed; spent response tokens were retained.");
            if (payload.success && payload.data.latest_token_usage_record)
              record(payload.data.latest_token_usage_record);
          }
          if (line.type === "event_msg" && payload.success && payload.data.type === "token_count") {
            const info = object.safeParse(payload.data.info);
            if (info.success && info.data.total_token_usage !== undefined) {
              const parsed = usageSchema.safeParse(info.data.total_token_usage);
              if (parsed.success) cumulative = parsed.data;
              else incomplete("Codex cumulative usage is invalid.");
            }
          }
        }
        metrics.totalInput = total.input_tokens;
        metrics.totalOutput = total.output_tokens;
        metrics.totalTokens = total.total_tokens;
        metrics.cacheRead = total.cached_input_tokens;
        metrics.cacheWrite = total.cache_write_input_tokens;
        metrics.freshInput = Math.max(
          0,
          total.input_tokens - total.cached_input_tokens - total.cache_write_input_tokens,
        );
        metrics.reasoning = total.reasoning_output_tokens;
        metrics.steps = requests.length;
        if (cumulative && !equal(total, cumulative))
          incomplete("Codex rollout cumulative usage does not reconcile with response deltas.");
        // In 0.153.3, turn.completed exports the thread total, not a new usage delta.
        let stdoutTotal:
          | { input_tokens: number; output_tokens: number; cached_input_tokens?: number }
          | undefined;
        for (const raw of stdoutUsage) {
          const parsed = z
            .object({
              input_tokens: count,
              output_tokens: count,
              cached_input_tokens: count.optional(),
            })
            .safeParse(raw);
          if (parsed.success) stdoutTotal = parsed.data;
          else incomplete("Codex stdout turn usage is missing or invalid.");
        }
        if (
          !stdoutTotal ||
          total.input_tokens !== stdoutTotal.input_tokens ||
          total.output_tokens !== stdoutTotal.output_tokens ||
          (stdoutTotal.cached_input_tokens !== undefined &&
            total.cached_input_tokens !== stdoutTotal.cached_input_tokens)
        )
          incomplete("Codex stdout turn usage does not reconcile with response deltas.");
        if (!models.size) incomplete("Codex rollout has no observed turn-context model.");
        if (!Object.values(total).every(Number.isSafeInteger))
          incomplete("Codex token totals exceed safe integer limits.");
      } catch {
        incomplete(
          "Codex exact-thread rollout is missing, invalid, or outside the private runtime.",
        );
      }
      if (!requests.length)
        incomplete(
          "Codex has no direct response usage records; legacy last-token counts are not used.",
        );
      if (events.error) incomplete("Codex reported an error; response usage may be incomplete.");
      return {
        metrics,
        requests,
        warnings,
        models: [...models],
        ...(artifactPath === undefined ? {} : { artifactPath }),
      };
    },
    async cleanup() {
      try {
        if ((await lstat(authLink)).isSymbolicLink()) await unlink(authLink);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    },
  };
}
