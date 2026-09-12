import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Catalog } from "./github.js";
import { minimalEnvironment } from "./process.js";
import { suiteServers, type SuiteCredentials } from "./suite.js";

export const executorVersion = "1.6.8";
export const executorToolNames = ["executor_execute", "executor_resume", "executor_skills"];

export interface ExecutorConnection {
  url: string;
  headers: Record<string, string>;
  cleanup: () => Promise<void>;
}

export function executorCatalog(upstream: Catalog): Catalog {
  const evidence = {
    executorVersion,
    downstreamTools: ["execute", "resume", "skills"],
    upstreamCatalogHash: upstream.hash,
    upstreamServer: upstream.server,
  };
  return {
    hash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    names: [...executorToolNames],
    tools: upstream.tools,
    instructions: "Executor code execution over the approved tuned suite MCP catalog.",
    server: evidence,
  };
}

const executorBinary = fileURLToPath(new URL("../node_modules/.bin/executor", import.meta.url));
const sourceToolSchema = z.object({
  _server: z.string(),
  name: z.string(),
  annotations: z.object({ readOnlyHint: z.boolean().optional() }).optional(),
});
const executorToolSchema = z.object({
  address: z.string(),
  integration: z.string(),
  connection: z.string(),
  name: z.string(),
  description: z.string(),
  pluginId: z.string(),
  requiresApproval: z.boolean().nullable().optional(),
});

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Cannot reserve a local Executor port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      return;
    }
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* The process already stopped. */
          }
        }
        resolve();
      }, 3_000),
    ),
  ]);
}

async function cleanup(child: ChildProcess, dataDirectory: string): Promise<void> {
  await stop(child);
  await rm(dataDirectory, { recursive: true, force: true });
}

async function request(
  origin: string,
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Executor API ${method} ${path} failed (${response.status}).`);
  return response.json();
}

async function waitUntilReady(origin: string, token: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Executor stopped during startup.");
    try {
      await request(origin, token, "/tools");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Executor did not become ready within 10 seconds.");
}

function policyAddress(address: string): string {
  return address.replace(/^tools\./, "");
}

export async function prepareExecutor(
  directory: string,
  config: Config,
  credentials: SuiteCredentials,
  catalog: Catalog,
): Promise<ExecutorConnection> {
  const dataDirectory = join(directory, "executor");
  const scopeDirectory = join(dataDirectory, "scope");
  const authDirectory = join(dataDirectory, "server-control");
  await mkdir(scopeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  await writeFile(join(authDirectory, "auth.json"), `${JSON.stringify({ token })}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    executorBinary,
    [
      "daemon",
      "run",
      "--foreground",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--scope",
      scopeDirectory,
      "--log-level",
      "error",
    ],
    {
      cwd: scopeDirectory,
      env: {
        ...minimalEnvironment(),
        EXECUTOR_DATA_DIR: dataDirectory,
        EXECUTOR_SCOPE_DIR: scopeDirectory,
      },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    },
  );
  try {
    await waitUntilReady(origin, token, child);
    const servers = suiteServers(config, "executor", credentials);
    for (const [name, server] of Object.entries(servers)) {
      const headers = Object.fromEntries(
        Object.entries(server.headers).filter(
          ([header]) => header.toLowerCase() !== "authorization",
        ),
      );
      await request(origin, token, "/mcp/servers", "POST", {
        transport: "remote",
        name,
        slug: name,
        endpoint: server.url,
        remoteTransport: "streamable-http",
        headers,
        authenticationTemplate: [
          {
            slug: "bearer",
            type: "apiKey",
            headers: {
              Authorization: ["Bearer ", { type: "variable", name: "token" }],
            },
          },
        ],
      });
      await request(origin, token, "/connections", "POST", {
        owner: "org",
        name: "benchmark",
        integration: name,
        template: "bearer",
        value: credentials[name as keyof SuiteCredentials],
      });
    }

    const sourceTools = z.array(sourceToolSchema).parse(catalog.tools);
    const allTools = z.array(executorToolSchema).parse(await request(origin, token, "/tools"));
    const sourceByName = new Map(sourceTools.map((tool) => [`${tool._server}:${tool.name}`, tool]));
    const imported = allTools.filter((tool) =>
      sourceByName.has(`${tool.integration}:${tool.name}`),
    );
    if (
      imported.length !== sourceTools.length ||
      new Set(imported.map((tool) => `${tool.integration}:${tool.name}`)).size !==
        sourceTools.length
    )
      throw new Error("Executor imported tool catalog does not match the approved suite catalog.");

    const schemas = await Promise.all(
      imported.map(async (tool) => ({
        address: tool.address,
        sha256: createHash("sha256")
          .update(
            JSON.stringify(
              await request(
                origin,
                token,
                `/tools/schema?address=${encodeURIComponent(tool.address)}`,
              ),
            ),
          )
          .digest("hex"),
      })),
    );
    for (const tool of imported) {
      const source = sourceByName.get(`${tool.integration}:${tool.name}`);
      if (source?.annotations?.readOnlyHint !== true) continue;
      await request(origin, token, "/policies", "POST", {
        owner: "org",
        pattern: policyAddress(tool.address),
        action: "approve",
      });
    }
    await request(origin, token, "/policies", "POST", {
      owner: "org",
      pattern: "executor.coreTools.connections.list",
      action: "approve",
    });
    await request(origin, token, "/policies", "POST", {
      owner: "org",
      pattern: "*",
      action: "block",
    });
    const policies = await request(origin, token, "/policies");

    const mcpUrl = `${origin}/mcp?artifacts=false`;
    const client = new Client({ name: "tool-context-bench", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    let downstream;
    try {
      await client.connect(transport);
      downstream = await client.listTools();
    } finally {
      await client.close().catch(() => undefined);
    }
    const downstreamNames = downstream.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(downstreamNames) !== JSON.stringify(["execute", "resume", "skills"]))
      throw new Error(
        `Executor downstream MCP catalog is not the expected minimal surface: ${downstreamNames.join(", ")}.`,
      );

    await writeFile(
      join(directory, "executor-evidence.json"),
      `${JSON.stringify(
        {
          version: executorVersion,
          hosting: "local isolated foreground daemon",
          upstreamCatalogHash: catalog.hash,
          integrations: Object.entries(servers).map(([name, server]) => ({
            name,
            url: server.url,
            headers: Object.keys(server.headers).filter(
              (header) => header.toLowerCase() !== "authorization",
            ),
          })),
          importedTools: imported,
          policies,
          schemas,
          downstream: downstream.tools,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return {
      url: mcpUrl,
      headers: { Authorization: `Bearer ${token}` },
      cleanup: () => cleanup(child, dataDirectory),
    };
  } catch (error) {
    await cleanup(child, dataDirectory);
    throw error;
  }
}
