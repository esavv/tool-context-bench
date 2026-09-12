import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { dirname, join } from "node:path";
import type { Batch, BatchHistory, Benchmark, Metrics, Result, Trial } from "./types.js";
import { batchAgentProfiles, batchFields, combineBatches, selectionProblem } from "./batches.js";
import { agentLabel, agentSchema } from "./agents.js";

type Metric = Exclude<keyof Metrics, "complete">;
const metrics: { key: Metric; label: string }[] = [
  { key: "initialInput", label: "Initial input + cache" },
  { key: "totalInput", label: "Session input (all requests)" },
  { key: "totalTokens", label: "Total session tokens" },
  { key: "cacheRead", label: "Cache read" },
  { key: "cacheWrite", label: "Cache write" },
  { key: "freshInput", label: "Fresh input" },
  { key: "totalOutput", label: "Output" },
  { key: "reasoning", label: "Reasoning" },
  { key: "steps", label: "Steps" },
];
const workloads: Trial["workload"][] = ["task", "noop"];
const benchmarks: Benchmark[] = ["github", "suite"];
const techniques: Trial["technique"][] = [
  "bash",
  "mcp-raw",
  "mcp-filter",
  "mcp-filter-readonly",
  "mcp-tuned",
  "tool-search",
  "executor",
];

export function techniqueLabel(technique: Trial["technique"]): string {
  return technique === "executor" ? "Executor (code execution)" : technique;
}

export interface Statistics {
  n: number;
  median: number | null;
  min: number | null;
  max: number | null;
  total: number | null;
}

export interface SummaryRow {
  agent: Trial["agent"];
  workload: Trial["workload"];
  technique: Trial["technique"];
  tried: number;
  success: number;
  validSamples: number;
  pending: number;
  statuses: Partial<Record<Result["status"], number>>;
  metrics: Record<Metric, Statistics>;
}

export function statistics(values: readonly (number | null)[]): Statistics {
  const sorted = values
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const n = sorted.length;
  const lower = sorted[Math.floor((n - 1) / 2)];
  const upper = sorted[Math.floor(n / 2)];
  return {
    n,
    median: lower === undefined || upper === undefined ? null : lower / 2 + upper / 2,
    min: sorted[0] ?? null,
    max: sorted[n - 1] ?? null,
    total: n === 0 ? null : sorted.reduce((sum, value) => sum + value, 0),
  };
}

function validSample(result: Result): boolean {
  const usage = result.metrics;
  return (
    result.status === "complete" &&
    usage !== null &&
    usage.complete &&
    metrics.every(({ key }) => {
      const value = usage[key];
      return (
        (key === "initialInput" && value === null) ||
        (value !== null && Number.isFinite(value) && value >= 0)
      );
    })
  );
}

export function summarize(batch: Batch): SummaryRow[] {
  const rows: SummaryRow[] = [];
  for (const workload of workloads) {
    for (const technique of techniques) {
      for (const agent of agentSchema.options) {
        const results = batch.results.filter(
          (result) =>
            result.trial.workload === workload &&
            result.trial.technique === technique &&
            result.trial.agent === agent,
        );
        const planned = batch.manifest.schedule.filter(
          (trial) =>
            trial.workload === workload && trial.technique === technique && trial.agent === agent,
        );
        if (results.length === 0 && planned.length === 0) continue;
        const samples = results.filter(validSample);
        const stat = (key: Metric) =>
          statistics(samples.map((result) => result.metrics?.[key] ?? null));
        const statuses: SummaryRow["statuses"] = {};
        for (const result of results) statuses[result.status] = (statuses[result.status] ?? 0) + 1;
        rows.push({
          agent,
          workload,
          technique,
          tried: results.length,
          success: results.filter((result) => result.success).length,
          validSamples: samples.length,
          pending: planned.filter(
            (trial) => !results.some((result) => result.trial.id === trial.id),
          ).length,
          statuses,
          metrics: {
            initialInput: stat("initialInput"),
            totalInput: stat("totalInput"),
            totalTokens: stat("totalTokens"),
            cacheRead: stat("cacheRead"),
            cacheWrite: stat("cacheWrite"),
            freshInput: stat("freshInput"),
            totalOutput: stat("totalOutput"),
            reasoning: stat("reasoning"),
            steps: stat("steps"),
          },
        });
      }
    }
  }
  return rows;
}

function number(value: number | null): string {
  return value === null || !Number.isFinite(value) || value < 0 ? "unknown" : String(value);
}

function describe(stat: Statistics): string {
  if (stat.n === 0) return "unknown (n=0)";
  if (stat.n === 1) return `${number(stat.median)} (n=1)`;
  return `${number(stat.median)} median [${number(stat.min)}..${number(stat.max)}] (n=${stat.n})`;
}

// Saved answers and tool output must not execute terminal control sequences.
function safeText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159)
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : character;
  }).join("");
}

function counts(row: SummaryRow): string {
  return `${row.success} success / ${row.tried} tried | ${row.validSamples} valid telemetry | ${row.pending} pending`;
}

function statuses(row: SummaryRow): string {
  return (
    Object.entries(row.statuses)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => `${status}=${count}`)
      .join(" ") || "not started"
  );
}

function warningText(warning: string): string {
  // Earlier saved batches embedded the collector's source version in this note.
  return warning.replace(
    /^Source limitation: OpenCode \d+\.\d+\.\d+ normalizes/,
    "Source limitation: OpenCode normalizes",
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function sessionInspection(result: Result): { command?: string; unavailable?: string } {
  const session = result.session;
  const sessionID = result.sessionID;
  if (result.trial.agent === "pi") {
    return { unavailable: "Pi session persistence was disabled; inspect the saved JSONL." };
  }
  if (!session || !sessionID) {
    return { unavailable: "No native persisted session is available." };
  }
  if (result.trial.agent === "claude") {
    return { command: `claude --resume ${shellQuote(sessionID)}` };
  }
  const env = (values: Record<string, string>) =>
    Object.entries(values)
      .map(([name, value]) => `${name}=${shellQuote(value)}`)
      .join(" ");
  if (result.trial.agent === "opencode2") {
    const runtime = dirname(session.configPath);
    const root = dirname(dirname(dirname(runtime)));
    return {
      command: `${env({
        OPENCODE_DB: join(root, "opencode2", "opencode.db"),
        OPENCODE_CONFIG: session.configPath,
        OPENCODE_CONFIG_DIR: join(runtime, "config"),
        OPENCODE_CONFIG_PROJECT_DISABLE: "true",
      })} opencode2 --standalone --session ${shellQuote(sessionID)} ${shellQuote(session.workDirectory)}`,
    };
  }
  if (result.trial.agent === "opencode") {
    const runtime = dirname(session.configPath);
    return {
      command: `${env({
        HOME: join(runtime, "home"),
        XDG_CONFIG_HOME: join(runtime, "config"),
        XDG_DATA_HOME: join(runtime, "data"),
        XDG_CACHE_HOME: join(runtime, "cache"),
        XDG_STATE_HOME: join(runtime, "state"),
        OPENCODE_CONFIG: session.configPath,
        OPENCODE_DB: session.databasePath,
        OPENCODE_PURE: "true",
      })} opencode ${shellQuote(session.workDirectory)} --pure --session ${shellQuote(sessionID)} --agent bench`,
    };
  }
  const codexHome = dirname(session.configPath);
  const home = dirname(codexHome);
  const runtime = dirname(home);
  return {
    command: `${env({
      HOME: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(runtime, "config"),
      XDG_DATA_HOME: join(runtime, "data"),
      XDG_CACHE_HOME: join(runtime, "cache"),
      XDG_STATE_HOME: join(runtime, "state"),
    })} codex resume --strict-config --include-non-interactive -C ${shellQuote(session.workDirectory)} ${shellQuote(sessionID)}`,
  };
}

function details(result: Result): string[] {
  const inspection = sessionInspection(result);
  const grading = result.grading;
  return [
    `${safeText(result.origin?.trialID ?? result.trial.id)} | ${result.status} | success=${result.success}`,
    ...(result.origin ? [`Batch: ${safeText(result.origin.batchID)}`] : []),
    `Agent: ${agentLabel(result.trial.agent)}`,
    `Session: ${safeText(result.sessionID ?? "unknown")} | ${result.durationMs} ms`,
    `Route: ${techniqueLabel(result.trial.technique)} | Code Mode: ${result.codeMode}`,
    `Schema compliant: ${grading === null ? "unknown" : grading.schemaValid ? "yes" : "no"}`,
    `Values accurate: ${grading?.valueMatches === null || grading === null ? "unknown" : grading.valueMatches ? "yes" : "no"}`,
    ...(result.session
      ? [
          "Configuration:",
          ...result.session.settings.map((setting) => `  ${safeText(setting)}`),
          `  Config: ${safeText(result.session.configPath)}`,
          `  ${result.session.dataKind === "jsonl" ? "Session data" : "Database"}: ${safeText(result.session.databasePath)}`,
          `  Work directory: ${safeText(result.session.workDirectory)}`,
        ]
      : []),
    ...(inspection.command
      ? ["Inspect in agent:", `  ${safeText(inspection.command)}`]
      : [
          `Inspect in agent: unavailable (${safeText(inspection.unavailable ?? "unknown reason")})`,
        ]),
    `Telemetry: ${validSample(result) ? "valid summary sample" : "excluded from summary"}`,
    ...metrics.map(
      ({ key, label }) =>
        `${label}: ${number(result.metrics?.[key] ?? null)}${result.metrics?.complete === false ? " (partial)" : ""}`,
    ),
    "Tools (observed; not a request trace):",
    ...(result.tools.length === 0
      ? ["  none observed"]
      : result.tools.map(
          (tool) =>
            `  ${safeText(tool.name)} [${safeText(tool.status)}]${tool.command === undefined ? "" : ` ${safeText(tool.command)}`}`,
        )),
    "Warnings:",
    ...(result.warnings.length === 0
      ? ["  none"]
      : result.warnings.map((warning) => `  ${safeText(warningText(warning))}`)),
    `Answer: ${safeText(result.answer) || "(empty)"}`,
  ];
}

export function textReport(batch: Batch): string {
  const lines = [
    `TOOL CONTEXT BENCH | ${safeText(batch.manifest.id)}`,
    batchAgentProfiles(batch)
      .map(
        ({ agent, version, model }) =>
          `${agentLabel(agent)} ${safeText(version)} | ${safeText(model)}`,
      )
      .join(" · "),
    "Tokens: complete telemetry samples, independent of answer accuracy.",
    "Statistics: median and observed range; totals sum valid samples, not all attempts.",
  ];
  const rows = summarize(batch);
  if (rows.length === 0) lines.push("No trials.");
  for (const workload of workloads) {
    const group = rows.filter((row) => row.workload === workload);
    if (group.length === 0) continue;
    lines.push("", `[${workload}]`);
    for (const row of group) {
      lines.push(
        `${techniqueLabel(row.technique)} | ${agentLabel(row.agent)} | ${counts(row)}`,
        `  ${statuses(row)}`,
      );
      for (const { key, label } of metrics) {
        lines.push(
          `  ${label}: ${describe(row.metrics[key])}; total=${number(row.metrics[key].total)}`,
        );
      }
      for (const result of batch.results.filter(
        (item) =>
          item.trial.workload === workload &&
          item.trial.technique === row.technique &&
          item.trial.agent === row.agent,
      ))
        lines.push(...details(result).map((line) => `  ${line}`));
    }
  }
  return `${lines.join("\n")}\n`;
}

function csvField(value: string | number | boolean | null): string {
  let text = value === null ? "" : String(value);
  // Quoting alone does not stop spreadsheet formula execution, even in IDs.
  if (typeof value === "string" && (/^\s*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Summary rows contain statistics; attempt rows retain observed, possibly partial usage. */
export function csvReport(batch: Batch): string {
  const header = [
    "record_type",
    "batch_id",
    "workload",
    "technique",
    "agent",
    "trial_id",
    "status",
    "success",
    "schema_valid",
    "value_matches",
    "tried",
    "valid_samples",
    "pending",
    "telemetry_complete",
    "session_id",
    "code_mode",
    "warnings",
    "tools",
    "answer",
    ...metrics.flatMap(({ key }) => [
      key,
      `${key}_n`,
      `${key}_median`,
      `${key}_min`,
      `${key}_max`,
      `${key}_total`,
    ]),
  ];
  const records: (string | number | boolean | null)[][] = [header];
  for (const row of summarize(batch)) {
    records.push([
      "summary",
      batch.manifest.id,
      row.workload,
      row.technique,
      row.agent,
      null,
      statuses(row),
      row.success,
      null,
      null,
      row.tried,
      row.validSamples,
      row.pending,
      null,
      null,
      null,
      null,
      null,
      null,
      ...metrics.flatMap(({ key }) => {
        const stat = row.metrics[key];
        return [null, stat.n, stat.median, stat.min, stat.max, stat.total];
      }),
    ]);
    for (const result of batch.results.filter(
      (item) =>
        item.trial.workload === row.workload &&
        item.trial.technique === row.technique &&
        item.trial.agent === row.agent,
    )) {
      records.push([
        "attempt",
        batch.manifest.id,
        row.workload,
        row.technique,
        row.agent,
        result.trial.id,
        result.status,
        result.success,
        result.grading?.schemaValid ?? null,
        result.grading?.valueMatches ?? null,
        1,
        validSample(result) ? 1 : 0,
        null,
        result.metrics?.complete ?? null,
        result.sessionID,
        result.codeMode,
        result.warnings.map(warningText).join("\n"),
        JSON.stringify(result.tools),
        result.answer,
        ...metrics.flatMap(({ key }) => [
          result.metrics?.[key] ?? null,
          null,
          null,
          null,
          null,
          null,
        ]),
      ]);
    }
  }
  return `${records.map((record) => record.map(csvField).join(",")).join("\r\n")}\r\n`;
}

const palette = {
  border: "#687853",
  muted: "#86928a",
  track: "#343c38",
  teal: "#74d7c4",
  claude: "#d97757",
  codex: "#74d7c4",
  opencode: "#73a7ef",
  opencode2: "#c49aef",
  pi: "#d4a85f",
  key: "#dabe73",
  amber: "#dabe73",
  white: "#e2e9df",
};

const gradients = new Map<Trial["agent"], string[]>(
  agentSchema.options.map((agent): [Trial["agent"], string[]] => {
    const channels = [1, 3, 5].map((offset) =>
      Number.parseInt(palette[agent].slice(offset, offset + 2), 16),
    );
    return [
      agent,
      Array.from({ length: 101 }, (_, step) => {
        const brightness = 0.35 + 0.65 * Math.min(1, step / 70);
        return `#${channels
          .map((channel) =>
            Math.round(channel * brightness)
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")}`;
      }),
    ];
  }),
);

function inkColor(color: string) {
  return process.env.NO_COLOR === undefined ? { color } : {};
}

function formatted(value: number | null): string {
  return value === null ? "unknown" : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function Panel({ title, width, children }: { title: string; width: number; children: ReactNode }) {
  const heading = `─ ${title} `;
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Text {...inkColor(palette.border)} wrap="truncate-end">
        ╭
        <Text {...inkColor(palette.white)} bold>
          {heading}
        </Text>
        {"─".repeat(Math.max(0, width - heading.length - 2))}╮
      </Text>
      <Box
        borderStyle="round"
        borderTop={false}
        {...(process.env.NO_COLOR === undefined ? { borderColor: palette.border } : {})}
        flexDirection="column"
        paddingX={1}
      >
        {children}
      </Box>
    </Box>
  );
}

function Meter({
  value,
  max,
  width,
  agent,
}: {
  value: number | null;
  max: number;
  width: number;
  agent: Trial["agent"];
}) {
  const fill = value === null || max === 0 ? 0 : Math.round((value / max) * width * 8);
  return (
    <Text>
      {Array.from({ length: width }, (_, index) => {
        const amount = Math.max(0, Math.min(8, fill - index * 8));
        return (
          <Text
            key={index}
            {...inkColor(
              amount === 0
                ? palette.track
                : (gradients.get(agent)?.[Math.round((index / Math.max(1, width - 1)) * 100)] ??
                    palette[agent]),
            )}
          >
            {amount === 0 ? "━" : "▏▎▍▌▋▊▉█"[amount - 1]}
          </Text>
        );
      })}
    </Text>
  );
}

function App({ batch: initialBatch, history }: { batch: Batch; history: BatchHistory }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns || 80, height: stdout.rows || 24 });
  const allBatches = history.batches.some((batch) => batch.manifest.id === initialBatch.manifest.id)
    ? history.batches
    : [initialBatch, ...history.batches];
  const [viewBenchmark, setViewBenchmark] = useState<Benchmark>(initialBatch.manifest.benchmark);
  const available = allBatches.filter((batch) => batch.manifest.benchmark === viewBenchmark);
  const [batchIDsByBenchmark, setBatchIDsByBenchmark] = useState<Record<Benchmark, Set<string>>>(
    () => ({
      github: new Set(
        initialBatch.manifest.benchmark === "github"
          ? [initialBatch.manifest.id]
          : allBatches
              .filter((batch) => batch.manifest.benchmark === "github")
              .slice(0, 1)
              .map((batch) => batch.manifest.id),
      ),
      suite: new Set(
        initialBatch.manifest.benchmark === "suite"
          ? [initialBatch.manifest.id]
          : allBatches
              .filter((batch) => batch.manifest.benchmark === "suite")
              .slice(0, 1)
              .map((batch) => batch.manifest.id),
      ),
    }),
  );
  const batchIDs = batchIDsByBenchmark[viewBenchmark];
  const [batchCursor, setBatchCursor] = useState(
    Math.max(
      0,
      available.findIndex((batch) => batch.manifest.id === initialBatch.manifest.id),
    ),
  );
  const [notice, setNotice] = useState("");
  const selectedBatches = available.filter((batch) => batchIDs.has(batch.manifest.id));
  const batch = combineBatches(selectedBatches, initialBatch);
  const [workload, setWorkload] = useState<Trial["workload"]>(
    initialBatch.manifest.schedule[0]?.workload ?? "task",
  );
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [scroll, setScroll] = useState(0);
  useEffect(() => {
    const resize = () => setSize({ width: stdout.columns || 80, height: stdout.rows || 24 });
    stdout.on("resize", resize);
    return () => {
      stdout.off("resize", resize);
    };
  }, [stdout]);
  const rows = summarize(batch).filter((row) => row.workload === workload);
  const row = rows[selected] ?? rows[0];
  const results = batch.results.filter(
    (result) =>
      result.trial.workload === workload &&
      result.trial.technique === row?.technique &&
      result.trial.agent === row?.agent,
  );
  const result = results[attempt];
  const width = Math.max(24, Math.min(160, size.width));
  const batchRows = available.map(batchFields);
  const columnSpecs: {
    key: keyof ReturnType<typeof batchFields>;
    heading: string;
    numeric?: boolean;
  }[] = [
    { key: "timestamp", heading: "Timestamp" },
    { key: "benchmark", heading: "Benchmark" },
    { key: "workload", heading: "Workload" },
    { key: "agents", heading: "Agents" },
    { key: "repeats", heading: "Repeats", numeric: true },
    { key: "sessions", heading: "Sessions", numeric: true },
    { key: "id", heading: "Batch ID" },
  ];
  const columns = columnSpecs.map((column) => ({
    ...column,
    width: Math.min(
      width - 10,
      Math.max(
        column.heading.length,
        ...batchRows.map((item) => safeText(String(item[column.key])).length),
      ),
    ),
  }));
  const bands: (typeof columns)[] = [[]];
  let bandWidth = 0;
  for (const column of columns) {
    if (bandWidth && bandWidth + 2 + column.width > width - 10) {
      bands.push([]);
      bandWidth = 0;
    }
    bands.at(-1)?.push(column);
    bandWidth += (bandWidth ? 2 : 0) + column.width;
  }
  const gridLine = (band: typeof columns, item?: ReturnType<typeof batchFields>) =>
    band
      .map((column) => {
        const value = safeText(item ? String(item[column.key]) : column.heading);
        const text =
          value.length > column.width ? `${value.slice(0, Math.max(0, column.width - 1))}…` : value;
        return column.numeric ? text.padStart(column.width) : text.padEnd(column.width);
      })
      .join("  ");
  const batchRowLines = bands.length;
  const keyRows = (items: [string, string][]) => {
    const lines: ReactNode[][] = [[]];
    let used = 0;
    for (const [key, name] of items) {
      const length = key.length + name.length + 1;
      if (used && used + 2 + length > width) {
        lines.push([]);
        used = 0;
      }
      lines[lines.length - 1]?.push(
        <Text key={key} {...inkColor(palette.muted)}>
          {used ? "  " : ""}
          <Text {...inkColor(palette.key)}>{key}</Text> {name}
        </Text>,
      );
      used += (used ? 2 : 0) + length;
    }
    return lines;
  };
  const chartLegend = keyRows(
    detail
      ? [
          ["esc", "back"],
          ["↑↓", "scroll"],
          ["←→", "attempt"],
          ["PgUp/Dn", "page"],
          ["q", "quit"],
        ]
      : [
          ["↑↓", "select"],
          ["enter", "detail"],
          ["q", "quit"],
        ],
  );
  const batchPageSize = Math.min(
    20,
    available.length,
    Math.max(
      1,
      Math.floor(
        (size.height -
          11 -
          batchRowLines -
          chartLegend.length -
          (width < 60 ? 2 : 1) -
          6 -
          (notice ? 1 : 0)) /
          batchRowLines,
      ),
    ),
  );
  const batchTop = Math.max(
    0,
    Math.min(batchCursor - batchPageSize + 1, available.length - batchPageSize),
  );
  const batchLegend = keyRows([
    ["j/k", "move"],
    ["space", "toggle"],
    [
      "",
      `batches ${batchTop + 1}–${Math.min(batchTop + batchPageSize, available.length)} / ${available.length}${history.unavailable ? ` · ${history.unavailable} unreadable` : ""}`,
    ],
  ]);
  const pageSize = Math.max(
    1,
    size.height -
      (detail ? 2 : 3) -
      chartLegend.length -
      (detail ? 0 : batchLegend.length) -
      (detail ? 0 : batchPageSize * batchRowLines) -
      7 -
      (detail ? 0 : batchRowLines) -
      (detail ? 0 : 1) -
      (!detail && notice ? 1 : 0),
  );
  const groups = techniques
    .map((technique) => rows.filter((item) => item.technique === technique))
    .filter((group) => group.length);
  const selectedGroup = Math.max(
    0,
    groups.findIndex((group) => row !== undefined && group.includes(row)),
  );
  let groupTop = 0;
  while (
    groupTop < selectedGroup &&
    groups
      .slice(groupTop, selectedGroup + 1)
      .reduce((height, group) => height + group.length + 3, 0) > pageSize
  )
    groupTop++;
  const visibleGroups: SummaryRow[][] = [];
  let chartHeight = 0;
  for (const group of groups.slice(groupTop)) {
    if (chartHeight + group.length + 3 > pageSize) {
      if (visibleGroups.length === 0) {
        const capacity = Math.max(1, pageSize - 3);
        const start = Math.max(0, (row ? group.indexOf(row) : 0) - capacity + 1);
        visibleGroups.push(group.slice(start, start + capacity));
      }
      break;
    }
    visibleGroups.push(group);
    chartHeight += group.length + 3;
  }
  const initialMax = Math.max(0, ...rows.map((item) => item.metrics.initialInput.median ?? 0));
  const totalMax = Math.max(0, ...rows.map((item) => item.metrics.totalTokens.median ?? 0));
  const visibleRange =
    visibleGroups.flat().length < rows.length
      ? ` · groups ${groupTop + 1}–${groupTop + visibleGroups.length}/${groups.length}`
      : "";
  const barCounts = (item: SummaryRow) =>
    `${item.success}/${item.tried} success${item.pending > 0 ? ` · ${item.pending} pending` : ""}`;
  const chartValue = (item: SummaryRow, metric: "initialInput" | "totalTokens") => {
    const stat = item.metrics[metric];
    return stat.n === 0 && item.tried === 0 && item.pending > 0
      ? "pending"
      : formatted(stat.median);
  };
  const initialValueWidth = Math.max(
    7,
    ...rows.map((item) => chartValue(item, "initialInput").length),
  );
  const totalValueWidth = Math.max(
    7,
    ...rows.map((item) => chartValue(item, "totalTokens").length),
  );
  const countWidth = Math.max(0, ...rows.map((item) => barCounts(item).length));
  const agentWidth = Math.max(...agentSchema.options.map((agent) => agentLabel(agent).length));
  const barWidth = Math.max(
    1,
    Math.floor(
      (width - 4 - (agentWidth + 2) - initialValueWidth - totalValueWidth - countWidth - 6) / 2,
    ),
  );
  const lines = (result ? details(result) : ["No attempts."]).flatMap((line) => {
    const characters = Array.from(line);
    return Array.from(
      { length: Math.max(1, Math.ceil(characters.length / (width - 4))) },
      (_, index) => characters.slice(index * (width - 4), (index + 1) * (width - 4)).join(""),
    );
  });
  const maxScroll = Math.max(0, lines.length - pageSize);
  const top = Math.min(scroll, maxScroll);
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (!detail && (input === "j" || input === "k")) {
      setBatchCursor((cursor) =>
        Math.max(0, Math.min(available.length - 1, cursor + (input === "j" ? 1 : -1))),
      );
      setNotice("");
      return;
    }
    if (!detail && input === " ") {
      const candidate = available[batchCursor];
      if (!candidate) return;
      const next = new Set(batchIDs);
      if (next.has(candidate.manifest.id)) next.delete(candidate.manifest.id);
      else next.add(candidate.manifest.id);
      const problem = selectionProblem(available.filter((batch) => next.has(batch.manifest.id)));
      if (problem) {
        setNotice(problem);
        return;
      }
      setBatchIDsByBenchmark((current) => ({ ...current, [viewBenchmark]: next }));
      setSelected(0);
      setAttempt(0);
      setScroll(0);
      setDetail(false);
      setNotice("");
      return;
    }
    if (!detail && ["1", "2", "3", "4"].includes(input)) {
      const nextBenchmark: Benchmark = Number(input) <= 2 ? "github" : "suite";
      const nextWorkload = Number(input) % 2 === 1 ? "task" : "noop";
      setViewBenchmark(nextBenchmark);
      setWorkload(nextWorkload);
      setBatchCursor(0);
      setSelected(0);
      setAttempt(0);
      setScroll(0);
      setDetail(false);
    }
    if (key.return || key.escape) {
      setDetail(key.escape ? false : !detail);
      setScroll(0);
    }
    if (detail) {
      if (key.leftArrow || key.rightArrow) {
        setAttempt(Math.max(0, Math.min(results.length - 1, attempt + (key.rightArrow ? 1 : -1))));
        setScroll(0);
      }
      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
        const delta = key.pageUp ? -pageSize : key.pageDown ? pageSize : key.upArrow ? -1 : 1;
        setScroll(Math.max(0, Math.min(maxScroll, top + delta)));
      }
    } else if (key.upArrow || key.downArrow) {
      setSelected(Math.max(0, Math.min(rows.length - 1, selected + (key.downArrow ? 1 : -1))));
      setAttempt(0);
      setScroll(0);
    }
  });
  const completed = batch.results.filter((item) => item.status !== "running").length;
  const profiles = batchAgentProfiles(batch);
  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Box flexGrow={1} flexShrink={1}>
          <Text bold {...inkColor(palette.teal)} wrap="truncate-end">
            tool context bench
            <Text bold={false} {...inkColor(palette.muted)}>
              {" "}
              · {safeText(batch.manifest.config.repository)}:
              {safeText(batch.manifest.config.branch)}
            </Text>
          </Text>
        </Box>
        <Text {...inkColor(palette.muted)}>
          {completed}/{batch.manifest.schedule.length} sessions
        </Text>
      </Box>
      <Box gap={2}>
        {benchmarks.flatMap((benchmark, benchmarkIndex) =>
          workloads.map((item, workloadIndex) => (
            <Text
              key={`${benchmark}-${item}`}
              bold={benchmark === viewBenchmark && item === workload}
              {...inkColor(
                benchmark === viewBenchmark && item === workload ? palette.white : palette.muted,
              )}
            >
              {benchmark === viewBenchmark && item === workload ? "▸" : " "}
              <Text {...inkColor(palette.key)}>{benchmarkIndex * 2 + workloadIndex + 1}</Text>{" "}
              {benchmark === "suite" ? "multi-tool " : "github "}
              {item === "noop" ? "no-op" : item}
            </Text>
          )),
        )}
      </Box>
      {detail ? (
        <Panel
          title={`${workload} / ${row ? techniqueLabel(row.technique) : "none"} / ${row ? agentLabel(row.agent) : "none"} · attempt ${results.length ? attempt + 1 : 0}/${results.length}`}
          width={width}
        >
          {lines.slice(top, top + pageSize).map((line, index) => (
            <Text key={top + index}>{line}</Text>
          ))}
          <Text {...inkColor(palette.muted)}>
            lines {top + 1}–{Math.min(top + pageSize, lines.length)} / {lines.length}
          </Text>
        </Panel>
      ) : (
        <Panel
          title={`${viewBenchmark === "suite" ? "multi-tool" : "github"} ${workload}${visibleRange}`}
          width={width}
        >
          <Box marginLeft={agentWidth + 3}>
            <Box width={barWidth + initialValueWidth + 1} justifyContent="center">
              <Text bold {...inkColor(palette.white)} wrap="truncate-end">
                Initial input + cache · median 0–{formatted(initialMax)}
              </Text>
            </Box>
            <Box width={2} />
            <Box width={barWidth + totalValueWidth + 1} justifyContent="center">
              <Text bold {...inkColor(palette.white)} wrap="truncate-end">
                Total session tokens · median 0–{formatted(totalMax)}
              </Text>
            </Box>
          </Box>
          <Text> </Text>
          {visibleGroups.map((group) => (
            <Box key={group[0]?.technique} flexDirection="column">
              <Text bold {...inkColor(palette.white)}>
                {group[0] ? techniqueLabel(group[0].technique) : ""}
              </Text>
              <Text> </Text>
              {group.map((item) => {
                const initial = item.metrics.initialInput;
                const total = item.metrics.totalTokens;
                return (
                  <Text key={item.agent} wrap="truncate-end">
                    <Text bold={item === row} {...inkColor(palette[item.agent])}>
                      {item === row ? "▸" : " "} {agentLabel(item.agent).padEnd(agentWidth)}
                    </Text>{" "}
                    <Meter
                      agent={item.agent}
                      value={initial.median}
                      max={initialMax}
                      width={barWidth}
                    />{" "}
                    <Text {...inkColor(initial.n ? palette.white : palette.amber)}>
                      {chartValue(item, "initialInput").padStart(initialValueWidth)}
                    </Text>
                    {"  "}
                    <Meter
                      agent={item.agent}
                      value={total.median}
                      max={totalMax}
                      width={barWidth}
                    />{" "}
                    <Text {...inkColor(total.n ? palette.white : palette.amber)}>
                      {chartValue(item, "totalTokens").padStart(totalValueWidth)}
                    </Text>{" "}
                    <Text
                      {...inkColor(item.validSamples < item.tried ? palette.amber : palette.muted)}
                    >
                      {barCounts(item)}
                    </Text>
                  </Text>
                );
              })}
              <Text> </Text>
            </Box>
          ))}
          {rows.length === 0 && (
            <Text {...inkColor(palette.amber)}>
              {selectedBatches.length
                ? "No trials in this workload. Select another tab or batch."
                : "No batches selected. Use Space in the batch list."}
            </Text>
          )}
          {rows.length === 0 && <Text> </Text>}
          <Text {...inkColor(palette.muted)} wrap="truncate-end">
            {selectedBatches.length
              ? profiles.map(({ agent, model }, index) => (
                  <Text key={agent}>
                    {index ? " · " : ""}
                    <Text {...inkColor(palette[agent])}>{agentLabel(agent)}</Text>{" "}
                    {safeText(
                      model
                        .replace(/^openai\//, "")
                        .replace(/^claude-sonnet-5$/, "Sonnet 5")
                        .replace(/^gpt-5\.6-terra$/, "GPT Terra"),
                    )}
                  </Text>
                ))
              : "Select one or more batches below."}
            {` · ${selectedBatches.length} selected batch${selectedBatches.length === 1 ? "" : "es"}`}
          </Text>
        </Panel>
      )}
      {chartLegend.map((line, index) => (
        <Text key={index}>{line}</Text>
      ))}
      {!detail && (
        <Box marginTop={1} flexDirection="column">
          <Panel title={`batches · ${selectedBatches.length} selected`} width={width}>
            {bands.map((band, index) => (
              <Text key={index} bold {...inkColor(palette.key)} wrap="truncate-end">
                {"      "}
                {gridLine(band)}
              </Text>
            ))}
            <Text {...inkColor(palette.border)}>{"─".repeat(width - 4)}</Text>
            {available.slice(batchTop, batchTop + batchPageSize).map((item, index) => {
              const checked = batchIDs.has(item.manifest.id);
              const focused = batchTop + index === batchCursor;
              const fields = batchRows[batchTop + index];
              return (
                <Box key={item.manifest.id} flexDirection="column">
                  {bands.map((band, bandIndex) => (
                    <Text
                      key={bandIndex}
                      bold={focused}
                      {...inkColor(focused ? palette.white : palette.muted)}
                      wrap="truncate-end"
                    >
                      {bandIndex === 0 ? (
                        <>
                          {focused ? "▸" : " "}{" "}
                          <Text {...inkColor(checked ? palette.teal : palette.muted)}>
                            [{checked ? "✓" : " "}]
                          </Text>{" "}
                        </>
                      ) : (
                        "      "
                      )}
                      {gridLine(band, fields)}
                    </Text>
                  ))}
                </Box>
              );
            })}
            {notice && (
              <Text {...inkColor(palette.amber)} wrap="truncate-end">
                {notice}
              </Text>
            )}
          </Panel>
          {batchLegend.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** Saved view only. Resolves on q/Ctrl-C; never starts or cancels a runner. */
export async function renderReport(
  batch: Batch,
  history: BatchHistory = { batches: [batch], unavailable: 0 },
): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(textReport(batch), (error) => (error ? reject(error) : resolve()));
    });
    return;
  }
  process.stdout.write("\u001b[?1049h\u001b[2J\u001b[H");
  const instance = render(<App batch={batch} history={history} />, {
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await instance.waitUntilExit();
  } finally {
    instance.unmount();
    instance.cleanup();
    process.stdout.write("\u001b[?1049l");
  }
}
