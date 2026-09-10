import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { execute, minimalEnvironment } from "./process.js";
import { expectedSchema, type Expected, type Technique } from "./types.js";
import { mcpHeaders, techniqueSettings } from "./techniques.js";

export const MCP_URL = "https://api.githubcopilot.com/mcp/";

export const githubHeaders = mcpHeaders;

export async function readExpected(
  config: Config,
  token: string,
  gh: string,
  home: string,
): Promise<Expected> {
  const response = await execute(
    gh,
    ["api", `repos/${config.repository}/commits/${encodeURIComponent(config.branch)}`],
    {
      env: {
        ...minimalEnvironment(),
        HOME: home,
        GH_TOKEN: token,
        GH_PROMPT_DISABLED: "1",
        GH_HOST: "github.com",
        GH_CONFIG_DIR: home,
      },
    },
  );
  if (response.code !== 0 || response.stopped)
    throw new Error(
      "GitHub read failed. Check repository, branch, PAT permissions, and expiration.",
    );
  try {
    const raw: unknown = JSON.parse(response.stdout);
    const commit = z
      .object({
        sha: z.string(),
        html_url: z.string(),
        commit: z.object({ message: z.string(), committer: z.object({ date: z.string() }) }),
      })
      .parse(raw);
    return expectedSchema.parse({
      sha: commit.sha,
      subject: commit.commit.message.split("\n")[0] ?? "",
      committed_at: commit.commit.committer.date,
      source_url: commit.html_url,
    });
  } catch {
    throw new Error("GitHub returned an unexpected commit response.");
  }
}

export interface Catalog {
  hash: string;
  names: string[];
  readOnlyNames: string[];
  tools: unknown[];
  instructions: string;
  server: unknown;
}

export async function readCatalog(technique: Technique, token: string): Promise<Catalog> {
  const client = new Client({ name: "tool-context-bench", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: githubHeaders(technique, token) },
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
    if (
      tools.length === 0 ||
      (techniqueSettings(technique).readOnly &&
        tools.some((tool) => tool.annotations?.readOnlyHint === false))
    )
      throw new Error("catalog");
    tools.sort((a, b) => a.name.localeCompare(b.name));
    const instructions = client.getInstructions() ?? "";
    const server = client.getServerVersion() ?? null;
    return {
      hash: createHash("sha256").update(JSON.stringify({ tools, instructions })).digest("hex"),
      names: tools.map((tool) => `github_${tool.name}`),
      readOnlyNames: tools
        .filter(
          (tool) =>
            tool.annotations?.readOnlyHint === true ||
            (techniqueSettings(technique).readOnly && tool.annotations?.readOnlyHint !== false),
        )
        .map((tool) => `github_${tool.name}`),
      tools,
      instructions,
      server,
    };
  } catch {
    throw new Error(`GitHub MCP catalog for ${technique} is unavailable or invalid.`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function answerMatches(text: string, expected: Expected): boolean {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```$/, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const value: unknown = JSON.parse(
      start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned,
    );
    const answer = expectedSchema.parse(value);
    return (
      answer.sha === expected.sha &&
      answer.subject === expected.subject &&
      Date.parse(answer.committed_at) === Date.parse(expected.committed_at) &&
      answer.source_url === expected.source_url
    );
  } catch {
    return false;
  }
}
