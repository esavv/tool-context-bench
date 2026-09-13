import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "../src/cleanup.js";
import { configSchema, type Paths } from "../src/config.js";
import { execute } from "../src/process.js";
import {
  acquireLock,
  ensureRoot,
  loadBatch,
  loadBatchHistory,
  saveJson,
  verifyRoot,
} from "../src/storage.js";
import type { Batch, Result } from "../src/types.js";

vi.mock("../src/process.js", () => ({ execute: vi.fn<typeof execute>() }));

const config = configSchema.parse({
  repository: "fixture-owner/fixture-repo",
  branch: "main",
  opencodeVersion: "1.18.30",
  model: "openai/gpt-5.6-terra",
});
const executeMock = vi.mocked(execute);
const rawError = "synthetic-private-security-error";
const genericError = "Keychain deletion failed. Check access; no credential values were displayed.";
const authContents = '{"synthetic":"not-real-auth"}\n';
let temporary: string;
let paths: Paths;

beforeEach(async () => {
  executeMock.mockReset();
  executeMock.mockRejectedValue(new Error("Unexpected process call in cleanup test."));
  temporary = await mkdtemp(join(tmpdir(), "tool-context-bench-cleanup-test-"));
  const root = join(temporary, "runtime");
  paths = {
    root,
    attempts: join(root, "attempts"),
    results: join(root, "results"),
    marker: join(root, "ownership.json"),
    lock: join(root, "run.lock"),
    opencode2Database: join(root, "opencode2", "opencode.db"),
    account: "synthetic-account with spaces",
    auth: join(temporary, "outside", "auth.json"),
  };
  await mkdir(join(temporary, "outside"));
  await writeFile(paths.auth, authContents, { mode: 0o600 });
  await ensureRoot(paths);
  for (const child of ["attempts", "results", "probe", "opencode2"]) {
    const directory = join(root, child);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "keep-until-cleanup.txt"), child);
  }
  for (const child of ["attempts", "probe"]) {
    const directory = join(root, child, "data", "opencode");
    await mkdir(directory, { recursive: true });
    await symlink(paths.auth, join(directory, "auth.json"));
  }
  await writeFile(join(root, "unrelated.txt"), "retain this file");
  await mkdir(join(root, "unrelated-directory"));
  await writeFile(join(root, "unrelated-directory", "keep.txt"), "retain this directory");
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

async function expectRuntimeIntact(): Promise<void> {
  for (const child of ["attempts", "results", "probe", "opencode2"]) {
    expect(await readFile(join(paths.root, child, "keep-until-cleanup.txt"), "utf8")).toBe(child);
  }
  for (const child of ["attempts", "probe"]) {
    const link = join(paths.root, child, "data", "opencode", "auth.json");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(paths.auth);
  }
  expect(await readFile(paths.auth, "utf8")).toBe(authContents);
}

async function writeBatch(id: string): Promise<Batch> {
  const results: Result[] = ["02", "01"].map((minute) => ({
    trial: {
      id: `trial-${minute}`,
      agent: "opencode",
      technique: "bash",
      workload: "noop",
      repetition: 1,
    },
    status: "complete",
    success: true,
    startedAt: `2026-09-09T00:${minute}:00Z`,
    durationMs: 100,
    sessionID: null,
    metrics: null,
    warnings: [],
    answer: "OK",
    tools: [],
    codeMode: "not-observed",
    grading: { schemaValid: true, valueMatches: true },
  }));
  const batch: Batch = {
    manifest: {
      schemaVersion: 5,
      id,
      createdAt: "2026-09-09T00:00:00Z",
      benchmark: "github",
      config,
      seed: 1,
      schedule: results.map((result) => result.trial),
      expected: {
        sha: "a".repeat(40),
        subject: "Synthetic fixture",
        committed_at: "2026-09-09T00:00:00Z",
        source_url: "https://example.invalid/fixture",
      },
      versions: { opencode: "1.18.30", gh: "synthetic", node: "synthetic" },
      catalogs: {},
      exposure: "source-verified; not a live request capture",
    },
    results,
  };
  const directory = join(paths.results, id);
  await mkdir(directory);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(batch.manifest));
  for (const [index, result] of results.entries()) {
    await writeFile(join(directory, `${index}.result.json`), JSON.stringify(result));
  }
  await writeFile(join(directory, "ignored.json"), "not JSON");
  return { ...batch, results: [...results].reverse() };
}

describe("cleanup", () => {
  it("requires an explicit cleanup scope", async () => {
    await expect(
      cleanup(config, paths, { credentials: false, runtime: false, apply: true }),
    ).rejects.toThrow("Choose --credentials, --runtime, or both.");
    expect(executeMock).not.toHaveBeenCalled();
    await expectRuntimeIntact();
  });

  it("reports a dry run without deleting credentials, runtime files, or auth links", async () => {
    const before = await readdir(paths.root);
    const messages = await cleanup(config, paths, {
      credentials: true,
      runtime: true,
      apply: false,
    });
    expect(messages).toContain(
      `Would delete Keychain generic password: service=${config.keychainService}, account=${paths.account}`,
    );
    for (const child of ["attempts", "results", "probe"]) {
      expect(messages).toContain(`Would remove ${join(paths.root, child)}`);
    }
    expect(messages).toContain("Dry run only. Add --apply to perform these actions.");
    expect(messages.join("\n")).toContain("Revoke remote service credentials separately.");
    expect(executeMock).not.toHaveBeenCalled();
    expect(await readdir(paths.root)).toEqual(before);
    await expectRuntimeIntact();
  });

  it("deletes only the exact Keychain account and service, without listing items", async () => {
    executeMock.mockImplementation(async () => {
      expect((await lstat(paths.lock)).isFile()).toBe(true);
      await expectRuntimeIntact();
      return { code: 0, stdout: rawError, stderr: rawError, stopped: false };
    });
    const messages = await cleanup(config, paths, {
      credentials: true,
      runtime: false,
      apply: true,
    });
    expect(executeMock.mock.calls).toEqual([
      [
        "/usr/bin/security",
        ["delete-generic-password", "-a", paths.account, "-s", config.keychainService],
      ],
    ]);
    expect(messages).toContain("Keychain item removed.");
    expect(messages.join("\n")).not.toContain(rawError);
    await expect(lstat(paths.lock)).rejects.toMatchObject({ code: "ENOENT" });
    await expectRuntimeIntact();
  });

  it("treats exit code 44 as idempotent absence, even without a runtime root", async () => {
    await rm(paths.root, { recursive: true });
    executeMock.mockResolvedValue({ code: 44, stdout: "", stderr: rawError, stopped: false });
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages = await cleanup(config, paths, {
        credentials: true,
        runtime: false,
        apply: true,
      });
      expect(messages).toContain("Keychain item was already absent.");
      expect(messages.join("\n")).not.toContain(rawError);
    }
    expect(executeMock).toHaveBeenCalledTimes(2);
    await expect(lstat(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([1, 45, null])(
    "reports exit code %s generically and stops runtime cleanup",
    async (code) => {
      executeMock.mockResolvedValue({ code, stdout: rawError, stderr: rawError, stopped: false });
      await expect(
        cleanup(config, paths, { credentials: true, runtime: true, apply: true }),
      ).rejects.toThrow(new Error(genericError));
      await expectRuntimeIntact();
      await expect(lstat(paths.lock)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("reports a rejected process call generically without exposing its raw error", async () => {
    executeMock.mockRejectedValue(new Error(rawError));
    const failure = cleanup(config, paths, { credentials: true, runtime: true, apply: true });
    await expect(failure).rejects.toThrow();
    await expectRuntimeIntact();
    await expect(lstat(paths.lock)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(failure).rejects.toThrow(new Error(genericError));
  });

  it("removes runtime trees and auth symlinks, but retains outside targets and unrelated files", async () => {
    await symlink(join(temporary, "outside"), join(paths.results, "outside-link"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages = await cleanup(config, paths, {
        credentials: false,
        runtime: true,
        apply: true,
      });
      for (const child of ["attempts", "results", "probe", "opencode2"]) {
        await expect(lstat(join(paths.root, child))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(messages.join("\n")).toContain("Shared OpenCode auth is not deleted.");
      expect(await readFile(paths.auth, "utf8")).toBe(authContents);
      expect(await readFile(join(paths.root, "unrelated.txt"), "utf8")).toBe("retain this file");
      expect(await readFile(join(paths.root, "unrelated-directory", "keep.txt"), "utf8")).toBe(
        "retain this directory",
      );
      await verifyRoot(paths);
      await expect(lstat(paths.lock)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(executeMock).not.toHaveBeenCalled();
  });

  it.each(["attempts", "results", "probe", "opencode2"])(
    "unlinks a top-level %s symlink without following it",
    async (child) => {
      const directory = join(paths.root, child);
      await rm(directory, { recursive: true });
      await symlink(join(temporary, "outside"), directory);
      await cleanup(config, paths, { credentials: false, runtime: true, apply: true });
      await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(paths.auth, "utf8")).toBe(authContents);
      expect(executeMock).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "wrong-owner", "invalid-json", "symlink"])(
    "rejects a %s ownership root before either cleanup action",
    async (kind) => {
      let selected = paths;
      if (kind === "missing") await rm(paths.marker);
      else if (kind === "wrong-owner") await writeFile(paths.marker, '{"owner":"other"}');
      else if (kind === "invalid-json") await writeFile(paths.marker, "not JSON");
      else {
        const root = join(temporary, "linked-runtime");
        await symlink(paths.root, root);
        selected = {
          ...paths,
          root,
          marker: join(root, "ownership.json"),
          lock: join(root, "run.lock"),
        };
      }
      for (const apply of [false, true]) {
        await expect(
          cleanup(config, selected, { credentials: true, runtime: true, apply }),
        ).rejects.toThrow("Runtime root is not a recognized benchmark directory.");
      }
      expect(executeMock).not.toHaveBeenCalled();
      await expectRuntimeIntact();
    },
  );
});

describe("runtime locking", () => {
  it("creates a private exclusive lock, preserves it on contention, and permits reuse after release", async () => {
    const release = await acquireLock(paths);
    const original = await readFile(paths.lock, "utf8");
    const value: unknown = JSON.parse(original);
    expect(value).toEqual({ pid: process.pid, startedAt: expect.any(String) });
    expect((await lstat(paths.lock)).mode & 0o777).toBe(0o600);
    await expect(acquireLock(paths)).rejects.toThrow("Runtime is locked.");
    expect(await readFile(paths.lock, "utf8")).toBe(original);
    await release();
    const releaseAgain = await acquireLock(paths);
    await releaseAgain();
    await expect(lstat(paths.lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { credentials: true, runtime: false },
    { credentials: false, runtime: true },
    { credentials: true, runtime: true },
  ])("blocks dry-run and applied cleanup while locked: %j", async (scope) => {
    const release = await acquireLock(paths);
    try {
      const original = await readFile(paths.lock, "utf8");
      for (const apply of [false, true]) {
        await expect(cleanup(config, paths, { ...scope, apply })).rejects.toThrow(
          "Runtime is locked",
        );
        expect(await readFile(paths.lock, "utf8")).toBe(original);
        await expectRuntimeIntact();
      }
      expect(executeMock).not.toHaveBeenCalled();
    } finally {
      await release();
    }
  });

  it("blocks a dry run when run.lock exists but is not readable as a file", async () => {
    await mkdir(paths.lock);
    await expect(
      cleanup(config, paths, { credentials: true, runtime: true, apply: false }),
    ).rejects.toThrow("Runtime is locked");
  });
});

describe("view batch loading", () => {
  it("recovers reconciled Claude request usage without rewriting saved results", async () => {
    const batch = await writeBatch("claude-usage-batch");
    const directory = join(paths.results, "claude-usage-batch");
    const [base] = batch.results;
    if (!base) throw new Error("Expected a saved test result.");
    const result = {
      ...base,
      trial: { ...base.trial, id: "claude-limited", agent: "claude" },
      status: "usage-incomplete",
      metrics: {
        initialInput: 30,
        freshInput: 10,
        cacheRead: 20,
        cacheWrite: 0,
        totalInput: 30,
        totalOutput: 7,
        totalTokens: 37,
        reasoning: 0,
        steps: 1,
        complete: false,
      },
    };
    await writeFile(join(directory, "0.result.json"), JSON.stringify(result));
    await rm(join(directory, "1.result.json"));
    await writeFile(
      join(directory, "claude-limited.requests.json"),
      JSON.stringify([
        {
          id: "msg_limited",
          model: "claude-sonnet-5",
          freshInput: 10,
          cacheRead: 20,
          cacheWrite: 0,
          totalInput: 30,
          totalOutput: 7,
          totalTokens: 37,
          complete: true,
        },
      ]),
    );
    const before = await readFile(join(directory, "0.result.json"), "utf8");
    const loaded = await loadBatch(paths, "claude-usage-batch");
    expect(loaded.results[0]).toMatchObject({
      status: "complete",
      metrics: { complete: true, finalContext: 37 },
    });
    expect(await readFile(join(directory, "0.result.json"), "utf8")).toBe(before);
  });

  it("loads version 3 results with unknown grading without rewriting them", async () => {
    const batch = await writeBatch("version-3-batch");
    const directory = join(paths.results, "version-3-batch");
    const manifest = { ...batch.manifest, schemaVersion: 3 };
    const result = { ...batch.results[0] };
    delete result.grading;
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(directory, "0.result.json"), JSON.stringify(result));
    await rm(join(directory, "1.result.json"));
    const loaded = await loadBatch(paths, "version-3-batch");
    expect(loaded.manifest.schemaVersion).toBe(5);
    expect(loaded.results[0]?.grading).toBeNull();
    expect(await readFile(join(directory, "manifest.json"), "utf8")).toBe(JSON.stringify(manifest));
  });

  it("loads version 4 route failures as answer-graded version 5 results", async () => {
    const batch = await writeBatch("version-4-batch");
    const directory = join(paths.results, "version-4-batch");
    const manifest = { ...batch.manifest, schemaVersion: 4 };
    const result = {
      ...batch.results[0],
      status: "invalid-route",
      success: false,
      metrics: {
        initialInput: 1,
        finalContext: 1,
        totalInput: 1,
        totalOutput: 1,
        totalTokens: 2,
        cacheRead: 0,
        cacheWrite: 0,
        freshInput: 1,
        reasoning: 0,
        steps: 1,
        complete: true,
      },
      grading: { routeValid: false, schemaValid: true, valueMatches: true },
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(directory, "0.result.json"), JSON.stringify(result));
    await rm(join(directory, "1.result.json"));
    const loaded = await loadBatch(paths, "version-4-batch");
    expect(loaded.manifest.schemaVersion).toBe(5);
    expect(loaded.results[0]).toMatchObject({
      status: "complete",
      success: true,
      grading: { schemaValid: true, valueMatches: true },
    });
    expect(loaded.results[0]?.grading).not.toHaveProperty("routeValid");
  });

  it("keeps the actual filtered/read-only meaning of version 1 MCP results without rewriting them", async () => {
    const batch = await writeBatch("legacy-batch");
    const directory = join(paths.results, "legacy-batch");
    const manifest = {
      ...batch.manifest,
      schemaVersion: 1,
      config: { ...batch.manifest.config, githubToolsets: "repos" },
      catalogHash: "legacy-hash",
      schedule: batch.manifest.schedule.map((trial) => ({ ...trial, technique: "raw-mcp" })),
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    for (const [index, result] of [...batch.results].reverse().entries()) {
      await writeFile(
        join(directory, `${index}.result.json`),
        JSON.stringify({ ...result, trial: { ...result.trial, technique: "raw-mcp" } }),
      );
    }
    const loaded = await loadBatch(paths, "legacy-batch");
    expect(loaded.results.every((result) => result.trial.technique === "mcp-filter-readonly")).toBe(
      true,
    );
    expect(loaded.manifest.catalogs["mcp-filter-readonly"]?.hash).toBe("legacy-hash");
    expect(loaded.results[0]?.session?.databasePath).toContain(paths.attempts);
    expect(await readFile(join(directory, "manifest.json"), "utf8")).toBe(JSON.stringify(manifest));
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("loads only the latest directory, validates its data, and sorts results by start time", async () => {
    const older = await writeBatch("batch-001");
    const latest = await writeBatch("batch-002");
    await writeFile(join(paths.results, "zz-file"), "not a batch");
    await symlink(join(paths.results, "batch-001"), join(paths.results, "zz-link"));
    expect(await loadBatch(paths, "latest")).toMatchObject(latest);
    expect(await loadBatch(paths, "batch-001")).toMatchObject(older);
    await mkdir(join(paths.results, "incomplete-batch"));
    const history = await loadBatchHistory(paths);
    expect(history.batches.map((batch) => batch.manifest.id)).toEqual(["batch-002", "batch-001"]);
    expect(history.unavailable).toBe(1);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("selects the latest valid batch rather than an incomplete newer directory", async () => {
    const latest = await writeBatch("batch-001");
    await mkdir(join(paths.results, "batch-002"));
    expect(await loadBatch(paths, "latest")).toMatchObject(latest);
  });

  it.each([
    "",
    ".",
    "..",
    "../outside",
    "batch/../../outside",
    "/tmp",
    "..\\outside",
    "%2e%2e",
    "batch.json",
  ])("rejects an unsafe batch selector: %j", async (id) => {
    await expect(loadBatch(paths, id)).rejects.toThrow("No valid result batch selected.");
  });

  it("rejects latest when no result directories exist", async () => {
    await expect(loadBatch(paths, "latest")).rejects.toThrow("No valid result batch selected.");
  });

  it("rejects an explicitly selected symlink even when its target is a valid batch", async () => {
    await writeBatch("batch-001");
    await symlink(join(paths.results, "batch-001"), join(paths.results, "linked-batch"));
    await expect(loadBatch(paths, "linked-batch")).rejects.toThrow(
      "Result directory must not be a symlink.",
    );
  });

  it.each([
    { file: "manifest.json", contents: "not JSON" },
    { file: "manifest.json", contents: '{"schemaVersion":3}' },
    { file: "0.result.json", contents: "not JSON" },
    { file: "0.result.json", contents: '{"status":"invented"}' },
  ])("rejects malformed batch data: $file / $contents", async ({ file, contents }) => {
    await writeBatch("batch-001");
    await writeFile(join(paths.results, "batch-001", file), contents);
    await expect(loadBatch(paths, "batch-001")).rejects.toThrow();
    await expect(loadBatch(paths, "latest")).rejects.toThrow();
  });

  it("requires a recognized root before loading a valid batch", async () => {
    await writeBatch("batch-001");
    await rm(paths.marker);
    await expect(loadBatch(paths, "batch-001")).rejects.toThrow(
      "Runtime root is not a recognized benchmark directory.",
    );
  });
});

describe("saveJson", () => {
  it("creates private JSON and atomically replaces the destination without mutating an open reader", async () => {
    const destination = join(temporary, "saved.json");
    await saveJson(destination, { version: 1 });
    expect((await lstat(destination)).mode & 0o777).toBe(0o600);
    const oldContents = await readFile(destination, "utf8");
    const reader = await open(destination, "r");
    try {
      await chmod(destination, 0o644);
      await saveJson(destination, { version: 2, nested: ["synthetic"] });
      expect(await reader.readFile("utf8")).toBe(oldContents);
      expect(await readFile(destination, "utf8")).toBe(
        `${JSON.stringify({ version: 2, nested: ["synthetic"] }, null, 2)}\n`,
      );
      expect((await lstat(destination)).ino).not.toBe((await reader.stat()).ino);
      expect((await lstat(destination)).mode & 0o777).toBe(0o600);
      await expect(lstat(`${destination}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await reader.close();
    }
  });

  it("leaves the old destination intact when serialization fails", async () => {
    const destination = join(temporary, "saved.json");
    await saveJson(destination, { version: 1 });
    const before = await readFile(destination, "utf8");
    await expect(saveJson(destination, { unsupported: 1n })).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe(before);
    await expect(lstat(`${destination}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps mode 0600 when a stale temporary file has broader permissions", async () => {
    const destination = join(temporary, "saved.json");
    await writeFile(`${destination}.tmp`, "stale");
    await chmod(`${destination}.tmp`, 0o644);
    await saveJson(destination, { private: "synthetic" });
    expect((await lstat(destination)).mode & 0o777).toBe(0o600);
  });

  it("does not overwrite an outside file through a temporary-file symlink", async () => {
    const destination = join(temporary, "saved.json");
    await symlink(paths.auth, `${destination}.tmp`);
    // Either reject the unsafe temporary path or replace the link safely.
    try {
      await saveJson(destination, { private: "synthetic" });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    expect(await readFile(paths.auth, "utf8")).toBe(authContents);
  });
});
