import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "./config.js";
import type { Trial } from "./types.js";
import { minimalEnvironment } from "./process.js";
import { MCP_URL } from "./github.js";
import { mcpHeaders } from "./techniques.js";

export function agentConfig(config: Config, trial: Trial, names: string[]) {
  const permission: Record<string, string | Record<string, string>> = { "*": "deny" };
  if (trial.technique === "bash") {
    permission.bash = {
      "*": "deny",
      "gh api *": "allow",
      "gh repo view *": "allow",
      "gh --help": "allow",
      "gh help *": "allow",
      "jq *": "allow",
    };
  } else {
    for (const name of names) permission[name] = "allow";
  }
  return {
    $schema: "https://opencode.ai/config.json",
    model: config.model,
    enabled_providers: ["openai"],
    default_agent: "bench",
    shell: "/bin/bash",
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    lsp: false,
    formatter: false,
    plugin: [],
    instructions: [],
    subagent_depth: 0,
    compaction: { auto: false, prune: false },
    permission: { "*": "deny" },
    agent: {
      build: { disable: true },
      plan: { disable: true },
      general: { disable: true },
      explore: { disable: true },
      title: { disable: true },
      summary: { disable: true },
      bench: { mode: "primary", steps: config.maxSteps, permission },
    },
    mcp:
      trial.technique !== "bash"
        ? {
            github: {
              type: "remote",
              url: MCP_URL,
              enabled: true,
              oauth: false,
              timeout: 30000,
              headers: mcpHeaders(trial.technique, "{env:BENCH_GITHUB_TOKEN}"),
            },
          }
        : {},
    experimental: { openTelemetry: false, continue_loop_on_deny: false, batch_tool: false },
  };
}

export function attemptEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    ...minimalEnvironment(),
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_STATE_HOME: join(directory, "state"),
    TMPDIR: join(directory, "tmp"),
    PWD: join(directory, "work"),
    GH_CONFIG_DIR: join(directory, "gh"),
    GH_PROMPT_DISABLED: "1",
    GH_HOST: "github.com",
    OPENCODE_CONFIG: join(directory, "bench.json"),
    OPENCODE_DB: join(directory, "data", "opencode", "bench.db"),
    OPENCODE_PURE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOCOMPACT: "true",
    OPENCODE_DISABLE_PRUNE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    OPENCODE_EXPERIMENTAL: "false",
    OPENCODE_EXPERIMENTAL_CODE_MODE: "false",
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false",
    OPENCODE_EXPERIMENTAL_WEBSOCKETS: "false",
    OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false",
  };
}

export async function prepareAttempt(
  directory: string,
  auth: string,
  config: Config,
  trial: Trial,
  names: string[],
) {
  for (const child of ["home", "config", "data/opencode", "cache", "state", "tmp", "work", "gh"]) {
    await mkdir(join(directory, child), { recursive: true, mode: 0o700 });
  }
  await symlink(resolve(auth), join(directory, "data", "opencode", "auth.json"));
  await writeFile(
    join(directory, "bench.json"),
    `${JSON.stringify(agentConfig(config, trial, names), null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    directory,
    database: join(directory, "data", "opencode", "bench.db"),
    env: attemptEnvironment(directory),
    cwd: join(directory, "work"),
  };
}
