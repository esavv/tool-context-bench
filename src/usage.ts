import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Metrics } from "./types.js";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_./:-]+$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const object = z.record(z.string(), z.unknown());
const snapshotSchema = z.object({
  sessions: z.array(z.unknown()),
  messages: z.array(z.unknown()),
  parts: z.array(z.unknown()),
});
const sessionSchema = z.object({ id: identifier, parent_id: identifier.nullable() });
const messageSchema = z.object({
  id: identifier,
  session_id: identifier,
  time_created: count,
  data: z.unknown(),
});
const partSchema = z.object({
  id: identifier,
  message_id: identifier,
  session_id: identifier,
  data: z.unknown(),
});

export interface RequestUsage {
  sessionID: string;
  messageID: string;
  startPartID: string | null;
  finishPartID: string | null;
  sequence: number;
  kind: "main" | "summary" | "child" | "unknown";
  matchedStart: boolean;
  finished: boolean;
  messageCreatedAt: number | null;
  messageCompletedAt: number | null;
  providerID: string | null;
  modelID: string | null;
  /** OpenCode-normalized fields, not a capture of the provider response. */
  raw: {
    input: number | null;
    output: number | null;
    reasoning: number | null;
    cache: { read: number | null; write: number | null };
    total: number | null;
  };
  input: number | null;
  output: number | null;
  total: number | null;
}

export interface UsageReport {
  metrics: Metrics;
  requests: RequestUsage[];
  warnings: string[];
  /** Distinct providerID/modelID pairs, including observed auxiliary models. */
  models: string[];
}

function decodeObject(value: unknown, json = false): Record<string, unknown> | undefined {
  try {
    const decoded: unknown = json && typeof value === "string" ? JSON.parse(value) : value;
    const parsed = object.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function numeric(value: unknown): number | null {
  const parsed = count.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function sum(values: (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return numeric(values.reduce<number>((total, value) => total + (value ?? 0), 0));
}

/**
 * Parse a SQLite-shaped snapshot: { sessions: row[], messages: row[], parts: row[] }.
 * Data columns can be JSON strings or decoded objects. Supply the root and all
 * descendants, including empty sessions. Numeric Metrics are observed subtotals
 * when complete is false; a zero subtotal does not prove measured zero usage.
 * Completeness applies to persisted step accounting, not provider-field coverage
 * or process-wide expenditure. The two source limitations always remain visible.
 * Source: OpenCode v1.18.29 session/{processor,session,message-v2}.ts.
 */
export function parseUsage(snapshot: unknown, sessionID: string): UsageReport {
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new Error("OpenCode usage data is unavailable.");
  const metrics: Metrics = {
    initialInput: null,
    finalContext: null,
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
  const warnings = new Set<string>([
    "Source limitation: OpenCode normalizes absent upstream usage fields to zero; stored zeros do not prove measured zeros.",
    "Scope limitation: only persisted step-finish usage is collected; unrecorded auxiliary calls (including title generation) are not measured.",
  ]);
  const warn = (message: string) => {
    metrics.complete = false;
    warnings.add(message);
  };
  const sessions = new Map<string, { parentID: string | null; data: Record<string, unknown> }>();
  for (const row of parsed.data.sessions) {
    const info = sessionSchema.safeParse(row);
    const data = decodeObject(row);
    if (!info.success || !data) {
      warn("Missing or invalid session metadata.");
      continue;
    }
    if (sessions.has(info.data.id)) {
      warn("Duplicate session rows.");
      continue;
    }
    sessions.set(info.data.id, { parentID: info.data.parent_id, data });
  }
  if (!sessions.has(sessionID)) throw new Error("OpenCode usage session is unavailable.");
  const scope = new Set([sessionID]);
  for (let previous = 0; previous !== scope.size; ) {
    previous = scope.size;
    for (const [id, session] of sessions) {
      if (session.parentID !== null && scope.has(session.parentID)) scope.add(id);
    }
  }
  if (scope.size > 1)
    warn("Auxiliary child sessions found; their usage is excluded from main metrics.");

  const messages = new Map<string, z.infer<typeof messageSchema>>();
  let uncertainOrder = false;
  for (const row of parsed.data.messages) {
    const info = messageSchema.safeParse(row);
    if (!info.success) {
      warn("Missing or invalid message metadata.");
      uncertainOrder = true;
      continue;
    }
    if (!scope.has(info.data.session_id)) continue;
    if (messages.has(info.data.id)) {
      warn("Duplicate message rows.");
      continue;
    }
    messages.set(info.data.id, info.data);
  }
  const parts = new Map<string, z.infer<typeof partSchema>[]>();
  const partIDs = new Set<string>();
  for (const row of parsed.data.parts) {
    const info = partSchema.safeParse(row);
    if (!info.success) {
      warn("Missing or invalid part metadata.");
      uncertainOrder = true;
      continue;
    }
    if (!scope.has(info.data.session_id)) continue;
    if (partIDs.has(info.data.id)) {
      warn("Duplicate part IDs; repeated rows are not counted twice.");
      continue;
    }
    partIDs.add(info.data.id);
    const list = parts.get(info.data.message_id) ?? [];
    list.push(info.data);
    parts.set(info.data.message_id, list);
    if (!messages.has(info.data.message_id)) {
      warn("Parts have a missing parent message; usage cannot be classified as main.");
      uncertainOrder = true;
    }
  }

  const requests: RequestUsage[] = [];
  const models = new Set<string>();
  const ordered = [...messages.values()].sort(
    (a, b) => a.time_created - b.time_created || compareID(a.id, b.id),
  );
  const messageIDs = [
    ...ordered.map((message) => message.id),
    ...[...parts.keys()].filter((id) => !messages.has(id)),
  ];
  for (const messageID of messageIDs) {
    const message = messages.get(messageID);
    const data = decodeObject(message?.data, true);
    const messageParts = (parts.get(messageID) ?? []).sort((a, b) => compareID(a.id, b.id));
    const owner = message?.session_id ?? messageParts[0]?.session_id;
    if (!owner) continue;
    const role = z.enum(["assistant", "user"]).safeParse(data?.role);
    if (!role.success) {
      warn("Missing or invalid message data.");
      uncertainOrder = true;
    }
    const summary = z.boolean().optional().safeParse(data?.summary);
    const auxiliary =
      (summary.success && summary.data === true) ||
      (typeof data?.agent === "string" && ["compaction", "summary", "title"].includes(data.agent));
    const kind: RequestUsage["kind"] =
      owner !== sessionID
        ? "child"
        : !role.success || role.data !== "assistant" || !summary.success
          ? "unknown"
          : auxiliary
            ? "summary"
            : "main";
    if (!summary.success) warn("Invalid assistant summary classification.");
    if (auxiliary) warn("Auxiliary summary work found; its usage is excluded from main metrics.");
    const time = decodeObject(data?.time);
    const completed = numeric(time?.completed);
    const provider = identifier.safeParse(data?.providerID);
    const model = identifier.safeParse(data?.modelID);
    if (role.success && role.data === "assistant") {
      if (completed === null)
        warn("Assistant message is incomplete or has no completion timestamp.");
      if (data?.error !== undefined && data.error !== null)
        warn("Assistant message records an error; finished usage is retained.");
      if (!provider.success || !model.success)
        warn("Assistant model identity is missing or invalid.");
      else models.add(`${provider.data}/${model.data}`);
    }
    const makeRequest = (startPartID: string | null): RequestUsage => ({
      sessionID: owner,
      messageID,
      startPartID,
      finishPartID: null,
      sequence: requests.length + 1,
      kind,
      matchedStart: false,
      finished: false,
      messageCreatedAt: message?.time_created ?? null,
      messageCompletedAt: completed,
      providerID: provider.success ? provider.data : null,
      modelID: model.success ? model.data : null,
      raw: {
        input: null,
        output: null,
        reasoning: null,
        cache: { read: null, write: null },
        total: null,
      },
      input: null,
      output: null,
      total: null,
    });
    let pending: RequestUsage | undefined;
    let observed = false;
    for (const part of messageParts) {
      if (part.session_id !== owner) {
        warn("Part and message session identities do not match.");
        continue;
      }
      const body = decodeObject(part.data, true);
      if (!body || typeof body.type !== "string") {
        warn("Missing or invalid part data.");
        uncertainOrder = true;
        continue;
      }
      if (body.type === "compaction" || body.type === "subtask") {
        warn("Auxiliary compaction or subtask marker found; accounting is not complete.");
      }
      if (body.type !== "step-start" && body.type !== "step-finish") continue;
      observed = true;
      if (kind === "unknown") warn("Step usage has an unknown request kind.");
      if (body.type === "step-start") {
        if (pending) warn("Unmatched step-start; usage is missing.");
        pending = makeRequest(part.id);
        requests.push(pending);
        continue;
      }
      const request = pending ?? makeRequest(null);
      if (!pending) {
        requests.push(request);
        warn("Orphan step-finish has no matching step-start.");
      }
      request.matchedStart = pending !== undefined;
      pending = undefined;
      request.finishPartID = part.id;
      request.finished = true;
      const tokens = decodeObject(body.tokens);
      const cache = decodeObject(tokens?.cache);
      request.raw = {
        input: numeric(tokens?.input),
        output: numeric(tokens?.output),
        reasoning: numeric(tokens?.reasoning),
        cache: { read: numeric(cache?.read), write: numeric(cache?.write) },
        total: numeric(tokens?.total),
      };
      const raw = request.raw;
      request.input = sum([raw.input, raw.cache.read, raw.cache.write]);
      request.output = sum([raw.output, raw.reasoning]);
      const derived = sum([request.input, request.output]);
      request.total = derived ?? raw.total;
      if (derived === null)
        warn(
          "Step-finish has missing or invalid token categories, or an unsafe sum; only known usage is retained.",
        );
      if (tokens?.total !== undefined && raw.total === null)
        warn("Step-finish has an invalid native total.");
      if (raw.total !== null && derived !== null && raw.total !== derived)
        warn("Native total discrepancy: step categories do not match tokens.total.");
      if (derived === 0 && raw.total === null)
        warn("All-zero step-finish without a native total does not establish measured usage.");
    }
    if (pending) warn("Unmatched step-start; usage is missing.");
    if (!observed && role.success && role.data === "assistant") {
      requests.push(makeRequest(null));
      warn("Assistant message has no step usage; message tokens are not a fallback.");
    }
  }

  if (models.size > 1)
    warn(
      "Multiple assistant models observed; compare model identities with the trial configuration.",
    );
  const main = requests.filter((request) => request.kind === "main");
  const first = main[0];
  if (!uncertainOrder && first?.matchedStart) metrics.initialInput = first.input;
  const last = main.at(-1);
  if (!uncertainOrder && last?.finished) metrics.finalContext = sum([last.input, last.output]);
  if (main.length === 0) warn("No main step usage found.");
  for (const request of main) {
    if (!request.finished) continue;
    metrics.steps += 1;
    metrics.freshInput += request.raw.input ?? 0;
    metrics.cacheRead += request.raw.cache.read ?? 0;
    metrics.cacheWrite += request.raw.cache.write ?? 0;
    metrics.reasoning += request.raw.reasoning ?? 0;
    metrics.totalInput +=
      (request.raw.input ?? 0) + (request.raw.cache.read ?? 0) + (request.raw.cache.write ?? 0);
    metrics.totalOutput += (request.raw.output ?? 0) + (request.raw.reasoning ?? 0);
    metrics.totalTokens +=
      request.total ??
      (request.raw.input ?? 0) +
        (request.raw.cache.read ?? 0) +
        (request.raw.cache.write ?? 0) +
        (request.raw.output ?? 0) +
        (request.raw.reasoning ?? 0);
  }
  for (const value of Object.values(metrics)) {
    if (typeof value === "number" && !Number.isSafeInteger(value))
      warn("Aggregated token counts exceed safe integer precision.");
  }
  // Session counters cover all persisted steps in that session, not just main work.
  const fields = [
    "tokens_input",
    "tokens_output",
    "tokens_reasoning",
    "tokens_cache_read",
    "tokens_cache_write",
  ];
  for (const id of scope) {
    const session = sessions.get(id);
    const finished = requests.filter((request) => request.sessionID === id && request.finished);
    if (finished.length === 0) warn("Session has no finished step usage.");
    const totals = [0, 0, 0, 0, 0];
    let valid = true;
    for (const request of finished) {
      const values = [
        request.raw.input,
        request.raw.output,
        request.raw.reasoning,
        request.raw.cache.read,
        request.raw.cache.write,
      ];
      for (const [index, value] of values.entries()) {
        if (value === null) valid = false;
        totals[index] = (totals[index] ?? 0) + (value ?? 0);
      }
    }
    for (const [index, field] of fields.entries()) {
      const native = numeric(session?.data[field]);
      if (native === null) warn("Missing or invalid session token counters.");
      else if (!valid || native !== totals[index])
        warn("Session counter mismatch: native counters cannot be reconciled with finished steps.");
    }
  }
  return { metrics, requests, warnings: [...warnings], models: [...models].sort() };
}

function compareID(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Read one consistent snapshot without writing to the OpenCode database. */
export function collectUsage(databasePath: string, sessionID: string): UsageReport {
  try {
    using database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA query_only = ON; BEGIN");
    const tree = `WITH RECURSIVE scope(id) AS (
      SELECT id FROM session WHERE id = ?
      UNION
      SELECT child.id FROM session child JOIN scope ON child.parent_id = scope.id
    )`;
    const sessions: unknown = database
      .prepare(`${tree}
      SELECT id, parent_id, tokens_input, tokens_output, tokens_reasoning,
        tokens_cache_read, tokens_cache_write FROM session WHERE id IN scope`)
      .all(sessionID);
    const messages: unknown = database
      .prepare(`${tree}
      SELECT id, session_id, time_created, data FROM message
      WHERE session_id IN scope ORDER BY time_created, id`)
      .all(sessionID);
    const parts: unknown = database
      .prepare(`${tree}
      SELECT id, message_id, session_id, data FROM part
      WHERE session_id IN scope ORDER BY message_id, id`)
      .all(sessionID);
    const report = parseUsage({ sessions, messages, parts }, sessionID);
    database.exec("COMMIT");
    return report;
  } catch {
    // Neither SQLite errors nor JSON validation errors may expose database content.
    throw new Error("OpenCode usage collection failed; database or session data is unavailable.");
  }
}
