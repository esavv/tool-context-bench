import { parse } from "shell-quote";
import { z } from "zod";
import { redact } from "./credentials.js";
import type { Config } from "./config.js";
import type { Result, Trial } from "./types.js";
import type { Benchmark } from "./types.js";

const object = z.record(z.string(), z.unknown());
const eventSchema = z.object({
  type: z.string(),
  sessionID: z.string().optional(),
  timestamp: z.number().optional(),
  part: object.optional(),
});

export function approvedCommand(command: string, repository: string): boolean {
  if (command.length > 16_000 || command.includes("\n") || command.includes("`")) return false;
  try {
    let quote = "";
    for (let i = 0; i < command.length; i++) {
      const char = command[i];
      if (char === "\\" && quote !== "'") {
        if (++i === command.length) return false;
        continue;
      }
      if (char === quote) quote = "";
      else if (!quote && (char === "'" || char === '"')) quote = char;
    }
    if (quote) return false;
    const words = parse(command, () => {
      throw new Error("Expansion is not permitted.");
    });
    const segments: string[][] = [[]];
    for (const word of words) {
      if (typeof word === "string") segments.at(-1)?.push(word);
      else if ("op" in word && word.op === "|") segments.push([]);
      else return false;
    }
    return segments.every((args, index) => {
      if (index > 0) {
        if (args[0] === "wc") return args.slice(1).every((arg) => /^-[cmlw]+$/.test(arg));
        if (args[0] !== "jq") return false;
        let filters = 0;
        for (let i = 1; i < args.length; i++) {
          const arg = args[i] ?? "";
          if (
            /^-[rcesMS]+$/.test(arg) ||
            [
              "--raw-output",
              "--compact-output",
              "--exit-status",
              "--slurp",
              "--sort-keys",
            ].includes(arg)
          )
            continue;
          if (arg === "--arg" || arg === "--argjson") {
            if (args[i + 1] === undefined || args[i + 2] === undefined) return false;
            i += 2;
            continue;
          }
          if (arg.startsWith("-") || ++filters > 1) return false;
        }
        return filters === 1;
      }
      if (args[0] === "echo") return segments.length === 2 && segments[1]?.[0] === "wc";
      if (args[0] !== "gh") return false;
      if (args[1] === "--help") return args.length === 2;
      if (args[1] === "help") return args.length === 3 && ["api", "repo"].includes(args[2] ?? "");
      const repoView = args[1] === "repo" && args[2] === "view";
      if (!repoView && args[1] !== "api") return false;
      if (args.length === 3 && args[2] === "--help") return true;
      const positional: string[] = [];
      for (let i = repoView ? 3 : 2; i < args.length; i++) {
        const arg = args[i] ?? "";
        if (["--jq", "-q", ...(repoView ? ["--json"] : [])].includes(arg)) {
          if (args[++i] === undefined) return false;
        } else if (!repoView && (arg === "-X" || arg === "--method")) {
          if (args[++i] !== "GET") return false;
        } else if (
          !repoView &&
          ["--method=GET", "-XGET", "--paginate", "--slurp", "--include", "-i"].includes(arg)
        ) {
          continue;
        } else if (arg.startsWith("-")) return false;
        else positional.push(arg);
      }
      const endpoint = positional[0];
      if (positional.length !== 1 || endpoint === undefined) return false;
      if (repoView) return endpoint === repository;
      return (
        endpoint.replace(/^\//, "").startsWith(`repos/${repository}/`) &&
        !endpoint.includes("..") &&
        !endpoint.includes("%")
      );
    });
  } catch {
    return false;
  }
}

function splitShellCommands(command: string): string[] | null {
  if (command.length > 16_000 || command.includes("`") || command.includes("$(")) return null;
  const commands: string[] = [];
  let start = 0;
  let quote = "";
  for (let index = 0; index < command.length; index++) {
    const character = command[index] ?? "";
    if (character === "\\" && quote !== "'") {
      if (++index === command.length) return null;
      continue;
    }
    if (character === quote) quote = "";
    else if (!quote && (character === "'" || character === '"')) quote = character;
    else if (!quote && (character === "\n" || character === ";")) {
      commands.push(command.slice(start, index));
      start = index + 1;
    } else if (
      !quote &&
      (command.slice(index, index + 2) === "&&" || command.slice(index, index + 2) === "||")
    ) {
      commands.push(command.slice(start, index));
      start = index + 2;
      index++;
    } else if (!quote && character === "&") return null;
  }
  if (quote) return null;
  commands.push(command.slice(start));
  const normalized = commands.map((part) => part.trim()).filter(Boolean);
  return normalized.length ? normalized : null;
}

function stripEnvironment(command: string): string {
  return command.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/, "");
}

function suiteServiceCommand(command: string, repository: string): string | null {
  if (approvedCommand(command, repository)) {
    const words = parse(command);
    return words[1] === "--help" || words[1] === "help" || words[2] === "--help" ? null : "gh";
  }
  if (command.includes("\n") || command.includes("`") || /[;&<>]/.test(command)) return null;
  try {
    const words = parse(command, () => {
      throw new Error("Expansion is not permitted.");
    });
    const segments: string[][] = [[]];
    for (const word of words) {
      if (typeof word === "string") segments.at(-1)?.push(word);
      else if ("op" in word && word.op === "|") segments.push([]);
      else return null;
    }
    const approved = segments.every((args, index) => {
      const executable = args[0]?.split("/").at(-1);
      if (index > 0) return executable === "jq" || executable === "wc";
      if (executable === "supabase")
        return (
          args[1] === "functions" &&
          args[2] === "list" &&
          args.slice(3).every((arg) => !/^(?:--debug|--create-ticket)$/.test(arg))
        );
      if (executable === "wrangler")
        return (
          args[1] === "d1" &&
          args[2] === "list" &&
          args.slice(3).every((arg) => ["--json"].includes(arg))
        );
      if (executable === "stripe")
        return (
          args[1] === "webhook_endpoints" &&
          !args.includes("--live") &&
          (args[2] === "list" ||
            (args[2] === "retrieve" &&
              args.length === 4 &&
              /^we_[A-Za-z0-9]+$/.test(args[3] ?? "")))
        );
      return false;
    });
    return approved ? (segments[0]?.[0]?.split("/").at(-1) ?? null) : null;
  } catch {
    return null;
  }
}

function safeLocalDiagnostic(command: string): boolean {
  try {
    const words = parse(command, () => {
      throw new Error("Expansion is not permitted.");
    });
    const segments: string[][] = [[]];
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      if (typeof word === "string") segments.at(-1)?.push(word);
      else if (word && "op" in word && word.op === "|") segments.push([]);
      else if (
        word &&
        "op" in word &&
        (word.op === ">" || word.op === ">>") &&
        words[index + 1] === "/dev/null"
      )
        index++;
      else return false;
    }
    const safe = new Set([
      "pwd",
      "printenv",
      "rg",
      "grep",
      "sed",
      "head",
      "tail",
      "ls",
      "stat",
      "test",
      "wc",
      "jq",
    ]);
    return segments.every((args, index) => {
      const executable = args[0]?.split("/").at(-1);
      if (executable === "command")
        return (
          args[1] === "-v" &&
          args.slice(2).every((name) => ["gh", "supabase", "wrangler", "stripe"].includes(name))
        );
      if (executable === "type" || executable === "which")
        return args
          .slice(1)
          .every((name) => ["gh", "supabase", "wrangler", "stripe"].includes(name));
      if (executable === "rg" && args.some((arg) => arg === "--pre" || arg.startsWith("--pre=")))
        return false;
      if (executable && safe.has(executable)) return true;
      return (
        index === 0 &&
        ["gh", "supabase", "wrangler", "stripe"].includes(executable ?? "") &&
        (args[1] === "--help" || args[1] === "help")
      );
    });
  } catch {
    return false;
  }
}

function suiteCommandServices(command: string, repository: string): string[] | null {
  const commands = splitShellCommands(command);
  if (!commands) return null;
  const services = new Set<string>();
  for (const part of commands) {
    const normalized = stripEnvironment(part);
    const service = suiteServiceCommand(normalized, repository);
    if (service) services.add(service);
    else if (!safeLocalDiagnostic(normalized)) return null;
  }
  return [...services];
}

export function approvedSuiteCommand(command: string, repository: string): boolean {
  return suiteCommandServices(command, repository) !== null;
}

export class EventCollector {
  sessionID: string | null = null;
  answer = "";
  tools: Result["tools"] = [];
  warnings: string[] = [];
  invalidRoute = false;
  error = false;
  malformed = false;
  codeMode = false;
  readonly safeEvents: unknown[] = [];
  private readonly seen = new Set<string>();
  private readonly suiteServices = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly trial: Trial,
    private readonly names: string[],
    private readonly token: string,
    private readonly readOnlyNames: string[] = names,
    private readonly benchmark: Benchmark = "github",
    private readonly extraSecrets: string[] = [],
  ) {}

  line(line: string): void {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.malformed = true;
      return;
    }
    const decoded = eventSchema.safeParse(raw);
    if (!decoded.success) {
      this.malformed = true;
      return;
    }
    const event = decoded.data;
    if (event.sessionID) {
      if (this.sessionID && this.sessionID !== event.sessionID) this.malformed = true;
      this.sessionID = event.sessionID;
    }
    const part = event.part;
    if (event.type === "error") {
      this.error = true;
      this.warnings.push("OpenCode reported an error; raw error content was not exported.");
    }
    if (!part) return;
    const id = typeof part.id === "string" ? part.id : undefined;
    if (id && this.seen.has(`${event.type}:${id}`)) return;
    if (id) this.seen.add(`${event.type}:${id}`);
    this.safeEvents.push({
      type: event.type,
      sessionID: event.sessionID,
      timestamp: event.timestamp,
      partID: id,
    });
    if (event.type === "text" && typeof part.text === "string")
      this.answer += redact(part.text, [this.token, ...this.extraSecrets]);
    if (event.type !== "tool_use" || typeof part.tool !== "string") return;
    const name = part.tool;
    const state = object.safeParse(part.state);
    const status =
      state.success && typeof state.data.status === "string" ? state.data.status : "unknown";
    const input = state.success ? object.safeParse(state.data.input) : undefined;
    const command =
      input?.success && typeof input.data.command === "string" ? input.data.command : undefined;
    this.tools.push({
      name: redact(name),
      status,
      ...(command === undefined ? {} : { command: redact(command, [this.token]) }),
    });
    if (/code.?mode|execute.?code|executor/.test(name)) this.codeMode = true;
    if (this.trial.workload !== "task") this.invalidRoute = true;
    else if (this.trial.technique === "bash") {
      if (name !== "bash" || command === undefined) this.invalidRoute = true;
      else if (this.benchmark === "suite") {
        const services = suiteCommandServices(command, this.config.repository);
        if (services === null) this.invalidRoute = true;
        else for (const service of services) this.suiteServices.add(service);
      } else this.invalidRoute ||= !approvedCommand(command, this.config.repository);
    } else if (
      this.trial.technique === "tool-search" &&
      /^(?:ToolSearch|tool_search)$/.test(name)
    ) {
      // Discovery is expected in this condition; service calls are checked below.
    } else if (this.trial.technique === "tool-search" && name === "execute") {
      this.codeMode = true;
    } else {
      this.invalidRoute ||= !this.names.includes(name) || !this.readOnlyNames.includes(name);
      if (!this.readOnlyNames.includes(name))
        this.warnings.push(
          "MCP call was not identified as read-only; the catalog includes definitions that are not approved read operations.",
        );
    }
  }

  get routeValid(): boolean {
    if (this.benchmark === "suite" && this.trial.workload === "task") {
      const completed = this.tools.filter((tool) => tool.status === "completed");
      if (this.trial.technique === "bash") {
        return (
          !this.invalidRoute &&
          !this.malformed &&
          ["gh", "supabase", "wrangler", "stripe"].every((name) => this.suiteServices.has(name))
        );
      }
      if (
        this.trial.technique === "tool-search" &&
        completed.some((tool) => tool.name === "execute")
      )
        return !this.invalidRoute && !this.malformed;
      return (
        !this.invalidRoute &&
        !this.malformed &&
        ["github_", "supabase_", "cloudflare_", "stripe_"].every((prefix) =>
          completed.some((tool) => tool.name.startsWith(prefix)),
        )
      );
    }
    return (
      !this.invalidRoute &&
      !this.malformed &&
      (this.trial.workload !== "task" ||
        this.tools.some((tool) => {
          if (tool.status !== "completed") return false;
          if (this.trial.technique !== "bash") return true;
          if (!tool.command) return false;
          try {
            const words = parse(tool.command);
            return (
              words[0] === "gh" &&
              ((words[1] === "api" && !words.includes("--help")) ||
                (words[1] === "repo" && words[2] === "view"))
            );
          } catch {
            return false;
          }
        }))
    );
  }
}
