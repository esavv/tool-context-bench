import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { collectUsage, parseUsage } from "../src/usage.js";

const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 }, total: 185 };
function session(id = "s", parentID: string | null = null, multiplier = 1) {
  return {
    id,
    parent_id: parentID,
    tokens_input: 100 * multiplier,
    tokens_output: 20 * multiplier,
    tokens_reasoning: 5 * multiplier,
    tokens_cache_read: 50 * multiplier,
    tokens_cache_write: 10 * multiplier,
  };
}
function message(id = "m", sessionID = "s", data: Record<string, unknown> = {}, created = 1) {
  return {
    id,
    session_id: sessionID,
    time_created: created,
    data: {
      role: "assistant",
      providerID: "openai",
      modelID: "test-model",
      time: { created, completed: created + 1 },
      ...data,
    },
  };
}
function part(id: string, type: string, usage: unknown = tokens, messageID = "m", sessionID = "s") {
  return { id, message_id: messageID, session_id: sessionID, data: { type, tokens: usage } };
}
function fixture(parts = [part("p1", "step-start"), part("p2", "step-finish")]) {
  return { sessions: [session()], messages: [message()], parts };
}

describe("parseUsage", () => {
  it("includes cached input and reasoning exactly once", () => {
    const report = parseUsage(fixture(), "s");
    expect(report.metrics).toEqual({
      initialInput: 160,
      totalInput: 160,
      totalOutput: 25,
      totalTokens: 185,
      cacheRead: 50,
      cacheWrite: 10,
      freshInput: 100,
      reasoning: 5,
      steps: 1,
      complete: true,
    });
    expect(report.requests[0]).toMatchObject({
      sessionID: "s",
      messageID: "m",
      startPartID: "p1",
      finishPartID: "p2",
      matchedStart: true,
      finished: true,
      kind: "main",
      raw: tokens,
    });
    expect(report.models).toEqual(["openai/test-model"]);
    expect(report.warnings.join(" ")).toContain("absent upstream usage fields");
  });

  it("sums every step in a message, sorted by part ID, not message tokens", () => {
    const snapshot = fixture([
      part("p4", "step-finish"),
      part("p2", "step-finish"),
      part("p3", "step-start"),
      part("p1", "step-start"),
    ]);
    snapshot.sessions = [session("s", null, 2)];
    snapshot.messages = [message("m", "s", { tokens })];
    const report = parseUsage(snapshot, "s");
    expect(report.metrics).toMatchObject({
      steps: 2,
      totalInput: 320,
      totalOutput: 50,
      totalTokens: 370,
      complete: true,
    });
    expect(report.requests.map((request) => request.startPartID)).toEqual(["p1", "p3"]);
  });

  it("does not assign a later finish to a first start whose finish is missing", () => {
    const report = parseUsage(
      fixture([part("p1", "step-start"), part("p2", "step-start"), part("p3", "step-finish")]),
      "s",
    );
    expect(report.metrics).toMatchObject({
      initialInput: null,
      steps: 1,
      totalTokens: 185,
      complete: false,
    });
    expect(report.requests[0]).toMatchObject({
      startPartID: "p1",
      finished: false,
      raw: { input: null },
    });
    expect(report.requests[1]).toMatchObject({ startPartID: "p2", finishPartID: "p3" });
  });

  it("orders messages by creation time with ID ties and preserves missing first usage", () => {
    const snapshot = fixture([
      part("p2", "step-start", tokens, "m2"),
      part("p3", "step-finish", tokens, "m2"),
    ]);
    snapshot.messages = [message("m2", "s", {}, 2), message("m1", "s", { tokens }, 1)];
    const report = parseUsage(snapshot, "s");
    expect(report.requests.map((request) => request.messageID)).toEqual(["m1", "m2"]);
    expect(report.metrics).toMatchObject({ initialInput: null, steps: 1, complete: false });
  });

  it("retains finished usage on an error without time.completed", () => {
    const snapshot = fixture();
    snapshot.messages = [
      message("m", "s", { time: { created: 1 }, error: { message: "PRIVATE ERROR" } }),
    ];
    const report = parseUsage(snapshot, "s");
    expect(report.metrics).toMatchObject({
      initialInput: 160,
      totalTokens: 185,
      steps: 1,
      complete: false,
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE ERROR");
  });

  it("retains orphan finishes but cannot establish initial input", () => {
    const report = parseUsage(fixture([part("p2", "step-finish")]), "s");
    expect(report.metrics).toMatchObject({
      initialInput: null,
      totalTokens: 185,
      steps: 1,
      complete: false,
    });
    expect(report.requests[0]).toMatchObject({ matchedStart: false, startPartID: null });
  });

  it("does not match steps across messages", () => {
    const snapshot = fixture([part("p1", "step-start"), part("p2", "step-finish", tokens, "m2")]);
    snapshot.messages.push(message("m2", "s", {}, 2));
    const report = parseUsage(snapshot, "s");
    expect(report.requests.every((request) => !request.matchedStart)).toBe(true);
    expect(report.metrics.complete).toBe(false);
  });

  it("retains known usage when the final started step never finishes", () => {
    const snapshot = fixture();
    snapshot.parts.push(part("p3", "step-start"));
    const report = parseUsage(snapshot, "s");
    expect(report.metrics).toMatchObject({
      initialInput: 160,
      steps: 1,
      totalTokens: 185,
      complete: false,
    });
    expect(report.requests[1]).toMatchObject({ finished: false, total: null });
  });

  it.each([null, "SECRET", JSON.stringify(tokens)])(
    "rejects invalid token objects: %s",
    (usage) => {
      const report = parseUsage(
        fixture([part("p1", "step-start"), part("p2", "step-finish", usage)]),
        "s",
      );
      expect(report.metrics).toMatchObject({
        initialInput: null,
        steps: 1,
        totalTokens: 0,
        complete: false,
      });
      expect(report.requests[0]?.raw.input).toBeNull();
      expect(JSON.stringify(report)).not.toContain("SECRET");
    },
  );

  it.each([
    undefined,
    null,
    -1,
    1.5,
    "100",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("preserves unknown input rather than replacing %s with measured zero", (input) => {
    const report = parseUsage(
      fixture([part("p1", "step-start"), part("p2", "step-finish", { ...tokens, input })]),
      "s",
    );
    expect(report.requests[0]).toMatchObject({
      raw: { input: null, total: 185 },
      input: null,
      total: 185,
    });
    expect(report.metrics).toMatchObject({
      initialInput: null,
      totalTokens: 185,
      freshInput: 0,
      steps: 1,
      complete: false,
    });
  });

  it.each([
    {},
    { input: 100, output: 20 },
    { ...tokens, cache: {} },
    { ...tokens, reasoning: undefined },
  ])("requires every disjoint category", (usage) => {
    const report = parseUsage(
      fixture([part("p1", "step-start"), part("p2", "step-finish", usage)]),
      "s",
    );
    expect(report.metrics.complete).toBe(false);
    expect(report.metrics.steps).toBe(1);
    expect(report.warnings.join(" ")).toContain("missing or invalid token categories");
  });

  it("allows an absent native total for nonzero complete categories", () => {
    const { total: _total, ...usage } = tokens;
    const report = parseUsage(
      fixture([part("p1", "step-start"), part("p2", "step-finish", usage)]),
      "s",
    );
    expect(report.metrics.complete).toBe(true);
    expect(report.requests[0]).toMatchObject({ raw: { total: null }, total: 185 });
  });

  it.each([999, -1, "185", null])(
    "detects native total discrepancies or invalid totals: %s",
    (total) => {
      const report = parseUsage(
        fixture([part("p1", "step-start"), part("p2", "step-finish", { ...tokens, total })]),
        "s",
      );
      expect(report.metrics).toMatchObject({ totalTokens: 185, complete: false });
    },
  );

  it("requires evidence beyond default all-zero categories", () => {
    const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    const snapshot = fixture([part("p1", "step-start"), part("p2", "step-finish", zero)]);
    snapshot.sessions = [session("s", null, 0)];
    expect(parseUsage(snapshot, "s").metrics.complete).toBe(false);
    snapshot.parts = [part("p1", "step-start"), part("p2", "step-finish", { ...zero, total: 0 })];
    expect(parseUsage(snapshot, "s").metrics).toMatchObject({
      initialInput: 0,
      totalTokens: 0,
      complete: true,
    });
  });

  it("detects session counter mismatches without using them as a fallback", () => {
    const snapshot = fixture();
    snapshot.sessions = [session("s", null, 2)];
    const report = parseUsage(snapshot, "s");
    expect(report.metrics).toMatchObject({ totalTokens: 185, complete: false });
    expect(report.warnings.join(" ")).toContain("Session counter mismatch");
    expect(
      parseUsage({ ...snapshot, sessions: [{ id: "s", parent_id: null }] }, "s").warnings.join(" "),
    ).toContain("Missing or invalid session token counters");
  });

  it("does not fall back to assistant-message tokens", () => {
    const snapshot = fixture([]);
    snapshot.messages = [message("m", "s", { tokens })];
    const report = parseUsage(snapshot, "s");
    expect(report.metrics).toMatchObject({
      initialInput: null,
      totalTokens: 0,
      steps: 0,
      complete: false,
    });
    expect(report.requests[0]?.raw.input).toBeNull();
  });

  it("deduplicates repeated part IDs defensively", () => {
    const snapshot = fixture();
    snapshot.parts.push(part("p2", "step-finish"));
    const report = parseUsage(snapshot, "s");
    expect(report.metrics).toMatchObject({ steps: 1, totalTokens: 185, complete: false });
    expect(report.warnings.join(" ")).toContain("Duplicate part IDs");
  });

  it("tracks summary and recursive child usage outside main metrics", () => {
    const snapshot = fixture();
    snapshot.sessions = [
      session("s", null, 2),
      session("child", "s"),
      session("grandchild", "child"),
    ];
    snapshot.messages.push(
      message("summary", "s", { summary: true }, 2),
      message("cm", "child"),
      message("gm", "grandchild"),
    );
    for (const [id, owner] of [
      ["summary", "s"],
      ["cm", "child"],
      ["gm", "grandchild"],
    ]) {
      if (!id || !owner) throw new Error("Invalid test fixture.");
      snapshot.parts.push(
        part(`${id}1`, "step-start", tokens, id, owner),
        part(`${id}2`, "step-finish", tokens, id, owner),
      );
    }
    const report = parseUsage(snapshot, "s");
    expect(report.metrics).toMatchObject({
      initialInput: 160,
      steps: 1,
      totalTokens: 185,
      complete: false,
    });
    expect(report.requests.filter((request) => request.kind === "child")).toHaveLength(2);
    expect(report.requests.find((request) => request.kind === "summary")?.total).toBe(185);
    expect(report.warnings.join(" ")).not.toContain("Session counter mismatch");
  });

  it("warns even when a child session has no messages", () => {
    const snapshot = fixture();
    snapshot.sessions.push(session("child", "s", 0));
    expect(parseUsage(snapshot, "s").metrics.complete).toBe(false);
  });

  it.each(["compaction", "summary", "title"])("classifies the auxiliary %s agent", (agent) => {
    const snapshot = fixture();
    snapshot.messages = [message("m", "s", { agent })];
    const report = parseUsage(snapshot, "s");
    expect(report.requests[0]).toMatchObject({ kind: "summary", total: 185 });
    expect(report.metrics).toMatchObject({
      initialInput: null,
      steps: 0,
      totalTokens: 0,
      complete: false,
    });
  });

  it.each(["compaction", "subtask"])("detects auxiliary %s markers on user messages", (type) => {
    const snapshot = fixture();
    snapshot.messages.push(message("user", "s", { role: "user" }));
    snapshot.parts.push(part("aux", type, undefined, "user"));
    const report = parseUsage(snapshot, "s");
    expect(report.metrics).toMatchObject({ steps: 1, totalTokens: 185, complete: false });
  });

  it("reports model identities without copying message content", () => {
    const snapshot = fixture();
    snapshot.sessions = [session("s", null, 2)];
    snapshot.messages.push(
      message("m2", "s", {
        providerID: "other",
        modelID: "replacement",
        text: "SECRET",
        tokens: { secret: "SECRET" },
      }),
    );
    snapshot.parts.push(
      part("p3", "step-start", tokens, "m2"),
      part("p4", "step-finish", tokens, "m2"),
    );
    const report = parseUsage(snapshot, "s");
    expect(report.models).toEqual(["openai/test-model", "other/replacement"]);
    expect(report.metrics.complete).toBe(false);
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("retains unclassified usage when its parent message is missing", () => {
    const report = parseUsage({ ...fixture(), messages: [] }, "s");
    expect(report.metrics).toMatchObject({ initialInput: null, totalTokens: 0, complete: false });
    expect(report.requests[0]).toMatchObject({ kind: "unknown", total: 185 });
  });

  it("handles invalid JSON without leaking it or losing other finished steps", () => {
    const snapshot = fixture();
    const report = parseUsage(
      {
        ...snapshot,
        parts: [
          ...snapshot.parts,
          { id: "p3", session_id: "s", message_id: "m", data: "SECRET INVALID JSON" },
        ],
      },
      "s",
    );
    expect(report.metrics).toMatchObject({ steps: 1, totalTokens: 185, complete: false });
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("keeps numeric usage from a malformed message without claiming main attribution", () => {
    const report = parseUsage(
      { ...fixture(), messages: [{ id: "m", session_id: "s", time_created: 1, data: "SECRET" }] },
      "s",
    );
    expect(report.requests[0]).toMatchObject({ kind: "unknown", total: 185 });
    expect(report.metrics).toMatchObject({ initialInput: null, steps: 0, complete: false });
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("does not claim an empty session is measured zero", () => {
    const report = parseUsage({ sessions: [session("s", null, 0)], messages: [], parts: [] }, "s");
    expect(report.metrics).toMatchObject({
      initialInput: null,
      steps: 0,
      totalTokens: 0,
      complete: false,
    });
  });

  it("rejects a missing session with a bounded generic error", () => {
    expect(() => parseUsage(fixture(), "SECRET")).toThrow("OpenCode usage session is unavailable.");
    expect(() => parseUsage("SECRET", "s")).toThrow("OpenCode usage data is unavailable.");
  });
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("collectUsage", () => {
  it("reads a SQLite snapshot, includes descendants, and does not change the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "tcb-usage-"));
    directories.push(directory);
    const path = join(directory, "usage.sqlite");
    using database = new DatabaseSync(path);
    database.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);`);
    for (const row of [session(), session("child", "s"), session("unrelated")]) {
      database
        .prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          row.id,
          row.parent_id,
          row.tokens_input,
          row.tokens_output,
          row.tokens_reasoning,
          row.tokens_cache_read,
          row.tokens_cache_write,
        );
      const msg = message(`${row.id}m`, row.id);
      database
        .prepare("INSERT INTO message VALUES (?, ?, ?, ?)")
        .run(msg.id, msg.session_id, msg.time_created, JSON.stringify(msg.data));
      for (const p of [
        part(`${row.id}1`, "step-start", tokens, msg.id, row.id),
        part(`${row.id}2`, "step-finish", tokens, msg.id, row.id),
      ]) {
        database
          .prepare("INSERT INTO part VALUES (?, ?, ?, ?)")
          .run(p.id, p.message_id, p.session_id, JSON.stringify(p.data));
      }
    }
    const before = readFileSync(path);
    const report = collectUsage(path, "s");
    expect(report.metrics).toMatchObject({ steps: 1, totalTokens: 185, complete: false });
    expect(report.requests.map((request) => request.sessionID).sort()).toEqual(["child", "s"]);
    expect(readFileSync(path)).toEqual(before);
    database.exec("BEGIN; UPDATE session SET tokens_input = 999 WHERE id = 's'");
    expect(collectUsage(path, "s").warnings.join(" ")).not.toContain("Session counter mismatch");
    database.exec("ROLLBACK");
    expect(() => collectUsage(path, "SECRET' OR 1=1 --")).toThrow(
      "OpenCode usage collection failed; database or session data is unavailable.",
    );
    expect(() =>
      database.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("s2", "sm", "s", "{}"),
    ).toThrow();
  });

  it("does not create a missing database or expose a path in errors", () => {
    const directory = mkdtempSync(join(tmpdir(), "tcb-usage-"));
    directories.push(directory);
    const path = join(directory, "SECRET.sqlite");
    expect(() => collectUsage(path, "SECRET")).toThrow(
      "OpenCode usage collection failed; database or session data is unavailable.",
    );
    expect(() => readFileSync(path)).toThrow();
  });
});
