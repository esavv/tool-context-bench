import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AgentUsage, PreparedAgent } from "./adapter.js";
import type { Config, Paths } from "./config.js";
import { EventCollector } from "./events.js";
import type { ExecutorConnection } from "./executor.js";
import { MCP_URL, type Catalog } from "./github.js";
import { execute, minimalEnvironment } from "./process.js";
import { mcpHeaders, techniqueSchema } from "./techniques.js";
import { suiteBinDirectory, suiteServers, type SuiteCredentials } from "./suite.js";
import type { Benchmark, Metrics, Trial } from "./types.js";

// Release workflow run 19425: https://github.com/anomalyco/opencode/actions/runs/34425206646
export const opencode2Version = "0.0.0-beta-19425";
export const opencode2Source = "20aff6d9f643afe9abf8a048e68f019d049f5329";
const object = z.record(z.string(), z.unknown());
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_./:-]+$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rowSchema = z.object({ id: identifier, seq: count, type: z.string(), data: z.unknown() });
const tokenSchema = z.object({
  input: count.nullable().catch(null),
  output: count.nullable().catch(null),
  reasoning: count.nullable().catch(null),
  cache: z
    .object({
      read: count.nullable().catch(null),
      write: count.nullable().catch(null),
    })
    .catch({ read: null, write: null }),
});

export function mcpStartupError(
  status: { name: string; status: { status: string } }[],
  timedOut: boolean,
): string | null {
  const summary = status
    .map((server) => `${server.name}=${server.status.status}`)
    .sort()
    .join(", ");
  if (status.some((server) => !["pending", "connected"].includes(server.status.status)))
    return `OpenCode 2 MCP service failed: ${summary}.`;
  if (timedOut) return `OpenCode 2 MCP services timed out: ${summary}.`;
  return null;
}

function isolatedEnvironment(runtime: string, databasePath: string): NodeJS.ProcessEnv {
  return {
    ...minimalEnvironment(),
    HOME: join(runtime, "home"),
    PWD: join(runtime, "work"),
    XDG_CONFIG_HOME: join(runtime, "config"),
    XDG_DATA_HOME: join(runtime, "data"),
    XDG_CACHE_HOME: join(runtime, "cache"),
    XDG_STATE_HOME: join(runtime, "state"),
    TMPDIR: join(runtime, "tmp"),
    GH_CONFIG_DIR: join(runtime, "gh"),
    GH_PROMPT_DISABLED: "1",
    GH_HOST: "github.com",
    OPENCODE_CONFIG: join(runtime, "bench.json"),
    OPENCODE_CONFIG_DIR: join(runtime, "config"),
    OPENCODE_DB: databasePath,
    OPENCODE_CONFIG_PROJECT_DISABLE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_FILEWATCHER_DISABLE: "true",
    OPENCODE_DISABLE_FFF: "true",
  };
}

async function checkVersion(binary: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const version = await execute(binary, ["--version"], { env, cwd });
  if (
    version.code !== 0 ||
    version.stopped ||
    version.stdout.trim() !== `opencode2 v${opencode2Version}`
  )
    throw new Error(`OpenCode 2 requires installed version ${opencode2Version}.`);
}

/** Caller must ensureRoot/acquireLock first. This is an explicit interactive login,
 * not a preparation side effect. Native OAuth output goes to the terminal only.
 */
export async function setupOpencode2Auth(paths: Paths, binary: string): Promise<void> {
  const root = await realpath(paths.root);
  const runtime = join(root, "opencode2");
  for (const path of [
    runtime,
    ...["home", "config", "data", "cache", "state", "tmp", "work", "gh"].map((child) =>
      join(runtime, child),
    ),
  ]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("OpenCode 2 login profile must contain real private directories, not links.");
    await chmod(path, 0o700);
  }
  const databasePath = join(runtime, "opencode.db");
  const configPath = join(runtime, "bench.json");
  const protectFile = async (path: string) => {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error(
        "OpenCode 2 login profile must contain regular files, not symbolic links or hard links.",
      );
    await chmod(path, 0o600);
  };
  const databaseFiles = [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ];
  for (const path of [configPath, ...databaseFiles]) await protectFile(path);
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        update: "disable",
        share: "disabled",
        snapshots: false,
        warming: false,
        instructions: [],
        skills: [],
        mcp: { servers: {} },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
        plugins: ["-*", "opencode.models.dev", "opencode.provider.openai"],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const env = isolatedEnvironment(runtime, databasePath);
  const cwd = join(runtime, "work");
  await checkVersion(binary, env, cwd);
  // An empty file is a supported SQLite starting point; pre-create it privately
  // rather than allow a permissive inherited umask to expose the initial token write.
  try {
    await writeFile(databasePath, "", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  try {
    await new Promise<void>((resolveLogin, reject) => {
      const child = spawn(
        binary,
        ["auth", "login", "openai", "--standalone", "--method", "chatgpt-headless"],
        {
          cwd,
          env,
          stdio: "inherit",
        },
      );
      child.once("error", () => reject(new Error("Cannot start isolated OpenCode 2 login.")));
      child.once("close", (code, signal) => {
        if (code === 0 && signal === null) resolveLogin();
        else
          reject(
            new Error(
              "OpenCode 2 login failed or was cancelled. No personal credentials were imported.",
            ),
          );
      });
    });
  } finally {
    // Native SQLite may leave sidecars after failure or cancellation as well.
    for (const path of databaseFiles) await protectFile(path);
  }
  await opencode2Auth(databasePath);
}

/** Explicitly supply a benchmark-owned, persistent DB initialized by supported v2 login.
 * No credential import, login, refresh, or database write occurs in this check.
 * V2 Credential.Service and session storage share Database.Service; OPENCODE_DB
 * cannot separate credentials from sessions. Never copy this DB into artifacts.
 */
export async function opencode2Auth(databasePath: string): Promise<void> {
  try {
    if (!isAbsolute(databasePath)) throw new Error();
    const path = await realpath(databasePath);
    const info = await stat(path);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new Error();
    const personalRoots = new Set([
      join(homedir(), ".local", "share", "opencode"),
      join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode"),
    ]);
    for (const root of personalRoots) {
      let actual: string;
      try {
        actual = await realpath(root);
      } catch {
        actual = resolve(root);
      }
      const child = relative(actual, path);
      if (!child || (child !== ".." && !child.startsWith("../") && !isAbsolute(child)))
        throw new Error();
    }
    if (process.env.OPENCODE_DB && path === (await realpath(resolve(process.env.OPENCODE_DB))))
      throw new Error();
    using db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    // Match Credential.list(...).at(-1), including migrated active=NULL rows.
    // Only types and presence checks leave SQLite, never secret values.
    const row = db
      .prepare(`SELECT json_extract(value, '$.type') AS type,
      json_extract(value, '$.methodID') AS method,
      (json_type(value, '$.access') = 'text' AND length(json_extract(value, '$.access')) > 0
        AND json_type(value, '$.refresh') = 'text' AND length(json_extract(value, '$.refresh')) > 0
        AND json_type(value, '$.expires') IN ('integer', 'real')) AS valid
      FROM credential WHERE integration_id = 'openai'
      ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`)
      .get();
    if (
      row?.type !== "oauth" ||
      row.valid !== 1 ||
      !["chatgpt-browser", "chatgpt-headless"].includes(String(row.method))
    )
      throw new Error();
  } catch {
    throw new Error(
      "OpenCode 2 requires a private benchmark ChatGPT login. Run tcb auth-opencode2 with the same --root before doctor or run. Migrated personal auth cannot be reused with separate session storage in this beta. This read-only check did not copy or display credentials, start a login, or write to the database.",
    );
  }
}

/** Account step evidence. Native message projections are converted below, never V1 messages. */
export function parseOpencode2Usage(rows: unknown[], sessionID: string): AgentUsage {
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
  const warnings = new Set([
    "Source limitation: beta session/usage.ts normalizes absent provider usage to zero; stored zeros do not prove measured zeros.",
    "Scope limitation: persisted session steps are measured, not billing or unrecorded auxiliary requests.",
  ]);
  const warn = (text: string) => {
    metrics.complete = false;
    warnings.add(text);
  };
  const models = new Set<string>();
  const requests: {
    sessionID: string;
    messageID: string;
    startEventID: string | null;
    finishEventID: string | null;
    model: string | null;
    agent: string | null;
    finished: boolean;
    raw: z.infer<typeof tokenSchema> | null;
    input: number | null;
    output: number | null;
    total: number | null;
  }[] = [];
  const pending = new Map<string, (typeof requests)[number]>();
  const seen = new Map<string, string>();
  let lastSequence = -1;
  let succeeded = false;
  for (const raw of rows) {
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) {
      warn("Invalid persisted event metadata.");
      continue;
    }
    const row = parsed.data;
    const fingerprint = JSON.stringify(row);
    if (seen.has(row.id)) {
      if (seen.get(row.id) !== fingerprint) warn("Conflicting duplicate event ID.");
      continue;
    }
    seen.set(row.id, fingerprint);
    if (row.seq <= lastSequence) warn("Persisted event sequence is not strictly increasing.");
    if (lastSequence >= 0 && row.seq > lastSequence + 1)
      warn("Persisted event sequence has a gap; usage may be missing.");
    lastSequence = row.seq;
    let data: Record<string, unknown>;
    try {
      data = object.parse(typeof row.data === "string" ? JSON.parse(row.data) : row.data);
    } catch {
      warn("Invalid persisted event data.");
      continue;
    }
    if (data.sessionID !== sessionID) {
      warn("Persisted event has a different session ID.");
      continue;
    }
    if (row.type === "session.execution.succeeded.1") succeeded = true;
    if (row.type === "session.execution.started.1") succeeded = false;
    if (/^session\.(execution\.(failed|interrupted)|compaction\.|usage\.recorded)/.test(row.type))
      warn("Failed, interrupted, or auxiliary work was recorded; accounting is incomplete.");
    if (!/^session\.step\.(started|ended|failed)\.1$/.test(row.type)) {
      if (/^session\.step\.(started|ended|failed)\./.test(row.type))
        warn("Unsupported step event version.");
      continue;
    }
    const message = identifier.safeParse(data.assistantMessageID);
    if (!message.success) {
      warn("Step has no valid assistant message ID.");
      continue;
    }
    const messageID = message.data;
    if (row.type === "session.step.started.1") {
      if (pending.has(messageID)) warn("Repeated step start before settlement.");
      const model = z.object({ providerID: identifier, id: identifier }).safeParse(data.model);
      const observedModel = model.success ? `${model.data.providerID}/${model.data.id}` : null;
      if (observedModel) models.add(observedModel);
      else warn("Step has no observed model identity.");
      const request = {
        sessionID,
        messageID,
        startEventID: row.id,
        finishEventID: null,
        model: observedModel,
        agent: typeof data.agent === "string" ? data.agent : null,
        finished: false,
        raw: null,
        input: null,
        output: null,
        total: null,
      };
      requests.push(request);
      pending.set(messageID, request);
      continue;
    }
    let request = pending.get(messageID);
    if (!request) {
      warn("Step settlement has no matching start.");
      request = {
        sessionID,
        messageID,
        startEventID: null,
        finishEventID: null,
        model: null,
        agent: null,
        finished: false,
        raw: null,
        input: null,
        output: null,
        total: null,
      };
      requests.push(request);
    }
    pending.delete(messageID);
    request.finishEventID = row.id;
    request.finished = row.type === "session.step.ended.1";
    if (!request.finished) warn("Failed step observed; any reported spent tokens are retained.");
    request.raw = tokenSchema.parse(object.safeParse(data.tokens).success ? data.tokens : {});
    const tokens = request.raw;
    const sum = (values: (number | null)[]) => {
      if (values.includes(null)) return null;
      const result = values.reduce<number>((a, b) => a + (b ?? 0), 0);
      return Number.isSafeInteger(result) ? result : null;
    };
    request.input = sum([tokens.input, tokens.cache.read, tokens.cache.write]);
    request.output = sum([tokens.output, tokens.reasoning]);
    request.total = sum([request.input, request.output]);
    if (request.total === null)
      warn("Step token categories are missing, invalid, or unsafe; totals are observed subtotals.");
    if (request.total === 0) warn("All-zero normalized usage does not establish measured usage.");
    if (request.agent !== "bench") {
      warn("Non-benchmark or unknown agent usage is excluded from main metrics.");
      continue;
    }
    if (requests[0] === request && request.startEventID) metrics.initialInput = request.input;
    metrics.steps += 1;
    metrics.freshInput += tokens.input ?? 0;
    metrics.cacheRead += tokens.cache.read ?? 0;
    metrics.cacheWrite += tokens.cache.write ?? 0;
    metrics.reasoning += tokens.reasoning ?? 0;
    metrics.totalInput +=
      (tokens.input ?? 0) + (tokens.cache.read ?? 0) + (tokens.cache.write ?? 0);
    metrics.totalOutput += (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  }
  metrics.totalTokens = metrics.totalInput + metrics.totalOutput;
  if (pending.size) warn("Unsettled step starts have unknown usage.");
  if (!succeeded) warn("No successful execution boundary was recorded.");
  if (!metrics.steps) warn("No measured benchmark steps were found.");
  if (requests.length > 8)
    warn("More than eight request attempts were observed (including retries).");
  if (!models.size) warn("No observed model identity was found.");
  if (models.size > 1) warn("Multiple observed models were found.");
  if (
    Object.values(metrics).some(
      (value) => typeof value === "number" && !Number.isSafeInteger(value),
    )
  )
    warn("Aggregated token counts exceed safe integer precision.");
  return { metrics, requests, warnings: [...warnings], models: [...models].sort() };
}

/** In this beta Bus.persist defaults to false. Each V2 assistant projection holds
 * one logical step's terminal usage, not a cumulative V1 assistant total.
 * Reused message IDs on retries can hide earlier attempts; session counters below
 * must reconcile before the sample is complete. No fabricated event IDs are exported.
 */
export function parseOpencode2Messages(
  rows: unknown[],
  sessionID: string,
  outcome: unknown,
): AgentUsage {
  const projected: unknown[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let previous = -1;
  let users = 0;
  for (const raw of rows) {
    const row = rowSchema.parse(raw);
    if (seen.has(row.id) || row.seq <= previous) {
      warnings.push("Duplicate or out-of-order native message projection.");
      continue;
    }
    seen.add(row.id);
    previous = row.seq;
    const data = object.parse(typeof row.data === "string" ? JSON.parse(row.data) : row.data);
    if (row.type === "user") users++;
    if (row.type !== "assistant") {
      if (!["user", "agent-switched", "model-switched"].includes(row.type))
        warnings.push(`Unexpected native message type: ${row.type}; accounting is incomplete.`);
      continue;
    }
    const time = object.safeParse(data.time);
    const add = (type: string, extra: Record<string, unknown>) =>
      projected.push({
        id: `${row.id}/${type}`,
        seq: projected.length,
        type: `session.step.${type}.1`,
        data: { sessionID, assistantMessageID: row.id, ...extra },
      });
    add("started", { agent: data.agent, model: data.model });
    if (time.success && typeof time.data.completed === "number" && typeof data.finish === "string")
      add(data.error || data.finish === "error" ? "failed" : "ended", { tokens: data.tokens });
    if (data.retry) warnings.push("Native message retains retry state; accounting is incomplete.");
  }
  if (users !== 1) warnings.push("Expected exactly one user prompt in a fresh benchmark session.");
  if (outcome === "succeeded")
    projected.push({
      id: `${sessionID}/terminal`,
      seq: projected.length,
      type: "session.execution.succeeded.1",
      data: { sessionID },
    });
  const usage = parseOpencode2Usage(projected, sessionID);
  usage.requests = usage.requests.map((raw) => {
    const { startEventID: _start, finishEventID: _finish, ...request } = object.parse(raw);
    return { ...request, source: "session_message", evidence: "v2 step projection" };
  });
  usage.warnings = usage.warnings.map((warning) =>
    warning.replace("persisted session steps", "native V2 step projections"),
  );
  usage.warnings.push(
    "V2 event history is not persisted by default. Step projections are reconciled with session counters; overwritten retries cannot be reconstructed.",
    ...warnings,
  );
  if (warnings.length) usage.metrics.complete = false;
  return usage;
}

/** Own the MCP server for one attempt. The beta's first snapshot can race its
 * debounced MCP tool registration even after the connection reports connected.
 */
async function startMcpServer(
  binary: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  expectedServers = ["github"],
) {
  const password = randomBytes(32).toString("base64url");
  env.OPENCODE_PASSWORD = password;
  const child = spawn(binary, ["serve", "--stdio", "--port", "0"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const cleanup = async () => {
    child.stdin.end();
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  };
  const lines = createInterface({ input: child.stdout });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await new Promise<string>((resolve, reject) => {
      lines.once("line", resolve);
      child.once("error", () => reject(new Error("Cannot start private OpenCode 2 MCP server.")));
      child.once("exit", () => reject(new Error("Private OpenCode 2 server exited during setup.")));
      timer = setTimeout(() => reject(new Error("OpenCode 2 server startup timed out.")), 30000);
    });
    clearTimeout(timer);
    const { url } = z.object({ url: z.string().url() }).parse(JSON.parse(ready));
    if (new URL(url).hostname !== "127.0.0.1" && new URL(url).hostname !== "localhost")
      throw new Error("OpenCode 2 did not start a local server.");
    const headers = {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "x-opencode-directory": encodeURIComponent(cwd),
    };
    const request = async (path: string, method = "GET") => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error("OpenCode 2 MCP startup check failed.");
      return response;
    };
    await request("/api/plugin/await-activation", "POST");
    const statusSchema = z.object({
      data: z.array(z.object({ name: z.string(), status: z.object({ status: z.string() }) })),
    });
    const deadline = Date.now() + 30000;
    for (;;) {
      const status = statusSchema.parse(await (await request("/api/mcp")).json()).data;
      if (
        status.length !== expectedServers.length ||
        status.some((server) => !expectedServers.includes(server.name))
      )
        throw new Error("Unexpected OpenCode 2 MCP server inventory.");
      if (status.every((server) => server.status.status === "connected")) break;
      const problem = mcpStartupError(status, Date.now() > deadline);
      if (problem) throw new Error(problem);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Upstream McpTool uses a 100ms debounce. The context guard below verifies the
    // actual snapshot; this settling interval alone is not exposure evidence.
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { url, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareOpencode2(
  directory: string,
  config: Config,
  trial: Trial,
  catalog: Catalog | undefined,
  token: string,
  databasePath: string,
  binary: string,
  benchmark: Benchmark = "github",
  credentials?: SuiteCredentials,
  executor?: ExecutorConnection,
): Promise<PreparedAgent> {
  techniqueSchema.parse(trial.technique);
  if (config.model !== "openai/gpt-5.6-terra" || config.maxSteps !== 16)
    throw new Error("OpenCode 2 requires openai/gpt-5.6-terra and maxSteps=16.");
  const bash = trial.technique === "bash";
  if (
    !bash &&
    (!catalog?.names.length ||
      catalog.names.some((name) => !/^[a-zA-Z0-9-]+_[a-zA-Z0-9_-]+$/.test(name)))
  )
    throw new Error("OpenCode 2 MCP preparation requires a nonempty canonical GitHub catalog.");
  await opencode2Auth(databasePath);
  const dataPath = await realpath(databasePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runtime = await realpath(await mkdtemp(join(resolve(directory), "opencode2-")));
  for (const child of ["home", "config", "data", "cache", "state", "tmp", "work", "gh"])
    await mkdir(join(runtime, child), { mode: 0o700 });
  const cwd = join(runtime, "work");
  const configPath = join(runtime, "bench.json");
  const env: NodeJS.ProcessEnv = {
    ...isolatedEnvironment(runtime, dataPath),
    ...(benchmark === "suite"
      ? { PATH: `${suiteBinDirectory}:${isolatedEnvironment(runtime, dataPath).PATH}` }
      : {}),
    ...(bash ? { GH_TOKEN: token } : { BENCH_GITHUB_TOKEN: token }),
    ...(executor
      ? { BENCH_EXECUTOR_TOKEN: executor.headers.Authorization?.replace(/^Bearer /, "") }
      : {}),
    ...(credentials && trial.technique !== "executor"
      ? {
          BENCH_SUPABASE_TOKEN: credentials.supabase,
          BENCH_CLOUDFLARE_TOKEN: credentials.cloudflare,
          BENCH_STRIPE_TOKEN: credentials.stripe,
          ...(bash
            ? {
                SUPABASE_ACCESS_TOKEN: credentials.supabase,
                CLOUDFLARE_API_TOKEN: credentials.cloudflare,
                CLOUDFLARE_ACCOUNT_ID: config.suite?.cloudflare.accountId,
                STRIPE_API_KEY: credentials.stripe,
              }
            : {}),
        }
      : {}),
  };
  await checkVersion(binary, env, cwd);
  const permissions = [
    { action: "*", resource: "*", effect: "deny" },
    ...(bash
      ? [
          "gh api *",
          "gh repo view *",
          "gh --help",
          "gh help *",
          "jq *",
          "wc *",
          "echo *",
          ...(benchmark === "suite"
            ? [
                "supabase functions list *",
                "wrangler d1 list *",
                "wrangler d1 info *",
                "stripe webhook_endpoints list *",
                "stripe webhook_endpoints retrieve *",
              ]
            : []),
        ].map((resource) => ({ action: "shell", resource, effect: "allow" }))
      : (catalog?.names ?? []).map((action) => ({ action, resource: "*", effect: "allow" }))),
    {
      action: "execute",
      resource: "*",
      effect: trial.technique === "tool-search" ? "allow" : "deny",
    },
  ];
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: `${config.model}#${config.variant}`,
        default_agent: "bench",
        shell: "/bin/bash",
        update: "disable",
        share: "disabled",
        snapshots: false,
        warming: false,
        lsp: false,
        formatter: false,
        instructions: [],
        skills: [],
        compaction: { auto: false },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
        agents: {
          build: { disabled: true },
          plan: { disabled: true },
          general: { disabled: true },
          explore: { disabled: true },
          title: { disabled: true },
          summary: { disabled: true },
          bench: { mode: "primary", steps: 8, permissions },
        },
        plugins: [
          "-opencode.tool.*",
          ...(bash ? ["opencode.tool.shell"] : []),
          "-opencode.tools",
          "-opencode.skill",
          "-opencode.config.skill",
          "-opencode.config.instruction",
          "-opencode.config.reference",
          "-opencode.command",
          "-opencode.config.command",
          "-opencode.warming",
          "-opencode.provider.*",
          "opencode.provider.openai",
        ],
        experimental: {
          subagent_depth: 0,
          policies: [
            { action: "provider.use", resource: "*", effect: "deny" },
            { action: "provider.use", resource: "openai", effect: "allow" },
          ],
        },
        mcp: {
          servers: bash
            ? {}
            : executor
              ? {
                  executor: {
                    type: "remote",
                    url: executor.url,
                    disabled: false,
                    oauth: false,
                    codemode: false,
                    headers: { Authorization: "Bearer {env:BENCH_EXECUTOR_TOKEN}" },
                    timeout: { startup: 30000, catalog: 30000, execution: 30000 },
                  },
                }
              : benchmark === "suite" && credentials
                ? Object.fromEntries(
                    Object.entries(
                      suiteServers(config, trial.technique, {
                        github: "{env:BENCH_GITHUB_TOKEN}",
                        supabase: "{env:BENCH_SUPABASE_TOKEN}",
                        cloudflare: "{env:BENCH_CLOUDFLARE_TOKEN}",
                        stripe: "{env:BENCH_STRIPE_TOKEN}",
                      }),
                    ).map(([name, server]) => [
                      name,
                      {
                        type: "remote",
                        url: server.url,
                        disabled: false,
                        oauth: false,
                        codemode: trial.technique === "tool-search",
                        headers: server.headers,
                        timeout: { startup: 30000, catalog: 30000, execution: 30000 },
                      },
                    ]),
                  )
                : {
                    github: {
                      type: "remote",
                      url: MCP_URL,
                      disabled: false,
                      oauth: false,
                      codemode: false,
                      headers: mcpHeaders(trial.technique, "{env:BENCH_GITHUB_TOKEN}"),
                      timeout: { startup: 30000, catalog: 30000, execution: 30000 },
                    },
                  },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: "wx" },
  );
  const pluginDirectory = join(runtime, "config", "plugins");
  await mkdir(pluginDirectory, { mode: 0o700 });
  const expectedTools = bash
    ? ["shell"]
    : trial.technique === "tool-search"
      ? ["execute"]
      : [...(catalog?.names ?? [])].sort();
  await writeFile(
    join(pluginDirectory, "bench-exposure.js"),
    `import { writeFile } from "node:fs/promises";
export default {
  id: "bench.exposure",
  async setup(ctx) {
    await ctx.session.hook("context", async event => {
      const tools = Object.keys(event.tools).sort();
      const valid = event.agent === "bench" && JSON.stringify(tools) === ${JSON.stringify(JSON.stringify(expectedTools))};
      await writeFile(${JSON.stringify(join(runtime, "exposure.json"))}, JSON.stringify({ sessionID: event.sessionID, tools, valid }), { mode: 0o600 });
      if (!valid) throw new Error("Benchmark tool inventory mismatch; stopped before model request.");
    });
  }
};
`,
    { mode: 0o600 },
  );
  const server = bash
    ? undefined
    : await startMcpServer(
        binary,
        env,
        cwd,
        executor
          ? ["executor"]
          : benchmark === "suite"
            ? ["github", "supabase", "cloudflare", "stripe"]
            : ["github"],
      );
  const events = new EventCollector(trial, token, credentials ? Object.values(credentials) : []);
  return {
    directory,
    cwd,
    env,
    configPath,
    dataPath,
    dataKind: "sqlite",
    events,
    settings: [
      `OpenCode 2 ${opencode2Version}; source=${opencode2Source}; model=${config.model}#${config.variant}`,
      "Private HOME/XDG/config/work directory and attempt-owned server; project config disabled; no personal auth import.",
      "Benchmark context hook checks exact direct tool names before each model request. MCP startup settles before the measured client run.",
      `Native SQLite OPENCODE_DB=${dataPath} holds sessions and OAuth; native refresh writes are permitted there only. Do not export or copy this DB. collect().artifactPath is the safe JSONL artifact.`,
      trial.technique === "tool-search"
        ? "Integrated MCP search plus Code Mode: MCP codemode=true and execute is the only exposed service mechanism."
        : trial.technique === "executor"
          ? "Executor MCP exposes executor_execute, executor_resume, and executor_skills; native execute is denied and Executor performs the required code execution."
          : "Direct shell or MCP definitions only; MCP codemode=false; execute denied before tool snapshot; no Code Mode catalog.",
      `steps=${config.maxSteps} (final logical step is text-only; retries can add requests); explicit title prevents title generation.`,
      "No OS sandbox: shell permissions are not a filesystem security boundary.",
      "Native V2 assistant step projections supply usage and model identity, reconciled with session counters; unknown fields remain unknown.",
    ],
    args: [
      "run",
      ...(server ? ["--server", server.url] : ["--standalone"]),
      "--format",
      "json",
      "--agent",
      "bench",
      "--model",
      `${config.model}#${config.variant}`,
      "--title",
      "tool-context-bench",
    ],
    onLine(line) {
      if (!line.trim()) return;
      try {
        const event = object.parse(JSON.parse(line));
        const part = object.safeParse(event.part);
        if (event.type === "tool_use" && part.success) {
          const native = part.data.tool;
          if (native === "execute") {
            events.codeMode = true;
            if (trial.technique !== "tool-search") events.error = true;
          }
          if (native === "shell") {
            part.data.tool = "bash";
            const state = object.safeParse(part.data.state);
            const metadata = state.success ? object.safeParse(state.data.metadata) : undefined;
            const result = metadata?.success ? object.safeParse(metadata.data.metadata) : undefined;
            if (
              state.success &&
              state.data.status === "completed" &&
              (!result?.success ||
                result.data.exit !== 0 ||
                result.data.timeout === true ||
                result.data.status === "running")
            ) {
              state.data.status = "error";
              part.data.state = state.data;
            }
          }
          // Tool IDs are provider call IDs and can repeat across assistant messages.
          if (typeof part.data.messageID === "string" && typeof part.data.id === "string")
            part.data.id = `${part.data.messageID}:${part.data.id}`;
          event.part = part.data;
        }
        events.line(JSON.stringify(event));
      } catch {
        events.malformed = true;
      }
    },
    async collect() {
      try {
        const exposure = z
          .object({ sessionID: z.string(), tools: z.array(z.string()), valid: z.literal(true) })
          .parse(JSON.parse(await readFile(join(runtime, "exposure.json"), "utf8")));
        if (
          exposure.sessionID !== events.sessionID ||
          JSON.stringify(exposure.tools) !== JSON.stringify(expectedTools)
        )
          throw new Error();
      } catch {
        events.error = true;
        events.warnings.push(
          "Exact direct-tool inventory was not verified before the model request.",
        );
      }
      let usage: AgentUsage;
      try {
        if (!events.sessionID || events.malformed) throw new Error();
        using db = new DatabaseSync(dataPath, { readOnly: true });
        db.exec("PRAGMA query_only = ON; BEGIN");
        const session = db
          .prepare(`SELECT directory, parent_id, idle_outcome, fork_session_id, tokens_input, tokens_output, tokens_reasoning,
            tokens_cache_read, tokens_cache_write FROM session_v2 WHERE id = ?`)
          .get(events.sessionID);
        if (
          session?.directory !== cwd ||
          session.parent_id !== null ||
          session.fork_session_id !== null
        )
          throw new Error();
        const rows = db
          .prepare(
            "SELECT id, seq, type, data FROM session_message WHERE session_id = ? ORDER BY seq",
          )
          .all(events.sessionID);
        usage = parseOpencode2Messages(rows, events.sessionID, session.idle_outcome);
        const counters = [
          [session.tokens_input, usage.metrics.freshInput],
          [session.tokens_output, usage.metrics.totalOutput - usage.metrics.reasoning],
          [session.tokens_reasoning, usage.metrics.reasoning],
          [session.tokens_cache_read, usage.metrics.cacheRead],
          [session.tokens_cache_write, usage.metrics.cacheWrite],
        ];
        if (counters.some(([native, observed]) => native !== observed)) {
          usage.metrics.complete = false;
          usage.warnings.push(
            "Session token counters do not reconcile with the observed benchmark steps.",
          );
        }
        const children = db
          .prepare("SELECT count(*) AS count FROM session_v2 WHERE parent_id = ?")
          .get(events.sessionID);
        if (children?.count !== 0) {
          usage.metrics.complete = false;
          usage.warnings.push(
            "Unexpected child sessions found; their usage is excluded from main metrics.",
          );
        }
        db.exec("COMMIT");
      } catch {
        throw new Error(
          "Exact-session OpenCode 2 usage is unavailable or has invalid native records.",
        );
      }
      if (!usage.metrics.steps) throw new Error("No usable OpenCode 2 step usage was recorded.");
      if (
        events.error ||
        events.malformed ||
        usage.models.some((model) => model !== config.model)
      ) {
        usage.metrics.complete = false;
        usage.warnings.push("Run error, malformed stream, or unexpected observed model.");
      }
      const artifactPath = join(runtime, "usage.jsonl");
      await writeFile(artifactPath, `${JSON.stringify(usage)}\n`, { mode: 0o600 });
      return { ...usage, artifactPath };
    },
    async cleanup() {
      await server?.cleanup();
      // The persistent credential/session DB belongs to the benchmark, not this attempt.
      // Never unlink it or remove completed sessions (which are accounting evidence).
    },
  };
}
