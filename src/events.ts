import { z } from "zod";
import { redact } from "./credentials.js";
import type { Result, Trial } from "./types.js";

const object = z.record(z.string(), z.unknown());
const eventSchema = z.object({
  type: z.string(),
  sessionID: z.string().optional(),
  timestamp: z.number().optional(),
  part: object.optional(),
});

function serviceClis(command: string): string[] {
  const names = new Set<string>();
  for (const segment of command.split(/\n|&&|\|\||[;|]/)) {
    const words = segment.trim().split(/\s+/);
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
    const executable = words[0]?.split("/").at(-1);
    if (executable && ["gh", "supabase", "wrangler", "stripe"].includes(executable))
      names.add(executable);
  }
  return [...names];
}

export class EventCollector {
  sessionID: string | null = null;
  answer = "";
  tools: Result["tools"] = [];
  warnings: string[] = [];
  error = false;
  malformed = false;
  codeMode = false;
  readonly safeEvents: unknown[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly trial: Trial,
    private readonly token: string,
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
    if (this.trial.technique !== "bash" && name === "bash" && command !== undefined) {
      const clis = serviceClis(command);
      if (clis.length)
        this.warnings.push(`Bash invoked service CLI(s) during an MCP trial: ${clis.join(", ")}.`);
    }
  }
}
