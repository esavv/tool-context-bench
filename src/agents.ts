import { z } from "zod";
import type { Config } from "./config.js";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execute } from "./process.js";
import type { Manifest } from "./types.js";

export const agentSchema = z.enum(["claude", "codex", "opencode"]);
export type Agent = z.infer<typeof agentSchema>;

export function agentProfile(config: Config, agent: Agent) {
  if (agent === "claude")
    return { version: config.claudeVersion, model: config.claudeModel, variant: config.variant };
  if (agent === "codex")
    return { version: config.codexVersion, model: config.codexModel, variant: config.variant };
  return { version: config.opencodeVersion, model: config.model, variant: config.variant };
}

export function agentLabel(agent: Agent): string {
  return agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "OpenCode";
}

export async function binaries(config: Config, selected: Agent[]) {
  const locate = async (name: string) => {
    const result = await execute("/usr/bin/which", [name]);
    const path = result.stdout.trim();
    if (result.code !== 0 || !path.startsWith("/") || path.includes("\n"))
      throw new Error(`${name} is not installed on PATH.`);
    return realpath(path);
  };
  const gh = await locate("gh");
  const ghVersion = await execute(gh, ["--version"]);
  if (ghVersion.code !== 0) throw new Error("Cannot read gh version.");
  const versions: Manifest["versions"] = {
    gh: ghVersion.stdout.split("\n")[0] ?? "unknown",
    node: process.version,
  };
  const executables: Partial<Record<Agent, string>> = {};
  for (const agent of selected) {
    const profile = agentProfile(config, agent);
    const pinned =
      agent === "claude"
        ? join(homedir(), ".local/share/claude/versions", profile.version)
        : agent === "codex"
          ? join(
              homedir(),
              ".codex/packages/standalone/releases",
              `${profile.version}-aarch64-apple-darwin/bin/codex`,
            )
          : null;
    let binary: string;
    try {
      if (!pinned) throw new Error();
      await access(pinned);
      binary = pinned;
    } catch {
      binary = await locate(agent);
    }
    const result = await execute(binary, ["--version"]);
    const observed = result.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
    if (result.code !== 0 || observed !== profile.version)
      throw new Error(
        `${agentLabel(agent)} version mismatch: expected ${profile.version}, observed ${observed ?? "unknown"}.`,
      );
    executables[agent] = binary;
    versions[agent] = observed;
  }
  return { gh, executables, versions };
}
