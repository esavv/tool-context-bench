import { expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { parseSuiteExpected, suitePrompt } from "../src/suite.js";

const functionID = "11111111-1111-4111-8111-111111111111";
const databaseID = "22222222-2222-4222-8222-222222222222";
const config = configSchema.parse({
  repository: "fixture/repo",
  branch: "main",
  opencodeVersion: "1.18.30",
  model: "openai/gpt-5.6-terra",
  suite: {
    cliVersions: { supabase: "2.117.0", wrangler: "4.131.1", stripe: "1.50.11" },
    supabase: {
      projectRef: "abcdefghijklmnopqrst",
      edgeFunctionId: functionID,
      edgeFunctionSlug: "hello-world",
      keychainService: "tool-context-bench.supabase",
    },
    cloudflare: {
      accountId: "a".repeat(32),
      d1DatabaseId: databaseID,
      d1DatabaseName: "agent-test",
      keychainService: "tool-context-bench.cloudflare",
    },
    stripe: {
      webhookEndpointId: "we_fixture",
      livemode: false,
      keychainService: "tool-context-bench.stripe",
    },
  },
});

it("states the exact suite answer field names", () => {
  const text = suitePrompt(config, {
    id: "opencode2-mcp-raw-task-1",
    agent: "opencode2",
    technique: "mcp-raw",
    workload: "task",
    repetition: 1,
  });
  expect(text).toContain("sha (full tip SHA), subject, committed_at, and source_url");
  expect(text).toContain("Use exactly the field names listed above.");
});

it("parses the Supabase functions response envelope", () => {
  const github = {
    sha: "a".repeat(40),
    subject: "fixture",
    committed_at: "2026-09-09T00:00:00Z",
    source_url: "https://github.com/fixture/repo/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  expect(
    parseSuiteExpected(
      config,
      github,
      JSON.stringify({
        functions: [
          {
            id: functionID,
            slug: "hello-world",
            status: "ACTIVE",
          },
        ],
        message: "",
      }),
      JSON.stringify([
        {
          uuid: databaseID,
          name: "agent-test",
          created_at: "2026-09-11T21:43:16.827Z",
          version: "production",
        },
      ]),
      JSON.stringify({ data: [{ id: "we_fixture", description: null }] }),
    ),
  ).toMatchObject({
    github,
    supabase: { slug: "hello-world", status: "ACTIVE" },
    cloudflare: { name: "agent-test", version: "production" },
    stripe: { webhook_endpoint_id: "we_fixture", description: null },
  });
});
