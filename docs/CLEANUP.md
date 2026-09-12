# Cleanup

Cleanup is local and explicit. It is a dry run unless `--apply` is present. Choose `--credentials`, `--runtime`, or both. There is no `--dry-run` flag.

After installing the direct command with `npm link`, run `tcb` commands from any directory. The default runtime root is `~/Benchmarks/tool-context-bench`. If you used `--root <path>`, supply that same global option for export and cleanup.

**Before Deletion**

1. Stop the benchmark and access checks. Avoid concurrent use of the same agent login while an attempt uses shared subscription auth.
2. Inspect the latest batch, including failures, pending sessions, expected SHA, tool routes, and usage warnings. Do not rerun until you understand the result.
3. Export or back up the sanitized records you need outside the runtime root. Runtime deletion is irreversible from this app and includes the OpenCode 2 benchmark profile, local OAuth credentials, and sessions. Do not back up its credential/session database with reports.
4. If retiring benchmark credentials, revoke them in each service separately. Then preview and apply local credential cleanup.

Inspect saved results without model calls:

```sh
tcb view latest --no-tui
```

**Optional Exports**
These commands save sanitized reports outside the runtime root. Use unused file names; shell redirection overwrites an existing file. The direct command has no npm script banner.

```sh
tcb export latest --format csv > "$HOME/tool-context-bench-export.csv"
```

```sh
tcb export latest --format json > "$HOME/tool-context-bench-export.json"
```

Inspect both files before deletion. CSV includes summary and attempt rows. JSON includes the manifest and result records. These reports do not contain every saved catalog, event, or request record. If you need that evidence, back up the relevant sanitized JSON files from `results/<batch-id>/` separately. Do not treat a native SQLite database or OpenCode log as sanitized.

Do not copy OAuth tokens or a shared auth store into a results backup. OpenCode 2's `<root>/opencode2/opencode.db` and SQLite sidecars contain credentials as well as sessions; never copy them into artifacts or report backups. Use its collected private `usage.jsonl` and sanitized result records instead. Keep any separately managed credentials separate from reports. Never put literal tokens in commands, documents, or export names.

Exports and backups outside the runtime root are user-managed. The app does not find or delete them. Sanitization can still leave private repository information. Review the content before sharing it.

**Credential Scope**
`--credentials` targets these benchmark Keychain **generic passwords**:

| Service                         | Account                                            |
| ------------------------------- | -------------------------------------------------- |
| `tool-context-bench.github`     | Current OS username, from `os.userInfo().username` |
| `tool-context-bench.supabase`   | Current OS username, from `os.userInfo().username` |
| `tool-context-bench.cloudflare` | Current OS username, from `os.userInfo().username` |
| `tool-context-bench.stripe`     | Current OS username, from `os.userInfo().username` |

You already created this item manually with:

```sh
security add-generic-password -a "$USER" -s "tool-context-bench.github" -w
```

This is a record of the setup command, not a cleanup step. Do not repeat it for an existing item. The final `-w` prompts for the secret; `$USER` must match the OS account used by cleanup.

The runner reads these credentials into memory and supplies them only to their service routes. It does not print their values or create Keychain items. OpenCode 2 local OAuth belongs to `--runtime`, not `--credentials`, because its benchmark database also stores sessions. Future service credentials must be registered in the app's cleanup support and documentation before provisioning.

**Remote Revocation**
Deleting a Keychain item does **not** revoke its remote credential. It removes one local copy only. Other copies can retain authority until the service revokes or expires the credential.

Deleting the OpenCode 2 runtime profile likewise removes only local OAuth state and sessions. It does not revoke the remote ChatGPT OAuth grant. Neither cleanup scope performs remote revocation; manage any required grant revocation separately with the provider.

In GitHub Settings, open Developer settings, then Personal access tokens. Select the benchmark PAT in the applicable token list and revoke it. Confirm the correct token before you act. The app does not perform this step or verify remote revocation.

The PAT was created manually with restricted permissions. A successful read does not prove read-only authority. Review its repository access and permissions in GitHub settings. Do not make a production write probe to test them.

After remote revocation, preview the exact local item:

```sh
tcb cleanup --credentials
```

Check the service and account in the output. Then delete only that item:

```sh
tcb cleanup --credentials --apply
```

An already absent item is reported without failure. Other Keychain access errors stop cleanup. Never use a broad Keychain delete-all command. Never delete unrelated generic-password items, personal GitHub credentials, or personal OpenCode auth.

The same rule applies to personal Claude and Codex credentials. The benchmark reuses those subscriptions; it does not own their login state. Cleanup must not log out those agents or delete their credentials.

**Runtime Scope**
Runtime cleanup requires a recognized `ownership.json` marker with owner `tool-context-bench/v1`. The root must not be a symlink. Cleanup removes only these known children:

| Child        | Removed data                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `attempts/`  | Isolated homes, config, prompts, native databases and logs, temporary files, redacted stderr, and remaining auth symlinks                                    |
| `results/`   | All saved batches, manifests, catalogs, result records, events, request usage, and summaries                                                                 |
| `probe/`     | Local GitHub preflight files                                                                                                                                 |
| `opencode2/` | Benchmark-only OpenCode 2 profile: persistent `opencode.db`, SQLite sidecars, local OAuth credentials, sessions, and private HOME/XDG/config/work/temp state |

The root directory and `ownership.json` are retained. Unrelated children are not cleanup targets. The cleanup lock is released on normal completion. This is not a recursive deletion of the root itself.

The OpenCode 1 attempt's `data/opencode/auth.json` is a symlink to the original OpenCode 1 auth file. Normal completion removes the link. Directory removal does not follow that symlink, so cleanup does not remove the original auth store. Routine subscription refresh can already have updated that shared original file; cleanup does not undo refresh.

The source auth file defaults to `$XDG_DATA_HOME/opencode/auth.json`, or `~/.local/share/opencode/auth.json` when `XDG_DATA_HOME` is unset. The global `--auth-file <path>` option selects a different source for OpenCode 1 only; it does not apply to OpenCode 2. None of these source auth files is a cleanup target.

The user explicitly chose a separate benchmark OpenCode 2 OAuth login because beta credentials and sessions share one database. Reusing the personal migrated login would require session and refresh writes to the personal database. The new `tcb auth-opencode2` command instead uses supported device login, `opencode2 auth login openai --standalone --method chatgpt-headless`, with private isolated directories and `<root>/opencode2/opencode.db`. It copies neither personal tokens nor settings. This is an explicit exception to per-attempt databases: attempts have fresh private directories and sessions, but share the persistent benchmark credential/session database. Normal attempt cleanup retains it and completed sessions as accounting evidence.

`cleanup --runtime` deletes that entire benchmark profile and local OAuth state, not personal OpenCode configuration, migrated credentials, or sessions. To run OpenCode 2 again after deletion, perform a new explicit `tcb auth-opencode2` login using the same root. `cleanup --credentials` alone leaves this profile intact.

Codex attempts have a private home with an `auth.json` link to the original `$CODEX_HOME/auth.json` or `~/.codex/auth.json`. Normal completion removes the link; recursive runtime removal does not follow it. Generated Codex model descriptors, descriptor hashes, configs, SQLite indexes, and rollout JSONL files are inside the owned attempt directory and are removed by runtime cleanup.

Claude retains its original login and application-state location and saves native sessions in shared Claude history for inspection. The benchmark also saves a redacted event stream in the attempt directory. Runtime cleanup removes that stream and generated configs, but it does not remove shared Claude sessions, global application state, or existing Keychain credentials. Cleanup does not undo any normal subscription refresh or global state update performed by an agent.

Preview runtime deletion:

```sh
tcb cleanup --runtime
```

Check every listed path and confirm your backup. Then apply:

```sh
tcb cleanup --runtime --apply
```

If both scopes are needed, use one preview and then the matching apply command instead of the separate scope commands:

```sh
tcb cleanup --credentials --runtime
```

```sh
tcb cleanup --credentials --runtime --apply
```

Combined cleanup deletes the credential first, then runtime children. It is not an atomic transaction. If a step fails, inspect what remains before you try again.

**Locks And Limits**
Cleanup refuses an active runtime lock. For a stale `run.lock`, inspect its PID and confirm that no corresponding benchmark process remains before manual lock removal. Do not remove a live lock or invent an ownership marker to bypass validation. Credential-only cleanup can work without a runtime directory; runtime cleanup requires the recognized root.

Cleanup does not delete the GitHub repository `esavv/agent-test`, change its branch, or remove the remote fixture. Fixture deletion is a separate user decision. Do not change the fixture during a batch; SHA drift stops the runner.

Local file deletion is not guaranteed secure erasure. Time Machine, filesystem snapshots, external backups, exported reports, and separately saved token copies can remain. The app cannot guarantee their removal. Manage those copies separately under your own retention policy.

**Verification Status**
The original GitHub smoke test has completed. OpenCode 2 adapter, runner/TUI, private device-auth command, and cleanup integration are implemented. Initial checks passed September 11, 2026 at 13:00 EDT (UTC-04:00); the first user batch later exposed collector and MCP startup defects. The fixes passed type checking, all 340 existing tests in 8 files, lint, format checking, and build at 15:30 EDT.

Native beta diagnostics accepted isolated login and bash configurations and exposed `chatgpt-headless`, without credentials, sessions, model calls, or remote MCP connections. `debug config` does not support `--standalone`; its isolated temporary managed services were stopped afterward. The built two-agent plan confirmed distinct OpenCode 1/2 profiles and two planned sessions, not executed sessions. The OpenCode 2 doctor matched the installed pin and correctly stopped with missing-login setup instructions; auth-command help passed. See [OpenCode 2 Local Verification](../IMPLEMENTATION_PLAN.md#opencode-2-local-verification) for details.

The user has since logged in and attempted three v2 trials. The fix investigation read their usage without changing saved results and checked all three MCP tool inventories without provider generation. MCP attempts now own a private stdio-leased server and stop it during attempt cleanup; they do not use the personal background service. No real credential deletion or remote revocation was performed. These cleanup instructions are not evidence of real credential deletion. After applying cleanup, inspect its output and the remaining local items. Confirm any remote revocation independently with the provider.

**Remove The Command**
After any exports and cleanup, remove the global command link if you no longer need it:

```sh
npm unlink --global tool-context-bench
```

This removes the linked `tcb` command from the active Node installation. It does not delete the source project, runtime data, Keychain item, or remote PAT. Complete the relevant cleanup steps first.
