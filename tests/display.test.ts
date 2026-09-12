import { describe, expect, it } from "vitest";
import { csvReport, sessionInspection, statistics, summarize, textReport } from "../src/display.js";
import type { Batch, Metrics, Result, Trial } from "../src/types.js";
import { batchFields, combineBatches, selectionProblem } from "../src/batches.js";

function result(id: string, overrides: Partial<Result> = {}): Result {
  return {
    trial: { id, agent: "opencode", workload: "task", technique: "bash", repetition: 1 },
    status: "complete",
    success: true,
    startedAt: "2026-09-09T00:00:00Z",
    durationMs: 100,
    sessionID: `session-${id}`,
    warnings: [],
    answer: "OK",
    tools: [],
    codeMode: "not-observed",
    grading: { routeValid: true, schemaValid: true, valueMatches: true },
    metrics: usage(),
    ...overrides,
  };
}

function usage(overrides: Partial<Metrics> = {}): Metrics {
  return {
    initialInput: 100,
    totalInput: 300,
    totalOutput: 30,
    totalTokens: 330,
    cacheRead: 200,
    cacheWrite: 20,
    freshInput: 80,
    reasoning: 10,
    steps: 2,
    complete: true,
    ...overrides,
  };
}

function batch(results: Result[]): Batch {
  return {
    manifest: {
      schemaVersion: 4,
      id: "batch-1",
      createdAt: "2026-09-09T00:00:00Z",
      benchmark: "github",
      seed: 1,
      config: {
        repository: "owner/repo",
        branch: "main",
        opencodeVersion: "1.18.30",
        opencode2Version: "0.0.0-beta-19425",
        model: "openai/gpt-5.6-terra",
        claudeVersion: "2.1.267",
        claudeModel: "claude-sonnet-5",
        codexVersion: "0.153.3",
        codexModel: "gpt-5.6-terra",
        piVersion: "0.85.1",
        piModel: "openai-codex/gpt-5.6-terra",
        variant: "medium",
        repeats: 3,
        timeoutSeconds: 180,
        maxSteps: 8,
        keychainService: "tool-context-bench.github",
      },
      schedule: results.map((item) => item.trial),
      expected: {
        sha: "a".repeat(40),
        subject: "test",
        committed_at: "2026-09-09T00:00:00Z",
        source_url: "https://github.com/owner/repo",
      },
      versions: { opencode: "1.18.30", gh: "2.0.0", node: "24.18.0" },
      catalogs: {},
      exposure: "source-verified; not a live request capture",
    },
    results,
  };
}

// Small independent CSV reader to check quoting, embedded newlines, and column alignment.
function parseCsv(csv: string): Record<string, string>[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      record.push(field);
      field = "";
    } else if (char === "\r" && csv[index + 1] === "\n" && !quoted) {
      records.push([...record, field]);
      record = [];
      field = "";
      index++;
    } else field += char;
  }
  const header = records.shift() ?? [];
  return records.map((fields) => {
    expect(fields).toHaveLength(header.length);
    return Object.fromEntries(header.map((name, index) => [name, fields[index] ?? ""]));
  });
}

describe("statistics", () => {
  it("keeps unavailable values distinct from measured zero", () => {
    expect(statistics([null, NaN, Infinity, -1])).toEqual({
      n: 0,
      median: null,
      min: null,
      max: null,
      total: null,
    });
    expect(statistics([0])).toEqual({ n: 1, median: 0, min: 0, max: 0, total: 0 });
  });
  it("computes singleton, odd, and even medians without changing inputs", () => {
    const values = [40, 10, 30, 20];
    expect(statistics([7])).toEqual({ n: 1, median: 7, min: 7, max: 7, total: 7 });
    expect(statistics([4, null, 1, 9]).median).toBe(4);
    expect(statistics(values)).toEqual({ n: 4, median: 25, min: 10, max: 40, total: 100 });
    expect(values).toEqual([40, 10, 30, 20]);
  });
});

describe("batch selection", () => {
  it("combines separate task and no-op repetitions without mutating the saved batches", () => {
    const first = batch([result("task-1", { metrics: usage({ initialInput: 100 }) })]);
    first.manifest.id = "first";
    first.manifest.config.repeats = 1;
    const second = batch([
      result("task-1", { metrics: usage({ initialInput: 200 }) }),
      result("task-2", { metrics: usage({ initialInput: 600 }) }),
    ]);
    second.manifest.id = "second";
    second.manifest.config.repeats = 2;
    const noop = batch(
      [1, 2, 3].map((repetition) =>
        result(`noop-${repetition}`, {
          trial: {
            id: `noop-${repetition}`,
            agent: "opencode",
            technique: "bash",
            workload: "noop",
            repetition,
          },
        }),
      ),
    );
    noop.manifest.id = "noop";
    const batches = [first, second, noop];
    const before = structuredClone(batches);
    const combined = combineBatches(batches, first);
    const rows = summarize(combined);
    expect(rows[0]).toMatchObject({
      workload: "task",
      success: 3,
      tried: 3,
      validSamples: 3,
      metrics: { initialInput: { median: 200 } },
    });
    expect(rows[1]).toMatchObject({ workload: "noop", success: 3, tried: 3, validSamples: 3 });
    expect(new Set(combined.results.map((result) => result.trial.id)).size).toBe(6);
    expect(combined.results[0]?.origin).toEqual({ batchID: "first", trialID: "task-1" });
    expect(batches).toEqual(before);
  });

  it("keeps same-named pending trials separate, deduplicates batch selection, and supports no selection", () => {
    const pending = batch([]);
    pending.manifest.id = "pending";
    pending.manifest.schedule.push(result("same").trial);
    const finished = batch([result("same")]);
    finished.manifest.id = "finished";
    expect(summarize(combineBatches([pending, finished, finished], pending))[0]).toMatchObject({
      tried: 1,
      pending: 1,
    });
    expect(summarize(combineBatches([], pending))).toEqual([]);
  });

  it("blocks conflicting settings or MCP catalogs before pooling results", () => {
    const first = batch([
      result("a", {
        trial: {
          id: "a",
          agent: "opencode",
          technique: "mcp-raw",
          workload: "task",
          repetition: 1,
        },
      }),
    ]);
    first.manifest.catalogs["mcp-raw"] = { hash: "catalog-a", toolCount: 44 };
    const second = structuredClone(first);
    second.manifest.id = "second";
    second.manifest.config.variant = "low";
    expect(selectionProblem([first, second])).toContain("reasoning variant");
    second.manifest.config.variant = "medium";
    second.manifest.catalogs["mcp-raw"] = { hash: "catalog-b", toolCount: 44 };
    expect(() => combineBatches([first, second], first)).toThrow("catalog hashes differ");
    expect(selectionProblem([second])).toBeNull();
  });

  it("keeps GitHub and multi-tool batches separate", () => {
    const github = batch([result("github")]);
    const suite = structuredClone(github);
    suite.manifest.id = "suite";
    suite.manifest.benchmark = "suite";
    expect(selectionProblem([github, suite])).toContain("benchmark differs");
    expect(batchFields(github).benchmark).toBe("github");
    expect(batchFields(suite).benchmark).toBe("suite");
  });

  it("describes workloads, agent, planned repeats, and completed sessions", () => {
    const input = batch([
      result("a"),
      result("b", {
        trial: { id: "b", agent: "opencode", technique: "bash", workload: "noop", repetition: 1 },
      }),
    ]);
    expect(batchFields(input)).toMatchObject({
      workload: "both",
      agents: "opencode",
      repeats: 3,
      sessions: "2/2",
      id: input.manifest.id,
    });
    expect(textReport(input)).toContain("opencode 1.18.30 | openai/gpt-5.6-terra");
  });

  it("keeps OpenCode 1 and 2 in separate result groups across selected batches", () => {
    const first = batch([result("same")]);
    const second = batch([
      result("same", {
        trial: {
          id: "same",
          agent: "opencode2",
          technique: "bash",
          workload: "task",
          repetition: 1,
        },
        metrics: usage({ initialInput: 900 }),
      }),
    ]);
    second.manifest.id = "v2";
    second.manifest.versions = { opencode2: "0.0.0-beta-19425", gh: "2.0.0", node: "24.18.0" };
    const combined = combineBatches([first, second], first);
    expect(summarize(combined).map((row) => [row.agent, row.metrics.initialInput.median])).toEqual([
      ["opencode", 100],
      ["opencode2", 900],
    ]);
    expect(batchFields(combined).agents).toBe("opencode/opencode2");
    expect(textReport(combined)).toContain("opencode2 0.0.0-beta-19425");
    expect(csvReport(combined)).toContain("opencode2");
  });

  it("combines different agents and models but checks overlapping profiles and shared catalogs", () => {
    const claude = batch([
      result("same", {
        trial: {
          id: "same",
          agent: "claude",
          technique: "mcp-raw",
          workload: "task",
          repetition: 1,
        },
      }),
    ]);
    claude.manifest.id = "claude";
    claude.manifest.versions = { claude: "2.1.267", gh: "2.0.0", node: "24.18.0" };
    claude.manifest.config.variant = "high";
    claude.manifest.catalogs["mcp-raw"] = { hash: "shared", toolCount: 44 };
    const codex = batch([
      result("same", {
        trial: {
          id: "same",
          agent: "codex",
          technique: "mcp-raw",
          workload: "task",
          repetition: 1,
        },
      }),
    ]);
    codex.manifest.id = "codex";
    codex.manifest.versions = { codex: "0.153.3", gh: "2.0.0", node: "24.18.0" };
    codex.manifest.catalogs["mcp-raw"] = { hash: "shared", toolCount: 44 };
    expect(selectionProblem([claude, codex])).toBeNull();
    const combined = combineBatches([claude, codex], claude);
    expect(new Set(combined.results.map((item) => item.trial.id)).size).toBe(2);
    expect(batchFields(combined).agents).toBe("claude/codex");
    const text = textReport(combined);
    expect(text).toContain("claude 2.1.267 | claude-sonnet-5");
    expect(text).toContain("codex 0.153.3 | gpt-5.6-terra");
    expect(text).not.toContain("OpenCode");
    const otherClaude = structuredClone(claude);
    otherClaude.manifest.id = "other-claude";
    otherClaude.manifest.versions.claude = "different";
    expect(selectionProblem([claude, codex, otherClaude])).toContain("claude version");
    codex.manifest.catalogs["mcp-raw"] = { hash: "different", toolCount: 44 };
    expect(selectionProblem([claude, codex])).toContain("catalog hashes differ");
  });
});

describe("summarize", () => {
  it("orders agents alphabetically within techniques and keeps their samples separate", () => {
    const input = batch([result("opencode")]);
    const techniques: Trial["technique"][] = ["mcp-raw", "bash"];
    const agents: Trial["agent"][] = ["codex", "claude"];
    for (const technique of techniques) {
      for (const agent of agents) {
        const id = `${technique}-${agent}`;
        const item = result(id, {
          trial: { id, agent, technique, workload: "task", repetition: 1 },
        });
        input.results.push(item);
        input.manifest.schedule.push(item.trial);
      }
    }
    const rows = summarize(input);
    expect(rows.map(({ technique, agent }) => [technique, agent])).toEqual([
      ["bash", "claude"],
      ["bash", "codex"],
      ["bash", "opencode"],
      ["mcp-raw", "claude"],
      ["mcp-raw", "codex"],
    ]);
    expect(rows.every((row) => row.metrics.initialInput.n === 1 && row.tried === 1)).toBe(true);
    const records = parseCsv(csvReport(input));
    expect(records.filter((record) => record.record_type === "attempt")).toHaveLength(5);
    expect(records[0]).toMatchObject({ agent: "claude", technique: "bash" });
    expect(records[1]).toMatchObject({ agent: "claude", trial_id: "bash-claude" });
  });

  it("groups by workload then technique, including scheduled but unstarted groups", () => {
    const input = batch([
      result("b", {
        trial: {
          id: "b",
          agent: "opencode",
          workload: "task",
          technique: "mcp-filter",
          repetition: 1,
        },
      }),
      result("m", {
        trial: {
          id: "m",
          agent: "opencode",
          workload: "task",
          technique: "mcp-raw",
          repetition: 1,
        },
      }),
      result("a"),
    ]);
    input.manifest.schedule.push({
      id: "pending",
      agent: "opencode",
      workload: "noop",
      technique: "mcp-filter-readonly",
      repetition: 1,
    });
    const before = structuredClone(input);
    const rows = summarize(input);
    expect(rows.map((row) => [row.workload, row.technique])).toEqual([
      ["task", "bash"],
      ["task", "mcp-raw"],
      ["task", "mcp-filter"],
      ["noop", "mcp-filter-readonly"],
    ]);
    expect(rows[3]).toMatchObject({
      tried: 0,
      success: 0,
      validSamples: 0,
      pending: 1,
      metrics: { totalTokens: { n: 0, total: null } },
    });
    expect(input).toEqual(before);
  });
  it("counts successes independently of telemetry and excludes unsuccessful or partial samples", () => {
    const rows = summarize(
      batch([
        result("good"),
        result("partial", { status: "usage-incomplete", metrics: usage({ complete: false }) }),
        result("missing", { metrics: null }),
        result("failed", {
          status: "failed",
          success: false,
          metrics: usage({ totalTokens: 9000 }),
        }),
        result("running", { status: "running", success: false }),
      ]),
    );
    expect(rows[0]).toMatchObject({
      tried: 5,
      success: 3,
      validSamples: 1,
      statuses: { complete: 2, "usage-incomplete": 1, failed: 1, running: 1 },
      metrics: {
        totalTokens: { n: 1, total: 330 },
        totalInput: { total: 300 },
        cacheRead: { total: 200 },
      },
    });
  });
  it("preserves a separate initial-input sample count and rejects invalid numeric telemetry", () => {
    const rows = summarize(
      batch([
        result("a", { metrics: usage({ initialInput: null }) }),
        result("b", { metrics: usage({ initialInput: 200 }) }),
        result("bad", { metrics: usage({ cacheRead: NaN }) }),
      ]),
    );
    expect(rows[0]).toMatchObject({
      success: 3,
      validSamples: 2,
      metrics: {
        initialInput: { n: 1, median: 200, total: 200 },
        totalTokens: { n: 2, total: 660 },
      },
    });
  });
  const failureStatuses: Result["status"][] = [
    "failed",
    "timeout",
    "cancelled",
    "fixture-drift",
    "invalid-route",
    "invalid-schema",
    "usage-incomplete",
  ];
  it.each(failureStatuses)("keeps %s visible", (status) => {
    const failed = result("failed", { status, success: false, metrics: null });
    const row = summarize(batch([failed]))[0];
    expect(row).toMatchObject({ tried: 1, success: 0, validSamples: 0, statuses: { [status]: 1 } });
    expect(row?.metrics.totalTokens.total).toBeNull();
  });
});

describe("textReport", () => {
  it("shows counts, singleton values, cache totals, and observed details without pricing or percentages", () => {
    const text = textReport(
      batch([
        result("a", {
          warnings: [
            "route needs review",
            "Source limitation: OpenCode 1.18.29 normalizes absent upstream usage fields to zero; stored zeros do not prove measured zeros.",
          ],
          codeMode: "used",
          session: {
            configPath: "/runs/a/opencode.json",
            databasePath: "/runs/a/opencode.db",
            workDirectory: "/runs/a/work",
            settings: ["OpenCode 1.18.30", "Model: openai/gpt-5.6-terra"],
          },
          tools: [{ name: "bash", status: "completed", command: "gh api repos/owner/repo" }],
        }),
      ]),
    );
    expect(text).toContain("1 success / 1 tried | 1 valid telemetry");
    expect(text).toContain("Initial input + cache: 100 (n=1); total=100");
    expect(text).toContain("Session input (all requests): 300 (n=1); total=300");
    expect(text).toContain("Cache read: 200 (n=1); total=200");
    expect(text).toContain("Session: session-a");
    expect(text).toContain("Agent: opencode");
    expect(text).toContain("Configuration:");
    expect(text).toContain("Model: openai/gpt-5.6-terra");
    expect(text).toContain("Config: /runs/a/opencode.json");
    expect(text).toContain("Database: /runs/a/opencode.db");
    expect(text).toContain("Work directory: /runs/a/work");
    expect(text).toContain("Route: bash | Code Mode: used");
    expect(text).toContain("Route verified: yes");
    expect(text).toContain("Schema compliant: yes");
    expect(text).toContain("Values accurate: yes");
    expect(text).toContain("Inspect in agent:");
    expect(text).toContain("opencode '/runs/a/work' --pure --session 'session-a' --agent bench");
    expect(text).toContain("route needs review");
    expect(text).toContain("Source limitation: OpenCode normalizes");
    expect(text).not.toContain("1.18.29");
    expect(text).toContain("gh api repos/owner/repo");
    expect(text).not.toMatch(/\$|%/);
    expect(text).not.toContain("\u001b");
  });

  it("builds OpenCode 2 inspection commands and explains unavailable sessions", () => {
    const opencode2 = result("v2", {
      trial: {
        id: "v2",
        agent: "opencode2",
        workload: "task",
        technique: "mcp-tuned",
        repetition: 1,
      },
      sessionID: "ses_test",
      session: {
        configPath: "/bench/attempts/run_trial/opencode2-abc/bench.json",
        databasePath: "/bench/attempts/run_trial/opencode2-abc/usage.jsonl",
        workDirectory: "/bench/attempts/run_trial/opencode2-abc/work",
        settings: [],
        dataKind: "jsonl",
      },
    });
    expect(sessionInspection(opencode2).command).toContain(
      "OPENCODE_DB='/bench/opencode2/opencode.db'",
    );
    expect(sessionInspection(opencode2).command).toContain(
      "opencode2 --standalone --session 'ses_test'",
    );
    expect(
      sessionInspection(
        result("claude", {
          trial: { ...opencode2.trial, agent: "claude" },
        }),
      ).unavailable,
    ).toContain("persistence was disabled");
  });
  it("shows ranges and unknown failed samples, and neutralizes terminal controls", () => {
    const text = textReport(
      batch([
        result("a"),
        result("b", { metrics: usage({ initialInput: 200 }) }),
        result("bad", {
          status: "timeout",
          success: false,
          metrics: null,
          answer: "\u001b[2J\nunsafe\u009b",
        }),
      ]),
    );
    expect(text).toContain("150 median [100..200] (n=2)");
    expect(text).toContain("timeout=1");
    expect(text).toContain("Initial input + cache: unknown");
    expect(text).toContain("Answer: \\x1b[2J\\x0aunsafe\\x9b");
    expect(text).not.toContain("\u001b");
  });
  it("handles an empty batch", () => {
    expect(summarize(batch([]))).toEqual([]);
    expect(textReport(batch([]))).toContain("No trials.");
    expect(parseCsv(csvReport(batch([])))).toEqual([]);
  });
});

describe("csvReport", () => {
  it("retains partial and failed observed usage without adding it to summary totals", () => {
    const records = parseCsv(
      csvReport(
        batch([
          result("partial", { status: "usage-incomplete", metrics: usage({ complete: false }) }),
          result("failed", { status: "failed", success: false }),
        ]),
      ),
    );
    expect(records[0]).toMatchObject({
      success: "1",
      tried: "2",
      valid_samples: "0",
      totalTokens_n: "0",
      totalTokens_total: "",
    });
    expect(records[1]).toMatchObject({
      telemetry_complete: "false",
      route_valid: "true",
      schema_valid: "true",
      value_matches: "true",
      totalTokens: "330",
      valid_samples: "0",
    });
    expect(records[2]).toMatchObject({
      telemetry_complete: "true",
      totalTokens: "330",
      valid_samples: "0",
    });
  });

  it("exports summary statistics separately from observed attempt values", () => {
    const records = parseCsv(
      csvReport(
        batch([
          result("good"),
          result("failed", { status: "failed", success: false, metrics: null }),
        ]),
      ),
    );
    expect(records[0]).toMatchObject({
      record_type: "summary",
      success: "1",
      tried: "2",
      valid_samples: "1",
      totalTokens_n: "1",
      totalTokens_median: "330",
      totalTokens_total: "330",
    });
    expect(records[1]).toMatchObject({
      record_type: "attempt",
      trial_id: "good",
      telemetry_complete: "true",
      totalTokens: "330",
      totalTokens_total: "",
    });
    expect(records[2]).toMatchObject({
      status: "failed",
      telemetry_complete: "",
      totalTokens: "",
      valid_samples: "0",
    });
  });
  it("round-trips commas, quotes, CRLF, and free text", () => {
    const answer = 'A,"quoted"\r\nanswer';
    const records = parseCsv(
      csvReport(batch([result("id-1", { answer, warnings: ['a,"b"', "second"] })])),
    );
    expect(records[1]).toMatchObject({ trial_id: "id-1", answer, warnings: 'a,"b"\nsecond' });
  });
  it.each(["=1+1", "+SUM(A1)", "-1+2", "@SUM(A1)", "  =1", "\ttext", "\rtext", "\ntext"])(
    "neutralizes formula-leading free text: %j",
    (value) => {
      const input = batch([result(value, { answer: value, warnings: [value], sessionID: value })]);
      input.manifest.id = value;
      const records = parseCsv(csvReport(input));
      expect(records[0]?.batch_id).toBe(`'${value}`);
      expect(records[1]).toMatchObject({
        trial_id: `'${value}`,
        answer: `'${value}`,
        warnings: `'${value}`,
        session_id: `'${value}`,
      });
    },
  );
});
