import { fork, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, getAgentDir, type AgentSession, type AgentSessionEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { forkSnapshot } from "./snapshot.js";
import { primePreview } from "./preview.js";

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
  startupTimings: Record<string,number> = {};
  preview?: string[];
  get starting() { return !!this.waking || this.dormant; }
  get closed() { return this.dead; }
  private footerRevision = 0;
  private footerKey = "";
  private footerLines: string[] = [];
  private footerPending = false;
  footer(width: number, theme?: string): string[] {
    const key = `${width}:${theme}:${this.footerRevision}`;
    if (!this.dead && !this.starting && !this.footerPending && key !== this.footerKey) {
      this.footerPending = true; this.footerKey = key;
      void this.request("footer",{width,theme}).then(lines => { this.footerLines = lines; })
        .catch(error => { this.error = String(error); })
        .finally(() => { this.footerPending = false; this.changed(); });
    }
    return this.footerLines;
  }
  private observers = new Set<() => void>();
  observe(listener: () => void) { this.observers.add(listener); return () => { this.observers.delete(listener); }; }
  private changed() { for (const listener of this.observers) listener(); }
  private remoteStreaming = false;
  private activePrompts = 0;
  private abortEpoch = 0;
  get isStreaming() { return !this.dead && (this.remoteStreaming || this.activePrompts > 0); }
  private serial = 0;
  private dead = false;
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private process!: ChildProcess;
  private errors = "";
  private resumeConfig?: WorkerConfig;
  private waking?: Promise<void>;
  get dormant() { return !!this.resumeConfig; }
  constructor(private cwd: string, resumeConfig?: WorkerConfig) {
    this.resumeConfig = resumeConfig;
    if (!resumeConfig) this.launch();
  }
  private launch() {
    this.process = fork(fileURLToPath(new URL("../dist/worker.js", import.meta.url)), [], {
      cwd: this.cwd, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
    });
    this.process.stderr?.on("data", chunk => { this.errors = (this.errors + chunk.toString()).slice(-8000); });
    this.process.on("message", (message: any) => {
      if (message.type === "response") {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) { this.error = message.error; pending?.reject(new Error(message.error)); }
        else pending?.resolve(message.value);
      } else {
        if (message.messages || message.type === "footer_dirty" || message.event?.type === "model_select") this.footerRevision++;
        if (message.messages) this.messages = message.messages;
        if (message.preview) this.preview = message.preview;
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
  async ensureStarted() {
    if (this.dead) throw new Error("BTW process is closed");
    if (this.waking) return this.waking;
    if (!this.resumeConfig) return;
    const config = this.resumeConfig;
    this.resumeConfig = undefined;
    this.launch();
    this.waking = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const started = performance.now();
        this.startupTimings = await Promise.race([this.request("init", {config}),new Promise<never>((_resolve,reject) => {
          timer = setTimeout(() => reject(new Error("BTW startup timed out")),60_000); timer.unref();
        })]);
        this.startupTimings.total = performance.now() - started;
      } catch (error) { this.dispose(); throw error; }
      finally { clearTimeout(timer); this.waking = undefined; this.changed(); }
    })();
    return this.waking;
  }
  async prompt(text: string, _options?: unknown) {
    const epoch = this.abortEpoch;
    this.error = ""; this.activePrompts++; this.changed();
    try {
      await this.ensureStarted();
      if (epoch !== this.abortEpoch) throw new Error("BTW prompt cancelled during startup");
      await this.request("prompt", { text });
    }
    finally { this.activePrompts--; this.changed(); }
  }
  async snapshot(): Promise<Capture> {
    await this.ensureStarted();
    const { file, ...capture } = await this.request("snapshot");
    return { ...capture, manager: SessionManager.open(file) };
  }
  async merge(message: unknown) { await this.ensureStarted(); return this.request("merge", { message }); }
  abort() { this.abortEpoch++; return this.starting ? Promise.resolve() : this.request("abort"); }
  subscribe(listener: (event: AgentSessionEvent) => void) {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  dispose() {
    if (this.dead) return;
    if (!this.process) { this.fail(new Error("BTW closed")); this.resumeConfig = undefined; this.observers.clear(); return; }
    void this.request("dispose").catch(() => {});
    // Extensions may keep sockets/timers alive. Bound shutdown without touching the parent.
    const timer = setTimeout(() => this.process.kill("SIGKILL"), 2000); timer.unref();
    this.process.once("exit", () => clearTimeout(timer));
    this.fail(new Error("BTW closed")); this.listeners.clear(); this.observers.clear();
  }
}

export function prepareChild(capture: Capture) {
  const { manager, origin: _origin, boundary: _boundary, pendingCount: _pending, ...config } = capture;
  const session = new ChildSession(capture.cwd,{...config,file:manager.getSessionFile()!});
  session.messages = manager.buildSessionContext().messages;
  const child = { ...capture, session };
  primePreview(child);
  return child;
}
export async function startChild(capture: Capture) {
  const child = prepareChild(capture);
  await child.session.ensureStarted();
  return child;
}
export type Child = Awaited<ReturnType<typeof startChild>>;
