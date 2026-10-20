import { fork, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, getAgentDir, type AgentSession, type AgentSessionEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { forkSnapshot } from "./snapshot.js";

export function captureChild(pi: ExtensionAPI, ctx: ExtensionContext, partial?: unknown) {
  const snapshot = forkSnapshot(ctx.sessionManager, ctx.cwd, partial);
  return {
    ...snapshot, agentDir: getAgentDir(), cwd: ctx.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
    scopedModels: structuredClone([...ctx.scopedModels]),
    settings: structuredClone(pi.getSettings()), tools: [...pi.getActiveTools()],
    extensionPaths: [...new Set([...pi.getAllTools(), ...pi.getCommands().filter(command => command.source === "extension")].map(item => item.sourceInfo.path).filter(isAbsolute))],
    systemPrompt: ctx.getSystemPrompt(), trusted: ctx.isProjectTrusted(),
  };
}
export type Capture = ReturnType<typeof captureChild>;
export type WorkerConfig = Omit<Capture, "manager" | "origin" | "boundary" | "pendingCount"> & { file: string };

/** The process owns the SDK session, providers and extension module globals. */
export class ChildSession {
  messages: AgentSession["messages"] = [];
  partial: AgentSession["messages"][number] | undefined;
  error = "";
  get closed() { return this.dead; }
  private observers = new Set<() => void>();
  observe(listener: () => void) { this.observers.add(listener); return () => { this.observers.delete(listener); }; }
  private changed() { for (const listener of this.observers) listener(); }
  private remoteStreaming = false;
  private activePrompts = 0;
  get isStreaming() { return !this.dead && (this.remoteStreaming || this.activePrompts > 0); }
  private serial = 0;
  private dead = false;
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private process: ChildProcess;
  private errors = "";
  constructor(cwd: string) {
    this.process = fork(fileURLToPath(new URL("../dist/worker.js", import.meta.url)), [], {
      cwd, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
    });
    this.process.stderr?.on("data", chunk => { this.errors = (this.errors + chunk.toString()).slice(-8000); });
    this.process.on("message", (message: any) => {
      if (message.type === "response") {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) { this.error = message.error; pending?.reject(new Error(message.error)); }
        else pending?.resolve(message.value);
      } else {
        if (message.messages) this.messages = message.messages;
        if (typeof message.streaming === "boolean") this.remoteStreaming = message.streaming;
        if (message.type === "event") {
          if (message.event.type === "message_update") this.partial = message.event.message;
          if (message.event.type === "message_end") this.partial = undefined;
          for (const listener of this.listeners) listener(message.event);
        }
        if (message.type === "error") this.error = this.errors = String(message.error);
      }
      this.changed();
    });
    this.process.on("error", error => this.fail(error));
    this.process.on("exit", (code, signal) => this.fail(new Error(`BTW process exited (${code ?? signal}): ${this.errors}`)));
  }
  private fail(error: Error) {
    this.dead = true; this.remoteStreaming = false;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear(); this.error = error.message; this.changed();
  }
  request(method: string, data: Record<string, unknown> = {}): Promise<any> {
    if (this.dead) return Promise.reject(new Error("BTW process is closed"));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.send({ id, method, ...data }, error => {
        if (error) { this.pending.delete(id); reject(error); }
      });
    });
  }
  async prompt(text: string, _options?: unknown) {
    this.error = ""; this.activePrompts++; this.changed();
    try { await this.request("prompt", { text }); }
    finally { this.activePrompts--; this.changed(); }
  }
  async snapshot(): Promise<Capture> {
    const { file, ...capture } = await this.request("snapshot");
    return { ...capture, manager: SessionManager.open(file) };
  }
  merge(message: unknown) { return this.request("merge", { message }); }
  abort() { return this.request("abort"); }
  subscribe(listener: (event: AgentSessionEvent) => void) {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  dispose() {
    if (this.dead) return;
    void this.request("dispose").catch(() => {});
    // Extensions may keep sockets/timers alive. Bound shutdown without touching the parent.
    const timer = setTimeout(() => this.process.kill("SIGKILL"), 2000); timer.unref();
    this.process.once("exit", () => clearTimeout(timer));
    this.fail(new Error("BTW closed")); this.listeners.clear(); this.observers.clear();
  }
}

export async function startChild(capture: Capture) {
  const session = new ChildSession(capture.cwd);
  const { manager, origin: _origin, boundary: _boundary, pendingCount: _pending, ...config } = capture;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.request("init", { config: { ...config, file: manager.getSessionFile()! } }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("BTW startup timed out")), 60_000);
        timeout.unref();
      }),
    ]);
    return { ...capture, session };
  } catch (error) { session.dispose(); throw error; }
  finally { clearTimeout(timeout); }
}
export type Child = Awaited<ReturnType<typeof startChild>>;
