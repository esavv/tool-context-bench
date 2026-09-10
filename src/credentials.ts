import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { stripVTControlCharacters } from "node:util";
import type { Config, Paths } from "./config.js";
import { execute } from "./process.js";

export async function githubToken(config: Config, paths: Paths): Promise<string> {
  const result = await execute("/usr/bin/security", [
    "find-generic-password",
    "-a",
    paths.account,
    "-s",
    config.keychainService,
    "-w",
  ]);
  if (result.code !== 0 || result.stopped)
    throw new Error(
      "GitHub Keychain item is unavailable. Check the item and unlock/access prompts on this Mac.",
    );
  const token = result.stdout.trim();
  if (!/^[A-Za-z0-9_]+$/.test(token) || token.length < 20)
    throw new Error("GitHub Keychain item is not a valid token value.");
  return token;
}

export async function inspectSubscription(authPath: string): Promise<void> {
  try {
    const file = await stat(authPath);
    if (!file.isFile()) throw new Error();
    const raw: unknown = JSON.parse(await readFile(authPath, "utf8"));
    const auth = z.record(z.string(), z.unknown()).parse(raw);
    z.object({ type: z.literal("oauth"), refresh: z.string().min(1) }).parse(auth.openai);
    if (
      Object.values(auth).some(
        (value) => z.object({ type: z.literal("wellknown") }).safeParse(value).success,
      )
    ) {
      throw new Error("remote-config");
    }
  } catch {
    throw new Error(
      "Expected an existing OpenCode OpenAI OAuth login and no remote-config auth entries. Auth values were not displayed.",
    );
  }
}

export function redact(text: string, secrets: string[] = []): string {
  let result = text;
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, "[REDACTED]");
  result = result
    .replace(/\b(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]");
  return Array.from(stripVTControlCharacters(result))
    .filter(
      (char) =>
        char === "\n" || char === "\t" || (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    )
    .join("");
}
