import {
  createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, SettingsManager, SessionManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { WorkerConfig } from "./child.js";

let session: AgentSession | undefined;
function send(value: unknown) { if (process.connected) process.send?.(value); }
process.on("disconnect", () => { session?.dispose(); process.exit(0); });
process.on("message", async (request: { id: number; method: string; config?: WorkerConfig; text?: string }) => {
  try {
    if (request.method === "init") {
      if (session) throw new Error("Already initialized");
      const c = request.config!;
      const settingsManager = SettingsManager.inMemory(c.settings);
      const resourceLoader = new DefaultResourceLoader({
        cwd: c.cwd, agentDir: c.agentDir, settingsManager,
        additionalExtensionPaths: c.extensionPaths,
        extensionFactories: [
          pi => { pi.on("before_agent_start", () => ({ systemPrompt: c.systemPrompt })); },
          { name: "codemode", builtin: true, factory: createCodemodeExtension({ mode: "on" }) },
          { name: "tool_search", builtin: true, factory: createToolSearchExtension() },
          { name: "mcp", builtin: true, factory: createMcpExtension() },
        ],
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => c.trusted });
      const errors = resourceLoader.getExtensions().errors;
      if (errors.length) throw new Error(`BTW extension loading failed: ${JSON.stringify(errors)}`);
      ({ session } = await createAgentSession({
        cwd: c.cwd, agentDir: c.agentDir, model: c.model, thinkingLevel: c.thinkingLevel,
        scopedModels: c.scopedModels, sessionManager: SessionManager.open(c.file),
        settingsManager, resourceLoader,
      }));
      await session.bindExtensions({ mode: "print", onError: error => send({ type: "error", error: String(error) }) });
      const available = new Set(session.getAllTools().map(tool => tool.name));
      const missing = c.tools.filter(name => !available.has(name));
      if (missing.length) throw new Error(`Cannot inherit active tools: ${missing.join(", ")}`);
      session.setActiveToolsByName(c.tools);
      session.subscribe(event => {
        send({ type: "event", event, streaming: session!.isStreaming,
          ...(event.type === "message_end" || event.type === "agent_settled" ? { messages: session!.messages } : {}) });
      });
      send({ type: "state", messages: session.messages, streaming: false });
    } else if (request.method === "prompt") {
      if (!session) throw new Error("Not initialized");
      await session.prompt(request.text!, { streamingBehavior: "followUp" });
    } else if (request.method === "abort") {
      await session?.abort();
    } else if (request.method === "dispose") {
      session?.dispose(); process.disconnect(); return;
    } else throw new Error(`Unknown method ${request.method}`);
    send({ type: "response", id: request.id });
  } catch (error) { send({ type: "response", id: request.id, error: String(error) }); }
});
