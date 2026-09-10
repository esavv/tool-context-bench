import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stopped: boolean;
}

export function minimalEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    SHELL: "/bin/bash",
  };
}

export function execute(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onLine?: (line: string) => void;
    maxBytes?: number;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? minimalEnvironment(),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let buffered = "";
    let bytes = 0;
    let stopped = false;
    let forced: NodeJS.Timeout | undefined;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* Process may have already exited. */
      }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      kill("SIGINT");
      forced = setTimeout(() => kill("SIGKILL"), 3000);
    };
    const timeout = setTimeout(stop, options.timeoutMs ?? 30_000);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 8_000_000)) {
        stop();
        return;
      }
      const text = stdoutDecoder.write(chunk);
      stdout += text;
      buffered += text;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          options.onLine?.(line);
        } catch {
          stop();
        }
        newline = buffered.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 8_000_000)) {
        stop();
        return;
      }
      stderr += stderrDecoder.write(chunk);
    });
    child.stdin.on("error", () => {
      /* Early process exit can close stdin. */
    });
    child.stdin.end(options.input ?? "");
    const cleanup = () => {
      clearTimeout(timeout);
      if (forced) clearTimeout(forced);
      options.signal?.removeEventListener("abort", stop);
    };
    child.once("error", () => {
      cleanup();
      reject(new Error(`Cannot start ${command.split("/").at(-1)}.`));
    });
    child.once("close", (code) => {
      const remainder = stdoutDecoder.end();
      stdout += remainder;
      buffered += remainder;
      stderr += stderrDecoder.end();
      if (buffered.trim()) {
        try {
          options.onLine?.(buffered);
        } catch {
          stopped = true;
        }
      }
      // A child can exit before its descendants; stop only our own process group.
      kill("SIGKILL");
      cleanup();
      resolve({ code, stdout, stderr, stopped });
    });
  });
}
