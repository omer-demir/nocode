import { spawn } from "node:child_process";

export interface ProcessRunOptions {
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export interface ProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult>;
}

export class SpawnProcessRunner implements ProcessRunner {
  async run(
    executable: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    const startedAt = performance.now();

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let truncated = false;
      let timedOut = false;

      const capture = (target: Buffer[], chunk: Buffer): void => {
        const remaining = options.maxOutputBytes - outputBytes;
        if (remaining <= 0) {
          truncated = true;
          return;
        }

        const captured = chunk.subarray(0, remaining);
        target.push(captured);
        outputBytes += captured.length;
        truncated ||= captured.length < chunk.length;
      };

      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.once("error", reject);

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);

      child.once("close", (code) => {
        clearTimeout(timeout);
        const timeoutMessage = timedOut
          ? `Command exceeded ${options.timeoutMs}ms timeout\n`
          : "";
        resolve({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: `${Buffer.concat(stderr).toString("utf8")}${timeoutMessage}`,
          durationMs: performance.now() - startedAt,
          truncated,
        });
      });

      if (options.stdin === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(options.stdin);
      }
    });
  }
}