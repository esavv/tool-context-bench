import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { resolve, join } from "node:path";
import { z } from "zod";

export const configSchema = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  branch: z
    .string()
    .min(1)
    .regex(/^[\w./-]+$/),
  opencodeVersion: z.literal("1.18.30"),
  opencode2Version: z.literal("0.0.0-beta-19425").default("0.0.0-beta-19425"),
  model: z.literal("openai/gpt-5.6-terra"),
  claudeVersion: z.literal("2.1.267").default("2.1.267"),
  claudeModel: z.literal("claude-sonnet-5").default("claude-sonnet-5"),
  codexVersion: z.literal("0.153.3").default("0.153.3"),
  codexModel: z.literal("gpt-5.6-terra").default("gpt-5.6-terra"),
  piVersion: z.literal("0.85.1").default("0.85.1"),
  piModel: z.literal("openai-codex/gpt-5.6-terra").default("openai-codex/gpt-5.6-terra"),
  variant: z.enum(["low", "medium", "high"]).default("medium"),
  repeats: z.number().int().min(1).max(10).default(3),
  timeoutSeconds: z.number().int().min(10).max(600).default(180),
  maxSteps: z.number().int().min(2).max(20).default(8),
  keychainService: z.literal("tool-context-bench.github").default("tool-context-bench.github"),
  suite: z
    .strictObject({
      cliVersions: z.strictObject({
        supabase: z.literal("2.117.0"),
        wrangler: z.literal("4.131.1"),
        stripe: z.literal("1.50.11"),
      }),
      supabase: z.strictObject({
        projectRef: z.string().regex(/^[a-z]{20}$/),
        edgeFunctionId: z.string().uuid(),
        edgeFunctionSlug: z.string().min(1),
        keychainService: z.literal("tool-context-bench.supabase"),
      }),
      cloudflare: z.strictObject({
        accountId: z.string().regex(/^[a-f0-9]{32}$/),
        d1DatabaseId: z.string().uuid(),
        d1DatabaseName: z.literal("agent-test"),
        keychainService: z.literal("tool-context-bench.cloudflare"),
      }),
      stripe: z.strictObject({
        webhookEndpointId: z.string().regex(/^we_[A-Za-z0-9]+$/),
        livemode: z.literal(false),
        keychainService: z.literal("tool-context-bench.stripe"),
      }),
    })
    .optional(),
});
export type Config = z.infer<typeof configSchema>;

export async function loadConfig(path: string): Promise<Config> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return configSchema.parse(value);
}

export function runtimePaths(root = join(homedir(), "Benchmarks", "tool-context-bench")) {
  return {
    root: resolve(root),
    attempts: resolve(root, "attempts"),
    results: resolve(root, "results"),
    marker: resolve(root, "ownership.json"),
    lock: resolve(root, "run.lock"),
    opencode2Database: resolve(root, "opencode2", "opencode.db"),
    account: userInfo().username,
    auth: join(
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
      "opencode",
      "auth.json",
    ),
  };
}
export type Paths = ReturnType<typeof runtimePaths>;
