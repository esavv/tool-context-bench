import type { Metrics } from "./types.js";
import type { EventCollector } from "./events.js";

export interface AgentUsage {
  metrics: Metrics;
  requests: unknown[];
  warnings: string[];
  models: string[];
  artifactPath?: string;
}

export interface PreparedAgent {
  directory: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: string[];
  promptArgument?: boolean;
  collectWithoutSession?: boolean;
  configPath: string;
  dataPath: string;
  dataKind: "sqlite" | "jsonl";
  settings: string[];
  events: EventCollector;
  onLine: (line: string) => void;
  collect: () => Promise<AgentUsage>;
  cleanup: () => Promise<void>;
}
