import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureChild, startChild, type Child } from "./child.js";
import { rawConversation } from "./snapshot.js";
import { BtwView } from "./view.js";
import { mergeContent } from "./merge.js";

export default function btw(pi: ExtensionAPI) {
  let child: Child | undefined;
  let partial: unknown;
  let creating = false;
  let merging = false;
  let generation = 0;
  let draft = "";
  let closeView: (() => void) | undefined;
  let currentParent: string | undefined;
  let summaryAbort: AbortController | undefined;
  let lastMergedLeaf: string | null | undefined;

  pi.on("session_start", (_event, ctx) => { currentParent = ctx.sessionManager.getSessionId(); });
  pi.on("message_update", event => { partial = event.message; });
  pi.on("message_end", () => { partial = undefined; });
  pi.on("session_shutdown", () => {
    generation++; summaryAbort?.abort(); closeView?.(); child?.session.dispose();
    child = undefined; partial = undefined; currentParent = undefined;
  });

  const notifyError = (ctx: ExtensionContext, error: unknown) => ctx.ui.notify(String(error), "error");
  async function merge(mode: string, ctx: ExtensionContext) {
    const target = child;
    if (!target) throw new Error("No BTW session");
    if (mode !== "full" && mode !== "summary") throw new Error("Use /btw merge full|summary");
    if (merging || target.session.isStreaming) throw new Error("Wait until BTW is idle before merging");
    const manager = SessionManager.open(target.manager.getSessionFile()!);
    const leaf = manager.getLeafId();
    if (leaf === lastMergedLeaf) throw new Error("This BTW revision has already been merged");
    const raw = rawConversation(manager, target.boundary);
    if (!raw) throw new Error("No BTW conversation to merge");
    merging = true;
    const version = generation;
    try {
      summaryAbort = new AbortController();
      const content = await mergeContent(raw, mode, ctx, summaryAbort.signal);
      if (generation !== version || currentParent !== target.origin.parentId)
        throw new Error("Parent session changed; merge cancelled");
      pi.sendMessage({ customType: "pi-btw-merge", display: true,
        content: `BTW ${mode === "full" ? "full transcript (raw JSONL)" : "summary"} — explicit user merge\nSession: ${target.manager.getSessionFile()}\n\n${content}`,
        details: { sessionId: target.manager.getSessionId(), mode, leaf },
      }, { triggerTurn: true, deliverAs: "followUp" });
      lastMergedLeaf = leaf;
      ctx.ui.notify("BTW merged into parent", "info");
    } finally { merging = false; summaryAbort = undefined; }
  }

  async function open(ctx: ExtensionContext, fresh = false, prompt?: string) {
    if (ctx.mode !== "tui") throw new Error("BTW currently requires interactive TUI mode");
    if (closeView) { closeView(); return; }
    if (creating) throw new Error("BTW is being created");
    if (fresh && child) throw new Error("Use /btw close before creating another BTW");
    if (!child) {
      creating = true;
      const version = generation;
      try {
        const capture = captureChild(pi, ctx, partial);
        const created = await startChild(capture);
        if (version !== generation) { created.session.dispose(); return; }
        child = created; lastMergedLeaf = undefined;
        currentParent = capture.origin.parentId;
        ctx.ui.notify(`BTW forked: ${created.manager.getSessionFile()}${capture.pendingCount ? ` (${capture.pendingCount} unfinished parent calls not replayed)` : ""}`, "info");
      } finally { creating = false; }
    }
    const target = child;
    if (!target) return;
    if (prompt && merging) throw new Error("Summary/merge in progress");
    if (prompt) void target.session.prompt(prompt, { streamingBehavior: "followUp" }).catch(error => notifyError(ctx, error));
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      closeView = () => done();
      return new BtwView(tui, theme, target, draft, value => { draft = value; done(); }, async text => {
        if (text === "/main") { done(); return; }
        if (text.startsWith("/merge ")) { await merge(text.slice(7).trim(), ctx); done(); return; }
        if (merging) throw new Error("Summary/merge in progress");
        await target.session.prompt(text, { streamingBehavior: "followUp" });
      });
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });
    closeView = undefined;
  }

  pi.registerCommand("btw", {
    description: "Independent fork: /btw [question] | new | merge full|summary | close",
    handler: async (args, ctx) => {
      try {
        const command = args.trim();
        if (command === "close") {
          if (creating || merging) throw new Error("Wait for BTW creation/merge to finish");
          closeView?.(); child?.session.dispose(); child = undefined; draft = "";
          ctx.ui.notify("BTW closed (session file retained)", "info");
        } else if (command.startsWith("merge ")) await merge(command.slice(6).trim(), ctx);
        else await open(ctx, command === "new", command && command !== "new" ? command : undefined);
      } catch (error) { notifyError(ctx, error); }
    },
  });
  for (const key of ["ctrl+alt+b", "ctrl+alt+f"] as const) pi.registerShortcut(key, {
    description: "Toggle full-screen BTW / parent (create BTW if needed)",
    handler: async ctx => { try { await open(ctx); } catch (error) { notifyError(ctx, error); } },
  });
}
