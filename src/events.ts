import { parse } from "shell-quote";
import { z } from "zod";
import { redact } from "./credentials.js";
import type { Config } from "./config.js";
import type { Result, Trial } from "./types.js";

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

  constructor(
    private readonly config: Config,
    private readonly trial: Trial,
    private readonly names: string[],
    private readonly token: string,
    private readonly readOnlyNames: string[] = names,
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
      this.answer += redact(part.text, [this.token]);
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
    else if (this.trial.technique === "bash")
      this.invalidRoute ||=
        name !== "bash" ||
        command === undefined ||
        !approvedCommand(command, this.config.repository);
    else {
      this.invalidRoute ||= !this.names.includes(name) || !this.readOnlyNames.includes(name);
      if (!this.readOnlyNames.includes(name))
        this.warnings.push(
          "MCP call was not identified as read-only; the catalog includes definitions that are not approved read operations.",
        );
    }
  }

  get routeValid(): boolean {
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
