import { access, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Config, Paths } from "./config.js";
import { execute } from "./process.js";
import { verifyRoot, acquireLock } from "./storage.js";

export async function cleanup(
  config: Config,
  paths: Paths,
  options: { credentials: boolean; runtime: boolean; apply: boolean },
): Promise<string[]> {
  const messages: string[] = [];
  if (!options.credentials && !options.runtime)
    throw new Error(
      "Choose --credentials, --runtime, or both. Cleanup is a dry run unless --apply is supplied.",
    );
  if (options.runtime) await verifyRoot(paths);
  let rootExists = false;
  try {
    await access(paths.marker);
    rootExists = true;
  } catch {
    /* Credential cleanup also works without local results. */
  }
  let release: (() => Promise<void>) | undefined;
  if (rootExists) {
    await verifyRoot(paths);
    if (options.apply) release = await acquireLock(paths);
    else {
      let locked = false;
      try {
        await lstat(paths.lock);
        locked = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
          throw new Error("Cannot check runtime lock.");
      }
      if (locked) throw new Error("Runtime is locked; stop the active run before cleanup.");
    }
  }
  try {
    if (options.credentials) {
      messages.push(
        `${options.apply ? "Delete" : "Would delete"} Keychain generic password: service=${config.keychainService}, account=${paths.account}`,
      );
      if (options.apply) {
        const result = await execute("/usr/bin/security", [
          "delete-generic-password",
          "-a",
          paths.account,
          "-s",
          config.keychainService,
        ]).catch(() => {
          throw new Error(
            "Keychain deletion failed. Check access; no credential values were displayed.",
          );
        });
        if (result.code !== 0 && result.code !== 44)
          throw new Error(
            "Keychain deletion failed. Check access; no credential values were displayed.",
          );
        messages.push(
          result.code === 44 ? "Keychain item was already absent." : "Keychain item removed.",
        );
      }
    }
    if (options.runtime) {
      for (const child of ["attempts", "results", "probe"]) {
        messages.push(`${options.apply ? "Remove" : "Would remove"} ${join(paths.root, child)}`);
        if (options.apply) await rm(join(paths.root, child), { recursive: true, force: true });
      }
      messages.push(
        "Shared OpenCode auth is not deleted. Directory removal does not follow auth symlinks.",
      );
    }
    messages.push(
      "Revoke the PAT in GitHub separately. Deleting a Keychain item does not revoke its remote authority.",
    );
    if (!options.apply) messages.push("Dry run only. Add --apply to perform these actions.");
    return messages;
  } finally {
    if (release) await release();
  }
}
