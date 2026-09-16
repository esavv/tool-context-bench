# tool-context-bench

Measure token usage of agent tool calls across bash, MCP, tool search, and code execution with a CLI and TUI.

## Screenshots

#### Token usage for a single GitHub task

<img width="1286" height="496" alt="Screenshot-2026-09-13-6 00 23-PM" src="https://github.com/user-attachments/assets/ab35a9e4-d8ea-4698-af1c-a2ca551cc748" />

#### Token usage for a multi-tool task, using GitHub, Cloudflare, Stripe, and Supabase

<img width="1284" height="462" alt="Screenshot-2026-09-13-6 00 00-PM" src="https://github.com/user-attachments/assets/b7a117c4-cd42-484f-8acb-88fd2ec62d57" />

## Usage

Install dependencies, build the CLI, and link `tcb`:

```sh
npm ci
npm run build
npm link
```

Run the GitHub benchmark for one agent:

```sh
tcb run --benchmark github --agents opencode
```

Run the GitHub benchmark for all supported agents:

```sh
tcb run --benchmark github
```

Run the multi-tool benchmark for all supported agents. `pi` runs only use bash.

```sh
tcb run --benchmark suite
```

View the latest run in the TUI without making model calls:

```sh
tcb view latest
```

See options:

```sh
tcb --help
tcb run --help
tcb view --help
```

## Versions

### Agents and models

| Agent           |            Version | Model                        | Effort   |
| --------------- | -----------------: | ---------------------------- | -------- |
| Claude Code     |          `2.1.267` | `claude-sonnet-5`            | `medium` |
| Codex CLI       |          `0.153.3` | `gpt-5.6-terra`              | `medium` |
| OpenCode 1      |          `1.18.30` | `openai/gpt-5.6-terra`       | `medium` |
| OpenCode 2 beta | `0.0.0-beta-19425` | `openai/gpt-5.6-terra`       | `medium` |
| pi coding agent |           `0.85.1` | `openai-codex/gpt-5.6-terra` | `medium` |

### Benchmark tools

| Tool               |   Version |
| ------------------ | --------: |
| Node.js            | `24.18.0` |
| GitHub CLI         |  `2.97.0` |
| Supabase CLI       | `2.117.0` |
| Wrangler           | `4.131.1` |
| Stripe CLI         | `1.50.11` |
| Executor           |   `1.6.8` |
| MCP TypeScript SDK |  `1.30.0` |

### MCP

| Service    | Server              | Reported version                                                    |
| ---------- | ------------------- | ------------------------------------------------------------------- |
| GitHub     | `github-mcp-server` | `github-mcp-server/remote-d2d339e31592ae3fd8fe9c5277c6b220f7d7bab9` |
| Supabase   | `supabase`          | `0.12.0`                                                            |
| Cloudflare | `workers-bindings`  | `0.5.5`                                                             |
| Stripe     | `stripe-mcp`        | `1.0.0`                                                             |

## Configuration

| Agent           | MCP                                                               | Tool search                                                                     | Native code mode                                                                    | Executor                                                                  |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Claude Code     | Disabled for `bash`; strict explicit servers for MCP techniques   | `ENABLE_TOOL_SEARCH=true` only for `tool-search`; otherwise false               | Disabled                                                                            | Only the local Executor MCP server is exposed for `executor`              |
| Codex CLI       | Disabled for `bash`; direct tools omit `deferred` and `code_mode` | Terra metadata uses `tool_mode=tool_search`; MCP omits `direct` and `code_mode` | Feature flags disabled                                                              | Only the local Executor MCP server is enabled for `executor`              |
| OpenCode 1      | Disabled for `bash`; GitHub MCP is enabled for MCP techniques     | No separate search mode; experimental search is disabled with Code Mode         | `OPENCODE_EXPERIMENTAL_CODE_MODE=false`                                             | N/A                                                                       |
| OpenCode 2 beta | Disabled for `bash`; direct MCP uses `codemode=false`             | For suite `tool-search`, MCP uses `codemode=true` and exposes only `execute`    | Enabled only as part of integrated suite tool search; otherwise `execute` is denied | Only the local Executor MCP server is exposed; native `execute` is denied |

## Development

Use Node.js 24 and install the locked dependencies with `npm ci`. Run all checks before a change is complete:

```sh
npm run check
```

`npm run check` runs type checks, oxlint, oxfmt, and the production build.
