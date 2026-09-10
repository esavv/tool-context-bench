import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { claudeAuth, ClaudeCollector, prepareClaude } from "../src/claude.js";
import { configSchema } from "../src/config.js";
import type { Catalog } from "../src/github.js";
import * as processModule from "../src/process.js";
import type { Trial } from "../src/types.js";

const config = configSchema.parse({
  repository: "fixture/repo",
  branch: "main",
  opencodeVersion: "1.18.30",
  model: "openai/gpt-5.6-terra",
});
const trial: Trial = {
  id: "claude-test",
  agent: "claude",
  technique: "bash",
  workload: "task",
  repetition: 1,
};
const sessionID = "d5c21641-2a42-4b27-9ce4-a5bff4219ace";
const token = "synthetic-private-token";
const catalog: Catalog = {
  hash: "synthetic",
  names: ["github_get_commit"],
  readOnlyNames: ["github_get_commit"],
  tools: [],
  instructions: "",
  server: null,
};
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("preserves subscription state without inherited API credentials and writes isolated configs without the PAT", async () => {
  vi.stubEnv("HOME", "/synthetic/original-home");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/synthetic/original-claude");
  vi.stubEnv("ANTHROPIC_API_KEY", token);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", token);
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", token);
  const execute = vi.spyOn(processModule, "execute").mockResolvedValue({
    code: 0,
    stopped: false,
    stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: token }),
    stderr: "",
  });
  await claudeAuth("synthetic-claude");
  expect(execute).toHaveBeenCalledWith("synthetic-claude", ["auth", "status", "--json"], {
    env: expect.objectContaining({
      HOME: "/synthetic/original-home",
      CLAUDE_CONFIG_DIR: "/synthetic/original-claude",
    }),
  });
  expect(JSON.stringify(execute.mock.calls)).not.toContain(token);
  execute.mockResolvedValue({
    code: 0,
    stopped: false,
    stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key", error: token }),
    stderr: token,
  });
  await expect(claudeAuth("synthetic-claude")).rejects.toThrow(
    "Cannot confirm an existing Claude subscription login.",
  );
  const directory = await mkdtemp(join(tmpdir(), "claude-adapter-test-"));
  directories.push(directory);
  const prepared = await prepareClaude(
    join(directory, "mcp"),
    config,
    { ...trial, technique: "mcp-filter-readonly" },
    catalog,
    token,
  );
  const bash = await prepareClaude(join(directory, "bash"), config, trial, undefined, token);
  expect(prepared.env.HOME).toBe("/synthetic/original-home");
  expect(prepared.env.CLAUDE_CONFIG_DIR).toBe("/synthetic/original-claude");
  expect(prepared.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(prepared.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(prepared.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(prepared.env.ENABLE_TOOL_SEARCH).toBe("false");
  expect(prepared.env.MCP_DISCOVERY_CACHE).toBe("0");
  expect(prepared.args).toEqual(
    expect.arrayContaining([
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--max-turns",
      "8",
      "mcp__github__*",
      "--print",
    ]),
  );
  expect(bash.args).toContain("Bash(gh api *)");
  expect(bash.args).toContain("Bash(jq *)");
  expect(prepared.events.sessionID).toMatch(/^[0-9a-f-]{36}$/);
  expect(prepared.events.sessionID).not.toBe(bash.events.sessionID);
  expect(prepared.args).toContain(prepared.events.sessionID);
  prepared.onLine(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: prepared.events.sessionID,
      tools: catalog.names.map((name) => name.replace(/^github_/, "mcp__github__")),
      slash_commands: ["mcp__github__AssignCodingAgent"],
      mcp_servers: [{ name: "github", status: "connected" }],
    }),
  );
  expect((await prepared.collect()).warnings).toContain(
    "Claude init confirmed the eager tool catalog with no ToolSearch.",
  );
  const settings = await readFile(prepared.configPath, "utf8");
  const mcp = await readFile(join(prepared.directory, "claude-mcp.json"), "utf8");
  expect(settings + mcp).not.toContain(token);
  expect(mcp).toContain("Bearer ${BENCH_GITHUB_TOKEN}");
  expect(mcp).toContain('"X-MCP-Readonly": "true"');
  expect(JSON.parse(await readFile(join(bash.directory, "claude-mcp.json"), "utf8"))).toEqual({
    mcpServers: {},
  });
  expect(prepared.dataPath).toBe(join(prepared.directory, "claude-events.jsonl"));
  expect(prepared.dataKind).toBe("jsonl");
  await prepared.cleanup();
  expect(execute).toHaveBeenCalledTimes(2);
});

it("counts stream snapshots once, keeps completed usage, and joins tool results without exporting output", () => {
  const collector = new ClaudeCollector(config, trial, undefined, token, sessionID);
  const send = (event: unknown) => collector.line(JSON.stringify(event));
  const stream = (event: unknown) => send({ type: "stream_event", session_id: sessionID, event });
  send({
    type: "system",
    subtype: "init",
    session_id: sessionID,
    tools: ["Bash"],
    plugins: [],
    skills: [],
  });
  stream({
    type: "message_start",
    message: {
      id: "msg_one",
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 1,
      },
    },
  });
  stream({ type: "message_delta", usage: { output_tokens: 7 } });
  stream({ type: "message_delta", usage: { output_tokens: 7 } });
  stream({ type: "message_stop" });
  send({
    type: "assistant",
    message: {
      id: "msg_one",
      model: "claude-sonnet-5",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [
        { type: "text", text: "Progress, not the answer." },
        {
          type: "tool_use",
          id: "tool_one",
          name: "Bash",
          input: { command: "gh api repos/fixture/repo/commits/main" },
        },
      ],
    },
  });
  expect(collector.events.tools).toHaveLength(0);
  const result = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool_one", content: token }] },
  };
  send(result);
  send(result);
  stream({
    type: "message_start",
    message: {
      id: "msg_two",
      model: "claude-sonnet-5",
      usage: { input_tokens: 12, cache_read_input_tokens: 30, output_tokens: 1 },
    },
  });
  stream({ type: "message_delta", usage: { output_tokens: 9 } });
  stream({ type: "message_stop" });
  send({
    type: "result",
    subtype: "success",
    result: "final answer",
    usage: {
      input_tokens: 22,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 5,
      output_tokens: 16,
    },
    headers: { authorization: token },
  });
  const usage = collector.collect();
  expect(usage.metrics).toEqual({
    initialInput: 35,
    freshInput: 22,
    cacheRead: 50,
    cacheWrite: 5,
    totalInput: 77,
    totalOutput: 16,
    totalTokens: 93,
    reasoning: 0,
    steps: 2,
    complete: true,
  });
  expect(usage.requests).toHaveLength(2);
  expect(usage.models).toEqual(["claude-sonnet-5"]);
  expect(collector.events.answer).toBe("final answer");
  expect(collector.events.tools).toEqual([
    { name: "bash", status: "completed", command: "gh api repos/fixture/repo/commits/main" },
  ]);
  expect(collector.events.routeValid).toBe(true);
  expect(JSON.stringify([usage, collector.events.safeEvents])).not.toContain(token);
  expect(collector.collect()).toEqual(usage);
});

it("marks unexpected discovery and missing requests incomplete, reconciles totals, and fails pending MCP calls", () => {
  const collector = new ClaudeCollector(
    config,
    { ...trial, technique: "mcp-filter-readonly" },
    catalog,
    token,
    sessionID,
  );
  const send = (event: unknown) => collector.line(JSON.stringify(event));
  send({
    type: "system",
    subtype: "init",
    session_id: sessionID,
    tools: ["ToolSearch", "mcp__github__execute_code"],
    plugins: [token],
    skills: [token],
  });
  send({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 100 } } });
  send({
    type: "assistant",
    message: {
      id: "msg_partial",
      model: "claude-sonnet-5",
      usage: { input_tokens: 2, output_tokens: 1 },
      content: [
        { type: "tool_use", id: "tool_complete", name: "mcp__github__get_commit", input: {} },
        { type: "tool_use", id: "tool_pending", name: "mcp__github__get_commit", input: {} },
      ],
    },
  });
  send({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tool_complete", content: token, is_error: false },
      ],
    },
  });
  send({
    type: "result",
    subtype: "error_during_execution",
    errors: [token],
    usage: { input_tokens: 20, output_tokens: 10 },
    result: `answer ${token}`,
  });
  const usage = collector.collect();
  expect(usage.metrics).toMatchObject({
    complete: false,
    totalInput: 20,
    totalOutput: 10,
    totalTokens: 30,
    steps: 1,
  });
  expect(usage.warnings.join(" ")).toMatch(/unmatched request usage is unknown/);
  expect(collector.events.tools).toEqual([
    { name: "github_get_commit", status: "completed" },
    { name: "github_get_commit", status: "error" },
  ]);
  expect(collector.events.invalidRoute).toBe(true);
  expect(collector.events.codeMode).toBe(true);
  expect(collector.events.error).toBe(true);
  expect(collector.events.answer).toBe("");
  expect(
    JSON.stringify([
      usage,
      collector.events.safeEvents,
      collector.events.tools,
      collector.events.warnings,
    ]),
  ).not.toContain(token);
});
