# Cleanup

Cleanup is local and explicit. It is a dry run unless `--apply` is present. Choose `--credentials`, `--runtime`, or both. There is no `--dry-run` flag.

After installing the direct command with `npm link`, run `tcb` commands from any directory. The default runtime root is `~/Benchmarks/tool-context-bench`. If you used `--root <path>`, supply that same global option for export and cleanup.

**Before Deletion**

1. Stop the benchmark and access checks. Avoid concurrent use of the same agent login while an attempt uses shared subscription auth.
2. Inspect the latest batch, including failures, pending sessions, expected SHA, tool routes, and usage warnings. Do not rerun until you understand the result.
3. Export or back up the records you need outside the runtime root. Runtime result deletion is irreversible from this app.
4. If retiring the benchmark PAT, revoke it in GitHub settings separately. Then preview and apply local credential cleanup.

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

Do not copy OAuth tokens or the shared auth store into a results backup. Keep any separately managed credentials separate from reports. Never put literal tokens in commands, documents, or export names.

Exports and backups outside the runtime root are user-managed. The app does not find or delete them. Sanitization can still leave private repository information. Review the content before sharing it.

**Credential Scope**
The only supported local credential target is a Keychain **generic password** with:

| Field   | Exact value                                        |
| ------- | -------------------------------------------------- |
| Service | `tool-context-bench.github`                        |
| Account | Current OS username, from `os.userInfo().username` |

You already created this item manually with:

```sh
security add-generic-password -a "$USER" -s "tool-context-bench.github" -w
```

This is a record of the setup command, not a cleanup step. Do not repeat it for an existing item. The final `-w` prompts for the secret; `$USER` must match the OS account used by cleanup.

The runner only reads this credential into memory and supplies it to GitHub requests. It does not print the value or create other generic-password items. There is no current general credential registry. Before any future service credential is provisioned, its exact target and cleanup procedure must be registered in the app's cleanup support and documentation.

**Remote Revocation**
Deleting the Keychain item does **not** revoke the PAT. It removes one local copy only. Other copies can retain authority until GitHub revokes or expires the token.

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

| Child       | Removed data                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `attempts/` | Isolated homes, config, prompts, native databases and logs, temporary files, redacted stderr, and remaining auth symlinks |
| `results/`  | All saved batches, manifests, catalogs, result records, events, request usage, and summaries                              |
| `probe/`    | Local GitHub preflight files                                                                                              |

The root directory and `ownership.json` are retained. Unrelated children are not cleanup targets. The cleanup lock is released on normal completion. This is not a recursive deletion of the root itself.

The attempt's `data/opencode/auth.json` is a symlink to the original OpenCode auth file. Normal completion removes the link. Directory removal does not follow that symlink, so cleanup does not remove the original auth store. Routine subscription refresh can already have updated that shared original file; cleanup does not undo refresh.

The source auth file defaults to `$XDG_DATA_HOME/opencode/auth.json`, or `~/.local/share/opencode/auth.json` when `XDG_DATA_HOME` is unset. The existing global `--auth-file <path>` option can select a different source. None of these source auth files is a cleanup target.

Codex attempts have a private home with an `auth.json` link to the original `$CODEX_HOME/auth.json` or `~/.codex/auth.json`. Normal completion removes the link; recursive runtime removal does not follow it. Generated Codex model descriptors, descriptor hashes, configs, SQLite indexes, and rollout JSONL files are inside the owned attempt directory and are removed by runtime cleanup.

Claude retains its original login and application-state location but disables native session persistence. The benchmark saves a redacted event stream in the attempt directory. Runtime cleanup removes that stream and generated configs, not global Claude application state or its existing Keychain credentials. Cleanup does not undo any normal subscription refresh or global state update performed by an agent.

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
The GitHub smoke test has completed; live credential deletion has not been performed. These are cleanup instructions, not a record of revocation or deletion. After applying cleanup, inspect its output and the remaining local items. Confirm remote revocation independently in GitHub settings.

**Remove The Command**
After any exports and cleanup, remove the global command link if you no longer need it:

```sh
npm unlink --global tool-context-bench
```

This removes the linked `tcb` command from the active Node installation. It does not delete the source project, runtime data, Keychain item, or remote PAT. Complete the relevant cleanup steps first.
