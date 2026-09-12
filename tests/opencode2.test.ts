import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { configSchema, runtimePaths } from "../src/config.js";
import {
  mcpStartupError,
  opencode2Auth,
  parseOpencode2Usage,
  prepareOpencode2,
  setupOpencode2Auth,
} from "../src/opencode2.js";
import { execute } from "../src/process.js";
import type { Technique, Trial } from "../src/types.js";

it("allows MCP servers to connect at different times", () => {
  expect(
    mcpStartupError(
      [
        { name: "github", status: { status: "connected" } },
        { name: "supabase", status: { status: "pending" } },
      ],
      false,
    ),
  ).toBeNull();
  expect(mcpStartupError([{ name: "supabase", status: { status: "failed" } }], false)).toContain(
    "supabase=failed",
  );
});

const login = vi.hoisted(
  (): { code: number; signal: NodeJS.Signals | null; error: boolean; persist: boolean } => ({
    code: 0,
    signal: null,
    error: false,
    persist: false,
  }),
);
vi.mock("node:child_process", async (original) => {
  const native = await original<typeof import("node:child_process")>();
  return {
    ...native,
    spawn: vi.fn(
      (_binary: string, args: string[], options: import("node:child_process").SpawnOptions) => {
        const child = new native.ChildProcess();
        if (args[0] === "serve") {
          child.stdin = new PassThrough();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = () => {
            queueMicrotask(() => child.emit("close", 0, null));
            return true;
          };
          const stdout = child.stdout;
          child.stdin.on("finish", () => child.emit("close", 0, null));
          queueMicrotask(() =>
            stdout.emit("data", Buffer.from('{"url":"http://127.0.0.1:12345"}\n')),
          );
          return child;
        }
        queueMicrotask(() => {
          if (login.persist) {
            const path = options.env?.OPENCODE_DB;
            if (!path) throw new Error("Missing private database path");
            using db = new DatabaseSync(path);
            db.exec(
              `CREATE TABLE IF NOT EXISTS credential (id TEXT, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)`,
            );
            db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?)").run(
              "cred_login",
              "openai",
              JSON.stringify({
                type: "oauth",
                methodID: "chatgpt-headless",
                access: "synthetic-access",
                refresh: "synthetic-refresh",
                expires: 0,
              }),
              1,
              1,
            );
            chmodSync(path, 0o644);
          }
          if (login.error) child.emit("error", new Error("synthetic error"));
          child.emit("close", login.code, login.signal);
        });
        return child;
      },
    ),
  };
});

vi.mock("../src/process.js", async (original) => ({
  ...(await original<typeof import("../src/process.js")>()),
  execute: vi.fn(async () => ({
    code: 0,
    stopped: false,
    stdout: "opencode2 v0.0.0-beta-19425\n",
    stderr: "",
  })),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  login.code = 0;
  login.signal = null;
  login.error = false;
  login.persist = false;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const config = configSchema.parse({
  repository: "fixture/repo",
  branch: "main",
  opencodeVersion: "1.18.30",
  model: "openai/gpt-5.6-terra",
});
const sessionID = "ses_fixture";
const event = (seq: number, type: string, data: Record<string, unknown> = {}) => ({
  id: `evt_${seq}`,
  seq,
  type: `${type}.1`,
  data: JSON.stringify({ sessionID, ...data }),
});
const start = event(1, "session.step.started", {
  assistantMessageID: "msg_1",
  agent: "bench",
  model: { providerID: "openai", id: "gpt-5.6-terra" },
});
const finish = event(2, "session.step.ended", {
  assistantMessageID: "msg_1",
  finish: "stop",
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 10 } },
});
const success = event(3, "session.execution.succeeded");

it("accounts native persisted categories once and uses the observed model", () => {
  const usage = parseOpencode2Usage([start, finish, finish, success], sessionID);
  expect(usage.metrics).toEqual({
    initialInput: 150,
    totalInput: 150,
    totalOutput: 25,
    totalTokens: 175,
    cacheRead: 40,
    cacheWrite: 10,
    freshInput: 100,
    reasoning: 5,
    steps: 1,
    complete: true,
  });
  expect(usage.models).toEqual(["openai/gpt-5.6-terra"]);
  expect(usage.requests).toHaveLength(1);
});

it("keeps missing categories unknown, not measured zero", () => {
  const usage = parseOpencode2Usage(
    [
      start,
      event(2, "session.step.ended", {
        assistantMessageID: "msg_1",
        tokens: { input: 100, output: 20 },
      }),
      success,
    ],
    sessionID,
  );
  expect(usage.metrics.complete).toBe(false);
  expect(usage.metrics.initialInput).toBeNull();
  expect(usage.requests[0]).toMatchObject({
    raw: { reasoning: null, cache: { read: null, write: null } },
    total: null,
  });
});

it("does not substitute configured identity for missing native identity", () => {
  const usage = parseOpencode2Usage(
    [
      event(1, "session.step.started", {
        assistantMessageID: "msg_1",
        agent: "bench",
      }),
      finish,
      success,
    ],
    sessionID,
  );
  expect(usage.models).toEqual([]);
  expect(usage.metrics.complete).toBe(false);
});

it.each([
  [start],
  [finish, success],
  [start, finish],
  [start, finish, event(3, "session.compaction.started"), event(4, "session.execution.succeeded")],
  [start, { ...finish, data: JSON.stringify({ sessionID: "ses_other" }) }, success],
  [start, finish, { ...finish, seq: 4 }, success],
])("marks partial or inconsistent accounting incomplete", (...rows) => {
  expect(parseOpencode2Usage(rows, sessionID).metrics.complete).toBe(false);
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "opencode2-test-"));
  directories.push(directory);
  const database = join(directory, "bench.db");
  await writeFile(database, "", { mode: 0o600 });
  using db = new DatabaseSync(database);
  db.exec(`CREATE TABLE credential (id TEXT, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER);
    CREATE TABLE session_v2 (id TEXT, directory TEXT, parent_id TEXT, idle_outcome TEXT, fork_session_id TEXT,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER);
    CREATE TABLE event (id TEXT, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT);
    CREATE TABLE session_message (id TEXT, session_id TEXT, seq INTEGER, type TEXT, data TEXT);`);
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?)").run(
    "cred_test",
    "openai",
    JSON.stringify({
      type: "oauth",
      methodID: "chatgpt-headless",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: 0,
    }),
    1,
    1,
  );
  return { directory, database };
}

it("checks auth without changing the credential DB and rejects API keys", async () => {
  const { database } = await fixture();
  const before = await readFile(database);
  await opencode2Auth(database);
  expect(await readFile(database)).toEqual(before);
  using db = new DatabaseSync(database);
  db.prepare("UPDATE credential SET value = ?").run(
    JSON.stringify({ type: "key", key: "synthetic-key" }),
  );
  await expect(opencode2Auth(database)).rejects.toThrow("tcb auth-opencode2");
});

it.each<Technique>(["bash", "mcp-raw", "mcp-filter", "mcp-filter-readonly"])(
  "prepares an isolated %s attempt without model calls",
  async (technique) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ name: "github", status: { status: "connected" } }] }),
            { status: 200 },
          ),
      ),
    );
    const { directory, database } = await fixture();
    const trial: Trial = {
      id: "fixture",
      agent: "opencode2",
      technique,
      workload: "task",
      repetition: 1,
    };
    const prepared = await prepareOpencode2(
      join(directory, "attempt"),
      config,
      trial,
      {
        hash: "fixture",
        names: ["github_get_commit"],
        readOnlyNames: ["github_get_commit"],
        tools: [],
        instructions: "",
        server: null,
      },
      "synthetic-github-token",
      database,
      "/fixture/bin/opencode2",
    );
    const text = await readFile(prepared.configPath, "utf8");
    expect(text).not.toContain("synthetic-github-token");
    expect(text).toContain('"steps": 8');
    expect(prepared.env.HOME).not.toBe(process.env.HOME);
    expect(prepared.env.OPENCODE_DB).toBe(await realpath(database));
    expect(prepared.env.OPENCODE_CONFIG_PROJECT_DISABLE).toBe("true");
    expect(execute).toHaveBeenCalledWith(
      "/fixture/bin/opencode2",
      ["--version"],
      expect.any(Object),
    );
    expect(prepared.dataKind).toBe("sqlite");
    expect(prepared.args).toContain(technique === "bash" ? "--standalone" : "--server");
    expect(prepared.args).not.toContain("--auto");
    if (technique !== "bash") {
      expect(text).toContain('"codemode": false');
      expect(text.includes("X-MCP-Readonly")).toBe(technique === "mcp-filter-readonly");
      expect(text.includes("X-MCP-Toolsets")).toBe(technique !== "mcp-raw");
    }
    prepared.onLine(
      JSON.stringify({
        type: "tool_use",
        sessionID,
        part: {
          id: "call_1",
          messageID: "msg_1",
          tool: technique === "bash" ? "shell" : "github_get_commit",
          state: {
            status: "completed",
            input: { command: "gh api repos/fixture/repo/commits/main" },
            metadata: { metadata: { exit: 0 } },
          },
        },
      }),
    );
    expect(prepared.events.routeValid).toBe(true);
    using db = new DatabaseSync(database);
    db.prepare(
      "INSERT INTO session_v2 VALUES (?, ?, NULL, 'succeeded', NULL, 100, 20, 5, 40, 10)",
    ).run(sessionID, prepared.cwd);
    // The real beta leaves event empty; collect from its persisted step projections.
    db.prepare("INSERT INTO session_message VALUES ('user_1', ?, 1, 'user', '{}')").run(sessionID);
    db.prepare("INSERT INTO session_message VALUES ('msg_1', ?, 2, 'assistant', ?)").run(
      sessionID,
      JSON.stringify({
        agent: "bench",
        model: { providerID: "openai", id: "gpt-5.6-terra" },
        time: { created: 1, completed: 2 },
        finish: "stop",
        tokens: JSON.parse(finish.data).tokens,
      }),
    );
    await writeFile(
      join(prepared.cwd, "..", "exposure.json"),
      JSON.stringify({
        sessionID,
        tools: technique === "bash" ? ["shell"] : ["github_get_commit"],
        valid: true,
      }),
    );
    const usage = await prepared.collect();
    expect(usage.metrics.complete).toBe(true);
    expect(usage.artifactPath).not.toBe(database);
    expect(usage.artifactPath).toMatch(/usage\.jsonl$/);
    if (!usage.artifactPath) throw new Error("Missing usage artifact");
    const artifact = await readFile(usage.artifactPath, "utf8");
    expect(artifact.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(artifact)).toMatchObject({ metrics: usage.metrics });
    expect(artifact).not.toContain("synthetic-refresh");
    if (technique === "bash") {
      prepared.onLine(
        JSON.stringify({
          type: "tool_use",
          sessionID,
          part: {
            id: "call_wrong_workdir_failed",
            messageID: "msg_2",
            tool: "shell",
            state: {
              status: "error",
              input: {
                command: "gh api repos/fixture/repo/commits/main",
                workdir: "/missing/work",
              },
            },
          },
        }),
      );
      expect(prepared.events.routeValid).toBe(true);
      expect(prepared.events.warnings).toContain(
        "A shell call requested an unexpected work directory but did not start; corrected retries remain eligible.",
      );
      prepared.onLine(
        JSON.stringify({
          type: "tool_use",
          sessionID,
          part: {
            id: "call_wrong_workdir_completed",
            messageID: "msg_3",
            tool: "shell",
            state: {
              status: "completed",
              input: {
                command: "gh api repos/fixture/repo/commits/main",
                workdir: "/other/work",
              },
              metadata: { metadata: { exit: 0 } },
            },
          },
        }),
      );
      expect(prepared.events.routeValid).toBe(false);
    }
    prepared.onLine(
      JSON.stringify({
        type: "tool_use",
        sessionID,
        part: {
          id: "call_2",
          tool: "execute",
          state: { status: "completed", input: {} },
        },
      }),
    );
    expect(prepared.events.codeMode).toBe(true);
    expect(prepared.events.routeValid).toBe(false);
    await prepared.cleanup();
    await expect(opencode2Auth(database)).resolves.toBeUndefined();
  },
);

it("runs explicit standalone headless login in a persistent private profile", async () => {
  const { directory } = await fixture();
  const paths = runtimePaths(directory);
  login.persist = true;
  vi.stubEnv("OPENAI_API_KEY", "personal-key");
  vi.stubEnv("OPENCODE_SERVER", "http://personal-server");
  vi.stubEnv("OPENCODE_CONFIG_CONTENT", "personal-config");
  await setupOpencode2Auth(paths, "/fixture/bin/opencode2");
  const profile = join(await realpath(directory), "opencode2");
  const dbPath = join(profile, "opencode.db");
  expect(spawn).toHaveBeenCalledWith(
    "/fixture/bin/opencode2",
    ["auth", "login", "openai", "--standalone", "--method", "chatgpt-headless"],
    expect.objectContaining({
      stdio: "inherit",
      cwd: join(profile, "work"),
      env: expect.objectContaining({
        HOME: join(profile, "home"),
        XDG_CONFIG_HOME: join(profile, "config"),
        XDG_DATA_HOME: join(profile, "data"),
        XDG_STATE_HOME: join(profile, "state"),
        XDG_CACHE_HOME: join(profile, "cache"),
        OPENCODE_DB: dbPath,
        OPENCODE_CONFIG: join(profile, "bench.json"),
        OPENCODE_CONFIG_PROJECT_DISABLE: "true",
      }),
    }),
  );
  const options = vi.mocked(spawn).mock.calls[0]?.[2];
  expect(options?.env).not.toHaveProperty("OPENAI_API_KEY");
  expect(options?.env).not.toHaveProperty("OPENCODE_SERVER");
  expect(options?.env).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
  expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
  expect((await stat(profile)).mode & 0o777).toBe(0o700);
  expect(await readFile(join(profile, "bench.json"), "utf8")).toContain(
    '"opencode.provider.openai"',
  );
  await opencode2Auth(dbPath);
  // Repeating setup must keep the profile and saved credentials, not truncate the DB.
  login.persist = false;
  await setupOpencode2Auth(paths, "/fixture/bin/opencode2");
  await opencode2Auth(dbPath);
});

it.each(["failure", "signal", "spawn-error", "missing-auth", "wrong-version"])(
  "rejects login %s without using personal auth",
  async (failure) => {
    const { directory } = await fixture();
    if (failure === "failure") {
      login.code = 1;
      login.persist = true;
    }
    if (failure === "signal") login.signal = "SIGINT";
    if (failure === "spawn-error") login.error = true;
    if (failure === "wrong-version")
      vi.mocked(execute).mockResolvedValueOnce({
        code: 0,
        stopped: false,
        stdout: "opencode2 vother\n",
        stderr: "",
      });
    await expect(
      setupOpencode2Auth(runtimePaths(directory), "/fixture/bin/opencode2"),
    ).rejects.toThrow();
    if (failure === "wrong-version") expect(spawn).not.toHaveBeenCalled();
    if (failure === "failure")
      expect((await stat(join(directory, "opencode2", "opencode.db"))).mode & 0o777).toBe(0o600);
  },
);

it.each(["profile", "database"])("rejects a linked login %s before spawn", async (target) => {
  const { directory, database } = await fixture();
  const profile = join(directory, "opencode2");
  if (target === "profile") await symlink(directory, profile);
  else {
    await mkdir(profile, { mode: 0o700 });
    await symlink(database, join(profile, "opencode.db"));
  }
  await expect(
    setupOpencode2Auth(runtimePaths(directory), "/fixture/bin/opencode2"),
  ).rejects.toThrow();
  expect(spawn).not.toHaveBeenCalled();
});
