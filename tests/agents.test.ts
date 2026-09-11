import { expect, it, vi } from "vitest";
import { binaries, defaultAgents } from "../src/agents.js";
import { configSchema } from "../src/config.js";
import { execute } from "../src/process.js";

vi.mock("../src/process.js", () => ({ execute: vi.fn<typeof execute>() }));

it("checks the full OpenCode 2 prerelease version with its native v prefix", async () => {
  const config = configSchema.parse({
    repository: "fixture/repo",
    branch: "main",
    opencodeVersion: "1.18.30",
    model: "openai/gpt-5.6-terra",
  });
  let beta = "0.0.0-beta-19425";
  vi.mocked(execute).mockImplementation(async (binary, args) => ({
    code: 0,
    stopped: false,
    stderr: "",
    stdout:
      binary === "/usr/bin/which"
        ? "/bin/bash\n"
        : args[0] === "--version"
          ? `opencode2 v${beta}\n`
          : "",
  }));
  expect((await binaries(config, ["opencode2"])).versions.opencode2).toBe(beta);
  beta = "0.0.0-beta-19426";
  await expect(binaries(config, ["opencode2"])).rejects.toThrow("version mismatch");
  expect(defaultAgents).toEqual(["claude", "codex", "opencode"]);
});
