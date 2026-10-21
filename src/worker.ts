import {
  createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, SettingsManager, SessionManager, type AgentSession, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { captureChild, type WorkerConfig } from "./child.js";
import { configureNetwork } from "./network.js";
import { sealPendingCalls, ORIGIN, BRANCH_CONTEXT, BRANCH_INSTRUCTIONS } from "./snapshot.js";
import { createFooter } from "./footer.js";

let session: AgentSession | undefined;
let api: ExtensionAPI;
let context: ExtensionContext;
let partial: unknown;
let config: WorkerConfig;
let footer: Awaited<ReturnType<typeof createFooter>> | undefined;
function send(value: unknown) { if (process.connected) process.send?.(value); }
process.on("disconnect", () => { footer?.dispose(); session?.dispose(); process.exit(0); });
process.on("message", async (request: { id: number; method: string; config?: WorkerConfig; text?: string; width?: number; theme?: string; message?: Parameters<AgentSession["sendCustomMessage"]>[0] }) => {
  try {
    if (request.method === "init") {
      if (session) throw new Error("Already initialized");
      const c = config = request.config!;
      await configureNetwork(c.settings);
      const settingsManager = SettingsManager.inMemory(c.settings);
      const resourceLoader = new DefaultResourceLoader({
        cwd: c.cwd, agentDir: c.agentDir, settingsManager,
        additionalExtensionPaths: c.extensionPaths,
        extensionFactories: [
          pi => {
            api = pi;
            pi.on("session_start", (_event, ctx) => { context = ctx; });
            pi.on("before_agent_start", (event,ctx) => {
              const branch = ctx.sessionManager.getBranch();
              const boundary = branch.map(entry => entry.type === "custom" && entry.customType === ORIGIN).lastIndexOf(true);
              const introduced = branch.slice(boundary + 1).some(entry => entry.type === "custom_message" && entry.customType === BRANCH_CONTEXT);
              return { systemPrompt: c.systemPrompt,
                ...(event.messageType === "user" && boundary >= 0 && !introduced ? {
                  message: {customType:BRANCH_CONTEXT,content:BRANCH_INSTRUCTIONS,display:true},
                } : {}),
              };
            });
          },
          { name: "codemode", builtin: true, factory: createCodemodeExtension({ mode: "on" }) },
          { name: "tool_search", builtin: true, factory: createToolSearchExtension() },
          { name: "mcp", builtin: true, factory: createMcpExtension() },
        ],
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => c.trusted });
      const errors = resourceLoader.getExtensions().errors;
      if (errors.length) throw new Error(`BTW extension loading failed: ${JSON.stringify(errors)}`);
      const sessionManager = SessionManager.open(c.file);
      sealPendingCalls(sessionManager,"BTW restored after interruption: no finalized result was saved for this call. Its side effects are unknown. It has NOT been replayed; inspect state before retrying.");
      ({ session } = await createAgentSession({
        cwd: c.cwd, agentDir: c.agentDir, model: c.model, thinkingLevel: c.thinkingLevel,
        scopedModels: c.scopedModels, sessionManager,
        settingsManager, resourceLoader,
      }));
      footer = await createFooter(session,c.cwd,c.settings.theme,() => send({type:"footer_dirty"}));
      const ui = session.extensionRunner.createContext().ui;
      await session.bindExtensions({ mode: "print", uiContext: {...ui,setStatus:(key,text) => footer!.setStatus(key,text)},
        onError: error => send({ type: "error", error: String(error) }) });
      const available = new Set(session.getAllTools().map(tool => tool.name));
      const missing = c.tools.filter(name => !available.has(name));
      if (missing.length) throw new Error(`Cannot inherit active tools: ${missing.join(", ")}`);
      session.setActiveToolsByName(c.tools);
      session.subscribe(event => {
        if (event.type === "message_update") partial = event.message;
        if (event.type === "message_end") partial = undefined;
        send({ type: "event", event, streaming: session!.isStreaming,
          ...(event.type === "message_end" || event.type === "agent_settled" ? { messages: session!.messages } : {}) });
      });
      send({ type: "state", messages: session.messages, streaming: false });
    } else if (request.method === "prompt") {
      if (!session) throw new Error("Not initialized");
      await session.prompt(request.text!, { streamingBehavior: "followUp" });
    } else if (request.method === "footer") {
      if (!footer) throw new Error("Not initialized");
      send({type:"response",id:request.id,value:footer.render(request.width ?? 80,request.theme)});
      return;
    } else if (request.method === "snapshot") {
      if (!session || !context) throw new Error("Not initialized");
      const { manager, ...capture } = captureChild(api, context, partial);
      capture.agentDir = config.agentDir;
      capture.extensionPaths = [...new Set([...config.extensionPaths, ...capture.extensionPaths])];
      send({ type: "response", id: request.id, value: { ...capture, file: manager.getSessionFile() } });
      return;
    } else if (request.method === "merge") {
      if (!session || !request.message) throw new Error("Not initialized");
      await session.sendCustomMessage(request.message, { triggerTurn: true, deliverAs: "steer" });
    } else if (request.method === "abort") {
      await session?.abort();
    } else if (request.method === "dispose") {
      session?.dispose(); process.disconnect(); return;
    } else throw new Error(`Unknown method ${request.method}`);
    send({ type: "response", id: request.id });
  } catch (error) { send({ type: "response", id: request.id, error: String(error) }); }
});
