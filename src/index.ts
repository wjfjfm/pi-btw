import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureChild, startChild } from "./child.js";
import { rawConversation } from "./snapshot.js";
import { BtwView, type ViewAction } from "./view.js";
import { mergeContent } from "./merge.js";
import { Workspace, type Tab } from "./workspace.js";

export default function btw(pi: ExtensionAPI) {
  const workspace = new Workspace();
  let partial: unknown;
  let generation = 0;
  let parentId: string | undefined;
  let creating = false;
  let merging = false;
  let showing = false;
  let view: BtwView | undefined;
  let finish: ((action: ViewAction) => void) | undefined;
  let summaryAbort: AbortController | undefined;
  let menu: "merge" | "close" | undefined;
  const error = (ctx: ExtensionContext, e: unknown) => ctx.ui.notify(String(e),"error");
  function reset() {
    generation++; summaryAbort?.abort(); finish?.({kind:"main"}); workspace.dispose(); partial = undefined;
  }
  pi.on("session_start", (_event,ctx) => {
    const id = ctx.sessionManager.getSessionId();
    if (parentId && parentId !== id) reset();
    parentId = id;
  });
  pi.on("message_update", event => { partial = event.message; });
  pi.on("message_end", () => { partial = undefined; });
  pi.on("session_shutdown", () => { reset(); parentId = undefined; });

  async function create(ctx: ExtensionContext, prompt?: string) {
    if (creating) throw new Error("BTW is being created");
    creating = true;
    const version = generation, source = workspace.current;
    try {
      const capture = source ? await workspace.tabs.get(source)!.child.session.snapshot() : captureChild(pi,ctx,partial);
      const child = await startChild(capture);
      if (version !== generation) { child.session.dispose(); return; }
      const tab = workspace.add(child,source);
      ctx.ui.notify(`BTW ${tab.id} forked from ${source || "main"}: ${child.manager.getSessionFile()}`,"info");
      if (prompt) void child.session.prompt(prompt).catch(e => error(ctx,e));
    } finally { creating = false; }
  }
  function selected() {
    const tab = workspace.tabs.get(workspace.current);
    if (!tab) throw new Error("Select a BTW first using Ctrl+B/F or /btw list");
    return tab;
  }
  async function merge(tab: Tab, target: "source" | "main", mode: string, ctx: ExtensionContext) {
    if (merging || tab.child.session.isStreaming) throw new Error("Wait until BTW is idle before merging");
    if (tab.child.session.closed) throw new Error("BTW process is closed");
    const destination = workspace.destination(tab,target);
    const manager = SessionManager.open(tab.child.manager.getSessionFile()!);
    const leaf = manager.getLeafId();
    if (tab.merged.has(destination) && tab.merged.get(destination) === leaf) throw new Error("This BTW revision has already been merged to this target");
    merging = true;
    const version = generation;
    try {
      summaryAbort = new AbortController();
      const content = await mergeContent(rawConversation(manager,tab.child.boundary),mode,ctx,summaryAbort.signal);
      if (version !== generation || ctx.sessionManager.getSessionId() !== parentId) throw new Error("Main session changed; merge cancelled");
      workspace.destination(tab,target);
      const message = {customType:"pi-btw-merge",display:true,
        content:`BTW ${mode === "full" ? "full transcript (raw JSONL)" : "summary"} — explicit user merge\nSession: ${manager.getSessionFile()}\n\n${content}`,
        details:{sessionId:manager.getSessionId(),mode,leaf}};
      if (destination === 0) pi.sendMessage(message,{triggerTurn:true,deliverAs:"followUp"});
      else await workspace.tabs.get(destination)!.child.session.merge(message);
      tab.merged.set(destination,leaf);
      tab.notice = `BTW ${tab.id} merged to ${destination || "main"}`;
      ctx.ui.notify(tab.notice,"info");
    } finally { merging = false; summaryAbort = undefined; }
  }
  async function command(args: string, ctx: ExtensionContext) {
    const [verb,...rest] = args.trim().split(/\s+/);
    if (verb === "list") {
      const choices = ["main", ...[...workspace.tabs.values()].map(tab =>
        `BTW ${tab.id} · source ${tab.source || "main"} · ${tab.child.session.closed ? "closed" : tab.child.session.isStreaming ? "running" : "idle"}`)];
      const ids = [0, ...workspace.tabs.keys()];
      const choice = await ctx.ui.select("BTW sessions", choices);
      if (choice !== undefined) {
        const index = choices.indexOf(choice);
        if (index >= 0) workspace.current = ids[index];
      }
      return;
    }
    if (verb === "next" || verb === "prev") { workspace.move(verb === "next" ? 1 : -1); return; }
    if (verb === "close") { if (merging || creating) throw new Error("BTW operation in progress"); selected(); menu = "close"; return; }
    if (verb === "merge") {
      const tab = selected();
      if (!rest.length) { menu = "merge"; return; }
      const [target,mode] = rest.length === 1 ? ["source",rest[0]] : rest;
      if (rest.length > 2 || (target !== "source" && target !== "main") || !["full","summary"].includes(mode))
        throw new Error("Use /btw merge [source|main] full|summary");
      await merge(tab,target,mode,ctx); return;
    }
    if (verb === "new") { await create(ctx,rest.join(" ") || undefined); return; }
    await create(ctx,args.trim() || undefined);
  }
  async function perform(action: ViewAction,ctx: ExtensionContext) {
    if (action.kind === "main") workspace.current = 0;
    else if (action.kind === "next" || action.kind === "prev") workspace.move(action.kind === "next" ? 1 : -1);
    else if (action.kind === "new") await create(ctx);
    else if (action.kind === "close") {
      if (merging || creating) throw new Error("BTW operation in progress");
      workspace.close(selected().id);
    } else if (action.kind === "merge") menu = "merge";
    else await command(action.text || "",ctx);
  }
  async function show(ctx: ExtensionContext) {
    if (showing) return;
    showing = true;
    const version = generation;
    try {
      while (workspace.current && version === generation) {
        const tab = selected();
        const action = await ctx.ui.custom<ViewAction>((tui,theme,_keys,done) => {
          finish = done;
          view = new BtwView(tui,theme,tab,done,async text => {
            if (merging) throw new Error("Summary/merge in progress");
            await tab.child.session.prompt(text);
          });
          if (menu === "merge") view.showMerge();
          if (menu === "close") view.showClose();
          menu = undefined;
          return view;
        },{overlay:true,overlayOptions:{width:"100%",maxHeight:"100%",anchor:"top-left",margin:0}});
        finish = undefined; view = undefined;
        if (!action || version !== generation) break;
        try { await perform(action,ctx); } catch (e) {
          const current = workspace.tabs.get(workspace.current);
          if (current) current.notice = String(e);
          error(ctx,e);
        }
      }
    } finally { showing = false; finish = undefined; view = undefined; }
  }
  async function run(ctx: ExtensionContext,action: ViewAction) {
    try {
      if (ctx.mode !== "tui") throw new Error("BTW requires interactive TUI mode");
      if (creating || merging) throw new Error("BTW operation in progress");
      if (showing) { finish?.(action); return; }
      await perform(action,ctx); await show(ctx);
    } catch (e) { error(ctx,e); }
  }
  pi.registerCommand("btw",{description:"Fork BTW | list | next | prev | merge [source|main] full|summary | close",
    handler:async (args,ctx) => { await run(ctx,{kind:"command",text:args}); }});
  for (const [key,kind] of [["ctrl+b","prev"],["ctrl+f","next"]] as const)
    pi.registerShortcut(key,{description:`BTW ${kind}`,handler:async ctx => { await run(ctx,{kind}); }});
}
