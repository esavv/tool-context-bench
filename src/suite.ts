import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { Config, Paths } from "./config.js";
import { githubToken, keychainToken } from "./credentials.js";
import { readExpected, type Catalog } from "./github.js";
import { execute, minimalEnvironment } from "./process.js";
import type { SuiteExpected, Technique, Trial } from "./types.js";
import { suiteExpectedSchema } from "./types.js";

export interface SuiteCredentials {
  github: string;
  supabase: string;
  cloudflare: string;
  stripe: string;
}

export interface SuiteServer {
  url: string;
  headers: Record<string, string>;
}

const urls = {
  github: "https://api.githubcopilot.com/mcp/",
  supabase: "https://mcp.supabase.com/mcp",
  cloudflare: "https://bindings.mcp.cloudflare.com/mcp",
  stripe: "https://mcp.stripe.com",
};

export async function suiteCredentials(config: Config, paths: Paths): Promise<SuiteCredentials> {
  if (!config.suite) throw new Error("The suite configuration is missing.");
  const [github, supabase, cloudflare, stripe] = await Promise.all([
    githubToken(config, paths),
    keychainToken(config.suite.supabase.keychainService, paths, "Supabase"),
    keychainToken(config.suite.cloudflare.keychainService, paths, "Cloudflare"),
    keychainToken(config.suite.stripe.keychainService, paths, "Stripe"),
  ]);
  return { github, supabase, cloudflare, stripe };
}

export function suiteServers(
  config: Config,
  technique: Technique,
  credentials: SuiteCredentials,
): Record<string, SuiteServer> {
  if (!config.suite) throw new Error("The suite configuration is missing.");
  const tuned = technique !== "mcp-raw";
  const supabase = new URL(urls.supabase);
  if (tuned) {
    supabase.searchParams.set("project_ref", config.suite.supabase.projectRef);
    supabase.searchParams.set("read_only", "true");
    supabase.searchParams.set("features", "functions");
  }
  return {
    github: {
      url: urls.github,
      headers: {
        Authorization: `Bearer ${credentials.github}`,
        ...(tuned ? { "X-MCP-Toolsets": "repos", "X-MCP-Readonly": "true" } : {}),
      },
    },
    supabase: {
      url: supabase.toString(),
      headers: { Authorization: `Bearer ${credentials.supabase}` },
    },
    cloudflare: {
      url: urls.cloudflare,
      headers: {
        Authorization: `Bearer ${credentials.cloudflare}`,
        "X-Cloudflare-Account-Id": config.suite.cloudflare.accountId,
      },
    },
    stripe: {
      url: urls.stripe,
      headers: { Authorization: `Bearer ${credentials.stripe}` },
    },
  };
}

async function serverCatalog(name: string, server: SuiteServer) {
  const client = new Client({ name: "tool-context-bench", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(30_000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
  });
  try {
    await client.connect(transport);
    const tools = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor) || cursors.size > 20) throw new Error("pagination");
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    if (!tools.length) throw new Error();
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return {
      name,
      tools,
      instructions: client.getInstructions() ?? "",
      server: client.getServerVersion() ?? null,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function readSuiteCatalog(
  config: Config,
  technique: Technique,
  credentials: SuiteCredentials,
): Promise<Catalog> {
  if (technique === "bash") throw new Error("Bash has no MCP catalog.");
  try {
    const catalogs = await Promise.all(
      Object.entries(suiteServers(config, technique, credentials)).map(([name, server]) =>
        serverCatalog(name, server),
      ),
    );
    const tools = catalogs.flatMap((catalog) =>
      catalog.tools.map((tool) => ({ ...tool, _server: catalog.name })),
    );
    const names = catalogs.flatMap((catalog) =>
      catalog.tools.map((tool) => `${catalog.name}_${tool.name}`),
    );
    const readOnlyNames = catalogs.flatMap((catalog) =>
      catalog.tools
        .filter((tool) => tool.annotations?.readOnlyHint === true)
        .map((tool) => `${catalog.name}_${tool.name}`),
    );
    const evidence = catalogs.map(({ name, tools: serverTools, instructions, server }) => ({
      name,
      tools: serverTools,
      instructions,
      server,
    }));
    return {
      hash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
      names,
      readOnlyNames,
      tools,
      instructions: "",
      server: evidence,
    };
  } catch {
    throw new Error(`Suite MCP catalog for ${technique} is unavailable or invalid.`);
  }
}

export const suiteBinDirectory = dirname(
  fileURLToPath(new URL("../node_modules/.bin/supabase", import.meta.url)),
);

export async function suiteCliVersions(config: Config) {
  if (!config.suite) throw new Error("The suite configuration is missing.");
  const commands = [
    ["supabase", config.suite.cliVersions.supabase],
    ["wrangler", config.suite.cliVersions.wrangler],
    ["stripe", config.suite.cliVersions.stripe],
  ];
  const versions: Record<string, string> = {};
  for (const [name, expected] of commands) {
    if (!name || !expected) throw new Error("Invalid suite CLI version configuration.");
    const result = await execute(localBinary(name), ["--version"]);
    const observed = result.stdout.match(/\d+\.\d+\.\d+/)?.[0];
    if (result.code !== 0 || observed !== expected)
      throw new Error(
        `${name} version mismatch: expected ${expected}, observed ${observed ?? "unknown"}.`,
      );
    versions[name] = observed;
  }
  return versions;
}

function localBinary(name: string): string {
  return fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));
}

export async function readSuiteExpected(
  config: Config,
  credentials: SuiteCredentials,
  gh: string,
  home: string,
): Promise<SuiteExpected> {
  const suite = config.suite;
  if (!suite) throw new Error("The suite configuration is missing.");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const [github, supabaseResult, cloudflareResult, stripeResult] = await Promise.all([
    readExpected(config, credentials.github, gh, home),
    execute(
      localBinary("supabase"),
      ["functions", "list", "--project-ref", suite.supabase.projectRef, "--output-format", "json"],
      {
        env: { ...minimalEnvironment(), HOME: home, SUPABASE_ACCESS_TOKEN: credentials.supabase },
        cwd: home,
      },
    ),
    execute(localBinary("wrangler"), ["d1", "list", "--json"], {
      env: {
        ...minimalEnvironment(),
        HOME: home,
        CLOUDFLARE_API_TOKEN: credentials.cloudflare,
        CLOUDFLARE_ACCOUNT_ID: suite.cloudflare.accountId,
      },
      cwd: home,
    }),
    execute(localBinary("stripe"), ["webhook_endpoints", "list", "--limit", "100"], {
      env: { ...minimalEnvironment(), HOME: home, STRIPE_API_KEY: credentials.stripe },
      cwd: home,
    }),
  ]);
  if (
    [supabaseResult, cloudflareResult, stripeResult].some(
      (result) => result.code !== 0 || result.stopped,
    )
  )
    throw new Error("A suite fixture read failed.");
  try {
    const functions = z
      .array(z.record(z.string(), z.unknown()))
      .parse(JSON.parse(supabaseResult.stdout));
    const fn = functions.find(
      (item) =>
        item.id === suite.supabase.edgeFunctionId && item.slug === suite.supabase.edgeFunctionSlug,
    );
    const databases = z
      .array(z.record(z.string(), z.unknown()))
      .parse(JSON.parse(cloudflareResult.stdout));
    const database = databases.find((item) => item.uuid === suite.cloudflare.d1DatabaseId);
    const stripe = z
      .object({ data: z.array(z.record(z.string(), z.unknown())) })
      .parse(JSON.parse(stripeResult.stdout));
    const endpoint = stripe.data.find((item) => item.id === suite.stripe.webhookEndpointId);
    return suiteExpectedSchema.parse({
      github,
      supabase: { id: fn?.id, slug: fn?.slug, status: fn?.status },
      cloudflare: {
        uuid: database?.uuid,
        name: database?.name,
        created_at: database?.created_at,
        version: database?.version,
      },
      stripe: { webhook_endpoint_id: endpoint?.id, description: endpoint?.description ?? null },
    });
  } catch {
    throw new Error("Suite services returned unexpected fixture data.");
  }
}

export function suiteAnswerMatches(text: string, expected: SuiteExpected): boolean {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```$/, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const answer = suiteExpectedSchema.parse(
      JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned),
    );
    return (
      answer.github.sha === expected.github.sha &&
      answer.github.subject === expected.github.subject &&
      Date.parse(answer.github.committed_at) === Date.parse(expected.github.committed_at) &&
      answer.github.source_url === expected.github.source_url &&
      answer.supabase.id === expected.supabase.id &&
      answer.supabase.slug === expected.supabase.slug &&
      answer.supabase.status === expected.supabase.status &&
      answer.cloudflare.uuid === expected.cloudflare.uuid &&
      answer.cloudflare.name === expected.cloudflare.name &&
      Date.parse(answer.cloudflare.created_at) === Date.parse(expected.cloudflare.created_at) &&
      answer.cloudflare.version === expected.cloudflare.version &&
      answer.stripe.webhook_endpoint_id === expected.stripe.webhook_endpoint_id &&
      answer.stripe.description === expected.stripe.description
    );
  } catch {
    return false;
  }
}

export function suitePrompt(config: Config, trial: Trial): string {
  if (!config.suite) throw new Error("The suite configuration is missing.");
  if (trial.workload === "noop") return "Reply with exactly OK. Do not call any tools.";
  const route =
    trial.technique === "bash"
      ? "Use only the installed gh, supabase, wrangler, and stripe CLIs for remote service reads."
      : trial.technique === "tool-search"
        ? "Use only native tool discovery and the configured MCP services. OpenCode 2 uses its integrated search and code-mode execute mechanism."
        : "Use only the configured GitHub, Supabase, Cloudflare, and Stripe MCP tools.";
  return `Read these four remote fixtures without changing data:
- GitHub branch ${config.branch} in ${config.repository}: tip sha, subject, committed_at, and source_url.
- Supabase Edge Function ${config.suite.supabase.edgeFunctionSlug} in project ${config.suite.supabase.projectRef}: id, slug, and status.
- Cloudflare D1 database ${config.suite.cloudflare.d1DatabaseName}: uuid, name, created_at, and version.
- Stripe sandbox webhook endpoint ${config.suite.stripe.webhookEndpointId}: webhook_endpoint_id and description.
Return exactly one JSON object with github, supabase, cloudflare, and stripe objects. Use remote data and no local fixture checkout. ${route} Do not use SDKs, curl, or another route.`;
}
