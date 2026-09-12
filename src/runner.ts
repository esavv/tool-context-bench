import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config, Paths } from "./config.js";
import {
  expectedSchema,
  suiteExpectedSchema,
  type Batch,
  type Benchmark,
  type Result,
  type Technique,
  type Trial,
} from "./types.js";
import { acquireLock, ensureRoot, saveJson } from "./storage.js";
import { githubToken, inspectSubscription, redact } from "./credentials.js";
import { prepareAttempt, agentConfig } from "./opencode.js";
import { defaultAgents, agentProfile, agentLabel, binaries, type Agent } from "./agents.js";
import { opencode2Auth, prepareOpencode2 } from "./opencode2.js";
import { claudeAuth, prepareClaude } from "./claude.js";
import { codexAuth, prepareCodex } from "./codex.js";
import type { AgentUsage, PreparedAgent } from "./adapter.js";
import { readCatalog, readExpected, gradeAnswer, type Catalog } from "./github.js";
import { techniqueSchema, techniqueSettings } from "./techniques.js";
import { sessionDetails } from "./session.js";
import { schedule, prompt } from "./schedule.js";
import { execute } from "./process.js";
import { EventCollector } from "./events.js";
import { collectUsage } from "./usage.js";
import { piAuth, preparePi } from "./pi.js";
import {
  readSuiteCatalog,
  readSuiteExpected,
  gradeSuiteAnswer,
  suiteCliVersions,
  suiteCredentials,
  type SuiteCredentials,
} from "./suite.js";

async function verifyConfig(
  binary: string,
  prepared: Awaited<ReturnType<typeof prepareAttempt>>,
  expected: unknown,
): Promise<void> {
  const response = await execute(binary, ["debug", "config"], {
    env: prepared.env,
    cwd: prepared.cwd,
    timeoutMs: 30_000,
  });
  try {
    const raw: unknown = JSON.parse(response.stdout);
    const actual = z.record(z.string(), z.unknown()).parse(raw);
    for (const key of [
      "model",
      "default_agent",
      "mcp",
      "permission",
      "compaction",
      "subagent_depth",
      "instructions",
    ]) {
      const desired = z.record(z.string(), z.unknown()).parse(expected)[key];
      if (JSON.stringify(actual[key]) !== JSON.stringify(desired)) throw new Error();
    }
    if (response.code !== 0 || (Array.isArray(actual.plugin) && actual.plugin.length > 0))
      throw new Error();
    const agent = z.object({ bench: z.object({ permission: z.unknown() }) }).parse(actual.agent);
    const desiredAgent = z
      .object({ bench: z.object({ permission: z.unknown() }) })
      .parse(z.record(z.string(), z.unknown()).parse(expected).agent);
    if (JSON.stringify(agent.bench.permission) !== JSON.stringify(desiredAgent.bench.permission))
      throw new Error();
    const providers = z.record(z.string(), z.unknown()).optional().parse(actual.provider);
    if (providers && Object.keys(providers).length > 0) throw new Error();
  } catch {
    throw new Error(
      "Effective OpenCode configuration did not match the benchmark. No resolved configuration or credentials were exported.",
    );
  }
}

async function checkAuth(agent: Agent, binary: string, paths: Paths): Promise<void> {
  if (agent === "claude") await claudeAuth(binary);
  else if (agent === "codex") await codexAuth();
  else if (agent === "opencode2") await opencode2Auth(paths.opencode2Database);
  else if (agent === "pi")
    throw new Error("pi authentication requires the loaded benchmark configuration.");
  else await inspectSubscription(paths.auth);
}

async function prepare(
  config: Config,
  paths: Paths,
  directory: string,
  trial: Trial,
  catalog: Catalog | undefined,
  token: string,
  binary: string,
  benchmark: Benchmark = "github",
  credentials?: SuiteCredentials,
): Promise<PreparedAgent> {
  if (trial.agent === "pi") {
    if (!credentials) throw new Error("Suite credentials are required for pi.");
    return preparePi(directory, config, trial, credentials);
  }
  if (trial.agent === "claude")
    return prepareClaude(directory, config, trial, catalog, token, benchmark, credentials);
  if (trial.agent === "codex")
    return prepareCodex(directory, config, trial, catalog, token, benchmark, credentials);
  if (trial.agent === "opencode2")
    return prepareOpencode2(
      directory,
      config,
      trial,
      catalog,
      token,
      paths.opencode2Database,
      binary,
      benchmark,
      credentials,
    );
  if (benchmark === "suite") throw new Error("OpenCode 1 is not supported by the suite benchmark.");
  const prepared = await prepareAttempt(directory, paths.auth, config, trial, catalog?.names ?? []);
  if (trial.technique === "bash") prepared.env.GH_TOKEN = token;
  else prepared.env.BENCH_GITHUB_TOKEN = token;
  const expectedConfig = agentConfig(config, trial, catalog?.names ?? []);
  const expected: unknown = JSON.parse(
    JSON.stringify(expectedConfig).replaceAll("{env:BENCH_GITHUB_TOKEN}", token),
  );
  const cleanup = () =>
    unlink(join(directory, "data", "opencode", "auth.json")).catch(() => undefined);
  try {
    await verifyConfig(binary, prepared, expected);
  } catch (error) {
    await cleanup();
    throw error;
  }
  const events = new EventCollector(trial, token);
  return {
    ...prepared,
    configPath: join(directory, "bench.json"),
    dataPath: prepared.database,
    dataKind: "sqlite",
    args: [
      "run",
      "--pure",
      "--format",
      "json",
      "--agent",
      "bench",
      "--model",
      config.model,
      "--variant",
      config.variant,
      "--title",
      "tool-context-bench",
    ],
    settings: [
      `OpenCode ${config.opencodeVersion}; tool search unavailable/disabled; Code Mode disabled.`,
      ...sessionDetails(directory, expectedConfig, config.variant).settings,
    ],
    events,
    onLine: (line) => events.line(line),
    collect: async () => {
      if (!events.sessionID) throw new Error("OpenCode did not report a session ID.");
      return {
        ...collectUsage(prepared.database, events.sessionID),
        artifactPath: prepared.database,
      };
    },
    cleanup,
  };
}

export async function doctor(
  config: Config,
  paths: Paths,
  checkAccess = false,
  agents: Agent[] = defaultAgents,
  benchmark: Benchmark = "github",
): Promise<string[]> {
  if (
    (benchmark === "suite" && agents.includes("opencode")) ||
    (benchmark === "github" && agents.includes("pi"))
  )
    throw new Error("The selected agent is not supported by this benchmark.");
  const installed = await binaries(config, agents);
  if (benchmark === "suite") Object.assign(installed.versions, await suiteCliVersions(config));
  const lines = [
    installed.versions.gh,
    `Repository: ${config.repository}, branch: ${config.branch}`,
    `Runtime: ${paths.root}`,
  ];
  for (const agent of agents) {
    const binary = installed.executables[agent];
    if (!binary) throw new Error(`Missing ${agent} executable.`);
    if (agent === "pi") await piAuth(binary, config);
    else await checkAuth(agent, binary, paths);
    lines.push(
      `${agentLabel(agent)} ${installed.versions[agent]}: pin matched; subscription auth available (values hidden)`,
    );
  }
  if (!checkAccess)
    return [
      ...lines,
      "Service Keychain items, remote APIs, MCP, and model entitlement were not contacted. Use --check-access for read-only preflight.",
    ];
  await ensureRoot(paths);
  const release = await acquireLock(paths);
  try {
    const credentials = benchmark === "suite" ? await suiteCredentials(config, paths) : undefined;
    const token = credentials?.github ?? (await githubToken(config, paths));
    await mkdir(join(paths.root, "probe"), { recursive: true, mode: 0o700 });
    const expected = credentials
      ? await readSuiteExpected(config, credentials, installed.gh, join(paths.root, "probe"))
      : await readExpected(config, token, installed.gh, join(paths.root, "probe"));
    const techniques =
      benchmark === "suite"
        ? ["mcp-raw", "mcp-tuned", "tool-search"]
        : ["mcp-raw", "mcp-filter", "mcp-filter-readonly"];
    for (const technique of z.array(techniqueSchema).parse(techniques)) {
      const catalog = credentials
        ? await readSuiteCatalog(config, technique, credentials)
        : await readCatalog(technique, token);
      lines.push(`${technique}: ${catalog.names.length} tools; SHA-256 ${catalog.hash}`);
    }
    for (const agent of agents) {
      const binary = installed.executables[agent];
      if (!binary) throw new Error(`Missing ${agent} executable.`);
      const trial: Trial = {
        id: "doctor",
        agent,
        technique: "bash",
        workload: "noop",
        repetition: 1,
      };
      const prepared = await prepare(
        config,
        paths,
        join(paths.attempts, `doctor-${agent}-${randomUUID()}`),
        trial,
        undefined,
        token,
        binary,
        benchmark,
        credentials,
      );
      try {
        if (agent === "opencode") {
          const models = await execute(binary, ["models", "openai"], {
            env: prepared.env,
            cwd: prepared.cwd,
          });
          if (models.code !== 0 || !models.stdout.split(/\s+/).includes(config.model))
            throw new Error("Terra is not in the OpenCode model catalog.");
        } else if (agent === "codex") {
          const valid = await execute(binary, ["features", "list"], {
            env: prepared.env,
            cwd: prepared.cwd,
          });
          if (valid.code !== 0) {
            const diagnostic = join(prepared.directory, "preflight-stderr.txt");
            await writeFile(diagnostic, redact(valid.stderr, [token]), { mode: 0o600 });
            throw new Error(
              `Codex rejected its generated configuration. No model call was made. Diagnostic: ${diagnostic}`,
            );
          }
        }
        lines.push(
          `${agentLabel(agent)}: benchmark configuration prepared; model entitlement and actual tool exposure need a smoke test.`,
        );
      } finally {
        await prepared.cleanup();
      }
    }
    lines.push(
      `${benchmark === "suite" ? "Suite" : "GitHub"} Keychain item(s): readable (values hidden)`,
      `GitHub commit: ${"github" in expected ? expected.github.sha : expected.sha}`,
    );
    return lines;
  } finally {
    await release();
  }
}

export interface RunOptions {
  benchmark: Benchmark;
  agents: Agent[];
  repeats: number;
  techniques: Technique[];
  workloads: Trial["workload"][];
  seed: number;
  signal: AbortSignal;
  progress: (message: string) => void;
}

export function shouldStopBatch(status: Result["status"]): boolean {
  return ["fixture-drift", "cancelled", "timeout", "failed"].includes(status);
}

export async function run(config: Config, paths: Paths, options: RunOptions): Promise<Batch> {
  await ensureRoot(paths);
  const release = await acquireLock(paths);
  try {
    const installed = await binaries(config, options.agents);
    if (options.benchmark === "suite")
      Object.assign(installed.versions, await suiteCliVersions(config));
    if (
      (options.benchmark === "suite" && options.agents.includes("opencode")) ||
      (options.benchmark === "github" && options.agents.includes("pi"))
    )
      throw new Error("The selected agent is not supported by this benchmark.");
    for (const agent of options.agents) {
      const binary = installed.executables[agent];
      if (!binary) throw new Error(`Missing ${agent} executable.`);
      if (agent === "pi") await piAuth(binary, config);
      else await checkAuth(agent, binary, paths);
    }
    const credentials =
      options.benchmark === "suite" ? await suiteCredentials(config, paths) : undefined;
    const token = credentials?.github ?? (await githubToken(config, paths));
    await mkdir(join(paths.root, "probe"), { recursive: true, mode: 0o700 });
    const oracleHome = join(paths.root, "probe");
    const expected = credentials
      ? await readSuiteExpected(config, credentials, installed.gh, oracleHome)
      : await readExpected(config, token, installed.gh, oracleHome);
    const catalogs: Partial<Record<Technique, Catalog>> = {};
    for (const technique of options.techniques) {
      if (technique !== "bash")
        catalogs[technique] = credentials
          ? await readSuiteCatalog(config, technique, credentials)
          : await readCatalog(technique, token);
    }
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
    const directory = join(paths.results, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const planned = schedule(
      options.repeats,
      options.techniques,
      options.seed,
      options.agents,
      options.benchmark,
    ).filter((trial) => options.workloads.includes(trial.workload));
    const batch: Batch = {
      manifest: {
        schemaVersion: 5,
        id,
        createdAt: new Date().toISOString(),
        benchmark: options.benchmark,
        config: { ...config, repeats: options.repeats },
        seed: options.seed,
        schedule: planned,
        expected,
        versions: installed.versions,
        catalogs: Object.fromEntries(
          Object.entries(catalogs).map(([technique, catalog]) => [
            technique,
            { hash: catalog.hash, toolCount: catalog.names.length },
          ]),
        ),
        exposure: "source-verified; not a live request capture",
      },
      results: [],
    };
    await saveJson(join(directory, "manifest.json"), batch.manifest);
    for (const [technique, catalog] of Object.entries(catalogs))
      await saveJson(join(directory, `${technique}.catalog.json`), catalog);
    options.progress(
      `Batch ${id}: ${planned.length} sessions. Existing subscription state is shared; avoid concurrent use of the same agent login.`,
    );

    for (const trial of planned) {
      const catalog = catalogs[trial.technique];
      const exposure = techniqueSettings(trial.technique);
      if (options.signal.aborted) break;
      const checked = await binaries(config, [trial.agent]);
      const binary = checked.executables[trial.agent];
      if (!binary) throw new Error(`Missing ${trial.agent} executable.`);
      const before = credentials
        ? await readSuiteExpected(config, credentials, installed.gh, oracleHome)
        : await readExpected(config, token, installed.gh, oracleHome);
      if (JSON.stringify(before) !== JSON.stringify(expected)) {
        options.progress("Stopped: benchmark fixtures changed before next attempt.");
        break;
      }
      if (catalog) {
        const current = credentials
          ? await readSuiteCatalog(config, trial.technique, credentials)
          : await readCatalog(trial.technique, token);
        if (current.hash !== catalog.hash) {
          options.progress("Stopped: MCP catalog changed.");
          break;
        }
      }
      const attemptDirectory = join(paths.attempts, `${id}_${trial.id}`);
      const prepared = await prepare(
        config,
        paths,
        attemptDirectory,
        trial,
        catalog,
        token,
        binary,
        options.benchmark,
        credentials,
      );
      const result: Result = {
        trial,
        status: "running",
        success: false,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        sessionID: null,
        metrics: null,
        warnings: [],
        answer: "",
        tools: [],
        codeMode: "unknown",
        grading: null,
        session: {
          configPath: prepared.configPath,
          databasePath: prepared.dataPath,
          workDirectory: prepared.cwd,
          settings: [
            options.benchmark === "suite"
              ? `Suite route: ${trial.technique}; MCP: ${exposure.mcpEnabled ? "enabled" : "disabled"}; catalog tools: ${catalog?.names.length ?? 0}`
              : `MCP: ${exposure.mcpEnabled ? "enabled" : "disabled"}; toolset filter: ${exposure.toolsets ?? "none"}; MCP read-only mode: ${exposure.readOnly ? "enabled" : "disabled"}; catalog tools: ${catalog?.names.length ?? 0}`,
            ...prepared.settings,
          ],
          dataKind: prepared.dataKind,
        },
      };
      batch.results.push(result);
      const resultFile = join(directory, `${trial.id}.result.json`);
      await saveJson(resultFile, result);
      await writeFile(
        join(attemptDirectory, "prompt.txt"),
        prompt(config, trial, options.benchmark),
        {
          mode: 0o600,
        },
      );
      options.progress(
        `[${batch.results.length}/${planned.length}] ${agentLabel(trial.agent)} ${trial.technique} ${trial.workload} ${trial.repetition}`,
      );
      const events = prepared.events;
      const started = performance.now();
      try {
        const trialPrompt = prompt(config, trial, options.benchmark);
        const processResult = await execute(
          binary,
          prepared.promptArgument ? [...prepared.args, trialPrompt] : prepared.args,
          {
            env: prepared.env,
            cwd: prepared.cwd,
            input: prepared.promptArgument ? undefined : trialPrompt,
            timeoutMs: config.timeoutSeconds * 1000,
            signal: options.signal,
            onLine: prepared.onLine,
          },
        );
        result.durationMs = Math.round(performance.now() - started);
        if (trial.agent === "claude" || trial.agent === "pi")
          await writeFile(
            prepared.dataPath,
            redact(processResult.stdout, credentials ? Object.values(credentials) : [token]),
            {
              mode: 0o600,
            },
          );
        await writeFile(
          join(attemptDirectory, "stderr.txt"),
          redact(processResult.stderr, credentials ? Object.values(credentials) : [token]),
          { mode: 0o600 },
        );
        result.sessionID = events.sessionID;
        result.answer = events.answer;
        result.tools = events.tools;
        result.codeMode = events.codeMode
          ? "used"
          : events.malformed || processResult.stopped || events.error || processResult.code !== 0
            ? "unknown"
            : "not-observed";
        result.warnings.push(...events.warnings);
        if (events.malformed) result.warnings.push("Incomplete or malformed CLI event stream.");
        let usage: AgentUsage | undefined;
        if (events.sessionID || prepared.collectWithoutSession) {
          for (let attempt = 0; attempt < 4; attempt++) {
            try {
              usage = await prepared.collect();
              if (usage.metrics.complete) break;
            } catch {
              /* Persistence can lag process exit. */
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }
        let modelMismatch = false;
        if (usage) {
          result.metrics = usage.metrics;
          result.warnings.push(...usage.warnings);
          if (
            usage.models.length !== 1 ||
            usage.models[0] !== agentProfile(config, trial.agent).model
          ) {
            modelMismatch = true;
            result.warnings.push("Observed model identities did not match the selected model.");
            result.metrics.complete = false;
          }
          if (events.malformed) result.metrics.complete = false;
          if (usage.artifactPath && result.session) {
            result.session.databasePath = usage.artifactPath;
            result.session.dataKind = usage.artifactPath.endsWith(".jsonl") ? "jsonl" : "sqlite";
          }
          await saveJson(join(directory, `${trial.id}.requests.json`), usage.requests);
        } else
          result.warnings.push(
            "Request-level usage is unavailable; no zero usage was substituted.",
          );
        result.answer = events.answer;
        result.tools = events.tools;
        result.codeMode = events.codeMode
          ? "used"
          : events.error || events.malformed || processResult.stopped || processResult.code !== 0
            ? "unknown"
            : "not-observed";
        result.warnings = [...new Set([...result.warnings, ...events.warnings])];
        const answerGrade =
          trial.workload === "task"
            ? options.benchmark === "suite"
              ? gradeSuiteAnswer(events.answer, suiteExpectedSchema.parse(expected))
              : gradeAnswer(events.answer, expectedSchema.parse(expected))
            : { schemaValid: true as const, valueMatches: events.answer.trim() === "OK" };
        result.grading = answerGrade;
        result.success =
          processResult.code === 0 &&
          !events.error &&
          !events.malformed &&
          !modelMismatch &&
          result.grading.schemaValid &&
          result.grading.valueMatches;
        result.status = options.signal.aborted
          ? "cancelled"
          : processResult.stopped
            ? "timeout"
            : processResult.code !== 0 || events.error || events.malformed || modelMismatch
              ? "failed"
              : !result.metrics?.complete
                ? "usage-incomplete"
                : "complete";
        if (result.status === "timeout" || result.status === "cancelled") result.success = false;
        if (!result.grading.schemaValid)
          result.warnings.push("Final answer did not comply with the required answer schema.");
        else if (!result.grading.valueMatches)
          result.warnings.push(
            "Final answer complied with the schema but did not match the expected values.",
          );
        if (processResult.code !== 0)
          result.warnings.push(
            `${agentLabel(trial.agent)} exited unsuccessfully. Inspect private stderr.txt in the attempt directory.`,
          );
        const after = credentials
          ? await readSuiteExpected(config, credentials, installed.gh, oracleHome)
          : await readExpected(config, token, installed.gh, oracleHome);
        if (JSON.stringify(after) !== JSON.stringify(expected)) {
          result.status = "fixture-drift";
          result.success = false;
        }
      } catch {
        result.status = options.signal.aborted ? "cancelled" : "failed";
        result.success = false;
        result.durationMs = Math.round(performance.now() - started);
        result.warnings.push(
          "Attempt failed during execution or verification; partial records remain private.",
        );
      } finally {
        await prepared.cleanup();
        await saveJson(join(directory, `${trial.id}.events.json`), events.safeEvents);
        await saveJson(resultFile, result);
      }
      options.progress(
        `  ${result.status}: initial=${result.metrics?.initialInput ?? "unknown"}; total=${result.metrics?.totalTokens ?? "unknown"}; ${result.success ? "1 success / 1 tried" : "0 success / 1 tried"}`,
      );
      if (shouldStopBatch(result.status)) {
        options.progress("Batch stopped for inspection; unstarted sessions remain pending.");
        break;
      }
    }
    await saveJson(join(directory, "summary.json"), batch.results);
    return batch;
  } finally {
    await release();
  }
}
