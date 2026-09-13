import { z } from "zod";
import { configSchema } from "./config.js";
import { techniqueSchema } from "./techniques.js";
import { agentSchema, type Agent } from "./agents.js";

export { techniqueSchema, type Technique } from "./techniques.js";
export const benchmarkSchema = z.enum(["github", "suite"]);
export type Benchmark = z.infer<typeof benchmarkSchema>;
export const trialSchema = z.object({
  id: z.string(),
  agent: agentSchema,
  technique: techniqueSchema,
  workload: z.enum(["task", "noop"]),
  repetition: z.number().int().positive(),
});
export type Trial = z.infer<typeof trialSchema>;

export const expectedSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  subject: z.string(),
  committed_at: z.string(),
  source_url: z.string().url(),
});
export type Expected = z.infer<typeof expectedSchema>;

export const suiteExpectedSchema = z.object({
  github: expectedSchema,
  supabase: z.object({ id: z.string().uuid(), slug: z.string(), status: z.string() }),
  cloudflare: z.object({
    uuid: z.string().uuid(),
    name: z.string(),
    created_at: z.string(),
    version: z.string(),
  }),
  stripe: z.object({ webhook_endpoint_id: z.string(), description: z.string().nullable() }),
});
export type SuiteExpected = z.infer<typeof suiteExpectedSchema>;

export const metricSchema = z.object({
  initialInput: z.number().nullable(),
  finalContext: z.number().nullable().default(null),
  totalInput: z.number(),
  totalOutput: z.number(),
  totalTokens: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  freshInput: z.number(),
  reasoning: z.number(),
  steps: z.number(),
  complete: z.boolean(),
});
export type Metrics = z.infer<typeof metricSchema>;

export const gradingSchema = z.discriminatedUnion("schemaValid", [
  z
    .object({
      schemaValid: z.literal(false),
      valueMatches: z.null(),
    })
    .strict(),
  z
    .object({
      schemaValid: z.literal(true),
      valueMatches: z.boolean(),
    })
    .strict(),
]);
export type Grading = z.infer<typeof gradingSchema>;

export const resultSchema = z.object({
  trial: trialSchema,
  status: z.enum([
    "running",
    "complete",
    "failed",
    "timeout",
    "cancelled",
    "fixture-drift",
    "usage-incomplete",
  ]),
  success: z.boolean(),
  startedAt: z.string(),
  durationMs: z.number(),
  sessionID: z.string().nullable(),
  metrics: metricSchema.nullable(),
  warnings: z.array(z.string()),
  answer: z.string(),
  tools: z.array(
    z.object({ name: z.string(), status: z.string(), command: z.string().optional() }),
  ),
  codeMode: z.enum(["used", "not-observed", "unknown"]),
  grading: gradingSchema.nullable().default(null),
  origin: z.object({ batchID: z.string(), trialID: z.string() }).optional(),
  session: z
    .object({
      configPath: z.string(),
      databasePath: z.string(),
      workDirectory: z.string(),
      settings: z.array(z.string()),
      dataKind: z.enum(["sqlite", "jsonl"]).optional(),
    })
    .optional(),
});
export type Result = z.infer<typeof resultSchema>;

export const manifestSchema = z.object({
  schemaVersion: z.literal(5),
  id: z.string(),
  createdAt: z.string(),
  benchmark: benchmarkSchema.default("github"),
  config: configSchema,
  seed: z.number().int(),
  schedule: z.array(trialSchema),
  expected: z.union([expectedSchema, suiteExpectedSchema]),
  versions: z.object({
    claude: z.string().optional(),
    codex: z.string().optional(),
    opencode: z.string().optional(),
    opencode2: z.string().optional(),
    pi: z.string().optional(),
    supabase: z.string().optional(),
    wrangler: z.string().optional(),
    stripe: z.string().optional(),
    executor: z.string().optional(),
    gh: z.string(),
    node: z.string(),
  }),
  catalogs: z
    .partialRecord(
      techniqueSchema,
      z.object({ hash: z.string(), toolCount: z.number().int().nonnegative().nullable() }),
    )
    .default({}),
  exposure: z.literal("source-verified; not a live request capture"),
});
export type Manifest = z.infer<typeof manifestSchema>;

export interface Batch {
  manifest: Manifest;
  results: Result[];
  profiles?: { agent: Agent; version: string; model: string; variant: string }[];
}

export interface BatchHistory {
  batches: Batch[];
  unavailable: number;
}
