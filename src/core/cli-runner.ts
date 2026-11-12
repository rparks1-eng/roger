import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CODEX_STUDY_LIMITS, CODEX_STUDY_SCHEMA, codexStudyArgs, createStudyEventReader } from "./cli-protocol.ts";

export async function installedCodex(): Promise<string | null> {
  for (const candidate of [path.join(homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next fixed host path. */ }
  }
  return null;
}

// The browser cannot supply an executable, command arguments, environment,
// model, directory or schema. This adapter has no Canvas write contract.
export async function runCodexStudy(prompt: string, signal: AbortSignal, dependencies: {
  spawnProcess?: typeof spawn;
  findExecutable?: () => Promise<string | null>;
  terminate?: (child: ChildProcessWithoutNullStreams, force: boolean) => void;
} = {}): Promise<unknown> {
  if (process.env.ATLAS_STUDY_DISABLED === "1" || process.env.ATLAS_STUDY_CODEX_ENABLED !== "1") throw new Error("unavailable");
  if (signal.aborted) throw new Error("timeout");
  if (Buffer.byteLength(prompt) > CODEX_STUDY_LIMITS.inputBytes) throw new Error("oversized");
  const executable = await (dependencies.findExecutable ?? installedCodex)();
  if (!executable) throw new Error("unavailable");
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-study-cli-"));
  try {
    const schema = path.join(directory, "reply.schema.json");
    await writeFile(schema, JSON.stringify(CODEX_STUDY_SCHEMA), { mode: 0o600 });
    if (signal.aborted) throw new Error("timeout");
    const child = (dependencies.spawnProcess ?? spawn)(executable, codexStudyArgs(schema), {
      cwd: directory, detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: homedir(), PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", LANG: "en_US.UTF-8", RUST_LOG: "error" },
    }) as ChildProcessWithoutNullStreams;
    return await new Promise<unknown>((resolve, reject) => {
      const events = createStudyEventReader(), decoder = new StringDecoder("utf8");
      let failure = "", closed = false, stopping = false, stderrBytes = 0;
      let rejectedItemType: string | undefined;
      let providerFailure: string | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const terminate = (force: boolean) => {
        if (closed) return;
        if (dependencies.terminate) { dependencies.terminate(child, force); return; }
        try { if (child.pid) process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
        catch { child.kill(force ? "SIGKILL" : "SIGTERM"); }
      };
      const stop = (reason: string) => {
        if (!failure) failure = reason;
        if (closed || stopping) return;
        stopping = true;
        killTimer = setTimeout(() => terminate(true), CODEX_STUDY_LIMITS.killAfterMs); killTimer.unref();
        terminate(false);
      };
      const abort = () => stop("timeout");
      const timer = setTimeout(abort, CODEX_STUDY_LIMITS.timeoutMs); timer.unref();
      signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => { closed = true; clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener("abort", abort); };
      child.on("error", () => { cleanup(); reject(new Error("unavailable")); });
      child.stdin.on("error", () => stop("unavailable"));
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        try { events.push(decoder.write(chunk)); } catch (error) {
          if (error && typeof error === "object" && "rejectedItemType" in error) rejectedItemType = String(error.rejectedItemType);
          if (error && typeof error === "object" && "providerFailure" in error) providerFailure = String(error.providerFailure);
          stop(error instanceof Error ? error.message : "output");
        }
      });
      // Drain stderr without logging account paths, credentials or source text.
      child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > CODEX_STUDY_LIMITS.outputBytes) stop("oversized"); });
      child.on("close", code => {
        cleanup();
        if (failure || code !== 0) { reject(Object.assign(new Error(failure || "unavailable"), { rejectedItemType, providerFailure })); return; }
        try { events.push(decoder.end()); resolve(events.finish()); } catch { reject(new Error("output")); }
      });
      if (signal.aborted) abort();
      if (!failure) child.stdin.end(prompt); else child.stdin.end();
    });
  } finally {
    // Only this adapter's unique, resolved scratch directory is removed.
    await rm(directory, { recursive: true, force: true });
  }
}
