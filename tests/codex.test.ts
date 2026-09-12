import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PreparedAgent } from "../src/adapter.js";
import { codexAuth, prepareCodex } from "../src/codex.js";
import { configSchema } from "../src/config.js";
import type { Catalog } from "../src/github.js";
import type { Technique, Trial } from "../src/types.js";

const config = configSchema.parse({
  repository: "fixture/repo",
  branch: "main",
  opencodeVersion: "1.18.30",
  model: "openai/gpt-5.6-terra",
});
const token = "synthetic-github-token";
const auth = {
  auth_mode: "chatgpt",
  tokens: {
    id_token: "synthetic-id",
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
  },
};
// Deliberately synthetic, not a copy of the upstream catalog or its instructions.
const terra = {
  slug: "gpt-5.6-terra",
  tool_mode: "code_mode_only",
  supports_search_tool: true,
  use_responses_lite: true,
  base_instructions: "synthetic instructions",
  supported_reasoning_levels: [{ effort: "medium", description: "synthetic" }],
  unknown_future_field: { retain: [1, 2] },
};
const source = JSON.stringify({ models: [{ slug: "other" }, terra] });
const catalog: Catalog = {
  hash: "synthetic",
  names: ["github_get_commit", "github_create_issue"],
  tools: [],
  instructions: "",
  server: null,
};
const session = "0198abcd-1234-7000-8000-123456789abc";
const first = {
  input_tokens: 100,
  cached_input_tokens: 40,
  cache_write_input_tokens: 0,
  output_tokens: 20,
  reasoning_output_tokens: 5,
  total_tokens: 120,
};
const second = {
  input_tokens: 50,
  cached_input_tokens: 10,
  cache_write_input_tokens: 0,
  output_tokens: 10,
  reasoning_output_tokens: 3,
  total_tokens: 60,
};
const total = {
  input_tokens: 150,
  cached_input_tokens: 50,
  cache_write_input_tokens: 0,
  output_tokens: 30,
  reasoning_output_tokens: 8,
  total_tokens: 180,
};
let root = "";
let authFile = "";
const preparedAgents: PreparedAgent[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codex-synthetic-"));
  const original = join(root, "original-codex");
  await mkdir(original, { mode: 0o700 });
  authFile = join(original, "auth.json");
  await writeFile(authFile, JSON.stringify(auth), { mode: 0o600 });
  vi.stubEnv("CODEX_HOME", original);
  vi.stubEnv("OPENAI_API_KEY", "synthetic-ambient-api-key");
  vi.stubEnv("BASH_ENV", "/synthetic/ambient-shell");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(source)),
  );
});

afterEach(async () => {
  for (const prepared of preparedAgents.splice(0)) await prepared.cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

async function prepare(technique: Technique): Promise<PreparedAgent> {
  const trial: Trial = {
    id: `codex-${technique}-1`,
    agent: "codex",
    technique,
    workload: "task",
    repetition: 1,
  };
  const prepared = await prepareCodex(join(root, "attempts"), config, trial, catalog, token);
  preparedAgents.push(prepared);
  return prepared;
}

function emit(prepared: PreparedAgent, value: unknown): void {
  prepared.onLine(JSON.stringify(value));
}

async function rollout(prepared: PreparedAgent, records: unknown[]): Promise<string> {
  const path = join(dirname(prepared.configPath), `rollout-2026-09-09T12-00-00-${session}.jsonl`);
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
    mode: 0o600,
  });
  return path;
}

it("requires synthetic ChatGPT file auth and generates private, pinned direct-tool settings for each route", async () => {
  await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: "synthetic-api-only" }));
  await expect(codexAuth()).rejects.toThrow("not API-key auth");
  await writeFile(authFile, JSON.stringify(auth));
  await expect(codexAuth()).resolves.toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  const techniques: Technique[] = ["bash", "mcp-raw", "mcp-filter", "mcp-filter-readonly"];
  for (const technique of techniques) {
    const prepared = await prepare(technique);
    const home = dirname(prepared.configPath);
    const link = join(home, "auth.json");
    expect((await lstat(home)).isDirectory()).toBe(true);
    expect((await lstat(home)).isSymbolicLink()).toBe(false);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(authFile);
    for (const key of [
      "HOME",
      "CODEX_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "TMPDIR",
      "GH_CONFIG_DIR",
      "PWD",
    ]) {
      const path = prepared.env[key];
      if (!path) throw new Error("Missing private directory");
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
    expect(prepared.env.OPENAI_API_KEY).toBeUndefined();
    expect(prepared.env.BASH_ENV).toBeUndefined();
    expect(prepared.env[technique === "bash" ? "GH_TOKEN" : "BENCH_GITHUB_TOKEN"]).toBe(token);
    expect(prepared.env[technique === "bash" ? "BENCH_GITHUB_TOKEN" : "GH_TOKEN"]).toBeUndefined();
    await expect(lstat(join(home, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const toml = await readFile(prepared.configPath, "utf8");
    expect((await lstat(prepared.configPath)).mode & 0o777).toBe(0o600);
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain('model_reasoning_effort = "medium"');
    expect(toml).toContain("code_mode = false\ncode_mode_only = false");
    expect(toml).toContain(
      "project_doc_max_bytes = 0\nproject_root_markers = []\nallow_login_shell = false",
    );
    expect(toml).toContain(`ignore_default_excludes = ${technique === "bash"}`);
    expect(toml).toContain("[skills.bundled]\nenabled = false");
    expect(toml).not.toContain(token);
    expect(toml).not.toContain("enabled_tools");
    expect(toml).not.toContain("danger-full-access");
    expect(toml).toContain(`shell_tool = ${technique === "bash"}`);
    if (technique === "bash") {
      expect(toml).not.toContain("[mcp_servers.github]");
      expect(toml).toContain('sandbox_mode = "workspace-write"');
      expect(toml).toContain("network_access = true");
    } else {
      expect(toml).toContain('sandbox_mode = "read-only"');
      expect(toml).toContain("required = true");
      expect(toml).toContain('bearer_token_env_var = "BENCH_GITHUB_TOKEN"');
      expect(toml).toContain('omit_tools_from = ["deferred", "code_mode"]');
      expect(toml.includes('"X-MCP-Toolsets" = "repos"')).toBe(technique !== "mcp-raw");
      expect(toml.includes('"X-MCP-Readonly" = "true"')).toBe(technique === "mcp-filter-readonly");
    }
    expect(prepared.args).toEqual([
      "exec",
      "--json",
      "--strict-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--cd",
      prepared.cwd,
      "-",
    ]);
    const modelText = await readFile(join(home, "models.json"), "utf8");
    const model: unknown = JSON.parse(modelText);
    expect(model).toEqual({
      models: [{ ...terra, tool_mode: "direct", supports_search_tool: false }],
    });
    expect(prepared.settings.join("\n")).toContain(
      createHash("sha256").update(source).digest("hex"),
    );
    expect(prepared.settings.join("\n")).toContain(
      createHash("sha256").update(modelText).digest("hex"),
    );
    await writeFile(link, JSON.stringify({ ...auth, last_refresh: "synthetic-refresh-time" }));
    await prepared.cleanup();
    await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(authFile, "utf8")).toContain("synthetic-refresh-time");
    expect((await lstat(prepared.configPath)).isFile()).toBe(true);
  }
  expect(fetch).toHaveBeenCalledWith(
    "https://raw.githubusercontent.com/openai/codex/b1a547b1f73ce86205d9222ac19cff334b3b7a2e/codex-rs/models-manager/models.json",
    expect.objectContaining({ redirect: "error" }),
  );
});

it("does not configure MCP servers for suite Bash", async () => {
  const suiteConfig = configSchema.parse({
    ...config,
    suite: {
      cliVersions: { supabase: "2.117.0", wrangler: "4.131.1", stripe: "1.50.11" },
      supabase: {
        projectRef: "abcdefghijklmnopqrst",
        edgeFunctionId: "11111111-1111-4111-8111-111111111111",
        edgeFunctionSlug: "hello-world",
        keychainService: "tool-context-bench.supabase",
      },
      cloudflare: {
        accountId: "a".repeat(32),
        d1DatabaseId: "22222222-2222-4222-8222-222222222222",
        d1DatabaseName: "agent-test",
        keychainService: "tool-context-bench.cloudflare",
      },
      stripe: {
        webhookEndpointId: "we_fixture",
        livemode: false,
        keychainService: "tool-context-bench.stripe",
      },
    },
  });
  const credentials = {
    github: "synthetic-github",
    supabase: "synthetic-supabase",
    cloudflare: "synthetic-cloudflare",
    stripe: "synthetic-stripe",
  };
  const prepared = await prepareCodex(
    join(root, "suite-bash"),
    suiteConfig,
    {
      id: "codex-bash-noop-1",
      agent: "codex",
      technique: "bash",
      workload: "noop",
      repetition: 1,
    },
    undefined,
    credentials.github,
    "suite",
    credentials,
  );
  preparedAgents.push(prepared);
  const toml = await readFile(prepared.configPath, "utf8");
  const supabaseHome = prepared.env.SUPABASE_HOME;
  if (!supabaseHome) throw new Error("Missing Supabase home");
  expect(toml).not.toContain("[mcp_servers.");
  expect(prepared.env.GH_TOKEN).toBe(credentials.github);
  expect(supabaseHome).toBe(join(prepared.cwd, ".supabase"));
  expect(prepared.env.SUPABASE_ACCESS_TOKEN).toBe(credentials.supabase);
  expect(toml).toContain('"SUPABASE_HOME"');
  await expect(lstat(supabaseHome)).rejects.toMatchObject({ code: "ENOENT" });
});

it("normalizes shell events and reads only the SQLite-selected thread, deduplicating response usage", async () => {
  const prepared = await prepare("bash");
  emit(prepared, { type: "thread.started", thread_id: session });
  const command = "gh api repos/fixture/repo/commits/main";
  emit(prepared, {
    type: "item.completed",
    item: {
      id: "shell",
      type: "command_execution",
      command: `/opt/homebrew/bin/bash -c '${command}'`,
      status: "completed",
      exit_code: 0,
      aggregated_output: "private output",
    },
  });
  emit(prepared, {
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: "intermediate" },
  });
  emit(prepared, {
    type: "item.completed",
    item: { id: "message-2", type: "agent_message", text: `final ${token}` },
  });
  emit(prepared, {
    type: "item.completed",
    item: { id: "message-2", type: "agent_message", text: `last ${token}` },
  });
  emit(prepared, { type: "turn.completed", usage: total });
  emit(prepared, { type: "turn.completed", usage: total });
  expect(prepared.events.sessionID).toBe(session);
  expect(prepared.events.tools).toEqual([{ name: "bash", command, status: "completed" }]);
  expect(prepared.events.answer).toBe("last [REDACTED]");
  const one = {
    response_id: "response-1",
    thread_id: session,
    turn_id: "turn-1",
    usage: first,
    thread_token_usage: first,
    turn_token_usage: first,
  };
  const two = {
    response_id: "response-2",
    thread_id: session,
    turn_id: "turn-1",
    usage: second,
    thread_token_usage: total,
    turn_token_usage: total,
  };
  const path = await rollout(prepared, [
    { type: "session_meta", payload: { id: session } },
    { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
    { type: "token_usage_record", payload: one },
    { type: "token_usage_record", payload: one },
    { type: "token_usage_record", payload: two },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: total, last_token_usage: { input_tokens: 999999 } },
      },
    },
  ]);
  const db = new DatabaseSync(prepared.dataPath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run(session, path);
  db.prepare("INSERT INTO threads VALUES (?, ?)").run("unrelated-thread", authFile);
  db.close();
  const usage = await prepared.collect();
  expect(usage.metrics).toEqual({
    initialInput: 100,
    totalInput: 150,
    totalOutput: 30,
    totalTokens: 180,
    cacheRead: 50,
    cacheWrite: 0,
    freshInput: 100,
    reasoning: 8,
    steps: 2,
    complete: true,
  });
  expect(usage.requests).toHaveLength(2);
  expect(usage.models).toEqual(["gpt-5.6-terra"]);
  expect(usage.artifactPath).toBe(await realpath(path));
  expect(usage.warnings.join(" ")).toContain("best effort");
});

it("retains spent tokens after compaction, flags MCP/search errors, and rejects foreign or legacy-only rollouts", async () => {
  const prepared = await prepare("mcp-raw");
  emit(prepared, { type: "thread.started", thread_id: session });
  emit(prepared, {
    type: "item.completed",
    item: {
      id: "read",
      type: "mcp_tool_call",
      server: "github",
      tool: "get_commit",
      status: "completed",
      arguments: {},
      result: { content: [] },
    },
  });
  expect(prepared.events.tools).toEqual([{ name: "github_get_commit", status: "completed" }]);
  emit(prepared, {
    type: "item.completed",
    item: { id: "search", type: "tool_search", status: "completed" },
  });
  emit(prepared, {
    type: "item.completed",
    item: { id: "code", type: "code_mode", status: "completed" },
  });
  emit(prepared, { type: "turn.failed", error: { message: `private ${token}` } });
  expect(prepared.events.codeMode).toBe(true);
  expect(prepared.events.error).toBe(true);
  expect(prepared.events.warnings.join(" ")).toContain("despite direct-tool settings");
  expect(JSON.stringify(prepared.events.warnings)).not.toContain(token);
  const record = {
    response_id: "response-1",
    thread_id: session,
    usage: first,
    thread_token_usage: first,
  };
  const path = await rollout(prepared, [
    { type: "session_meta", payload: { id: session } },
    { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
    { type: "token_usage_record", payload: record },
    { type: "response_item", payload: { type: "tool_search_call", arguments: { private: token } } },
    { type: "compacted", payload: { latest_token_usage_record: record } },
  ]);
  const compacted = await prepared.collect();
  expect(compacted.metrics).toMatchObject({ totalTokens: 120, steps: 1, complete: false });
  expect(compacted.warnings.join(" ")).toContain("compaction");
  expect(compacted.warnings.join(" ")).toContain("native search");
  await writeFile(
    path,
    JSON.stringify({ type: "session_meta", payload: { id: "foreign-thread" } }),
  );
  expect((await prepared.collect()).metrics).toMatchObject({ totalTokens: 0, complete: false });
  await rollout(prepared, [
    { type: "session_meta", payload: { id: session } },
    {
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: first, total_token_usage: first } },
    },
  ]);
  const legacy = await prepared.collect();
  expect(legacy.metrics).toMatchObject({ initialInput: null, totalTokens: 0, complete: false });
  expect(legacy.requests).toEqual([]);
  const db = new DatabaseSync(prepared.dataPath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run(session, authFile);
  db.close();
  const outside = await prepared.collect();
  expect(outside.metrics.complete).toBe(false);
  expect(outside.artifactPath).toBeUndefined();
  expect(outside.warnings.join(" ")).toContain("outside the private runtime");
});
