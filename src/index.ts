import { randomUUID } from "node:crypto";
import { hasMergeReceipt, watchMergeReceipt } from "./merge-receipt.js";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureChild, startChild } from "./child.js";
import { rawConversation } from "./snapshot.js";
import { BtwView, type ViewAction } from "./view.js";
import { ListDialog, type ListAction } from "./list-dialog.js";
import { MERGE_MODES, mergeContent } from "./merge.js";
import { MergeDialog, mergeMode, type MergeOptions } from "./merge-dialog.js";
import { Workspace, type Tab } from "./workspace.js";
import { workspaceFile, saveWorkspace, restoreWorkspace } from "./persistence.js";

export default function btw(pi: ExtensionAPI) {
  const workspace = new Workspace();
  const pendingMerges = new Map<string,() => void>();
  let partial: unknown;
  let generation = 0;
  let parentId: string | undefined;
  let creating = false;
  let merging = false;
  let showing = false;
  let view: BtwView | undefined;
  let finish: ((action: ViewAction) => void) | undefined;
  let summaryAbort: AbortController | undefined;
  let manifest: string | undefined;
  let persistenceReady = true;
  let uiContext: ExtensionContext | undefined;
  function save() {
    if (!parentId || !persistenceReady || !workspace.serial) return;
    view?.saveDraft();
    try { saveWorkspace(manifest,parentId,workspace); }
    catch (e) { uiContext?.ui.notify(`BTW save failed: ${String(e)}`,"error"); }
  }
  const error = (ctx: ExtensionContext, e: unknown) => ctx.ui.notify(String(e),"error");
  function reset() {
    save();
    for (const cancel of pendingMerges.values()) cancel();
    pendingMerges.clear();
    generation++; summaryAbort?.abort(); finish?.({kind:"main"}); workspace.dispose(); partial = undefined;
  }
  pi.on("session_start", (_event,ctx) => {
    const id = ctx.sessionManager.getSessionId();
    if (parentId && parentId !== id) reset();
    parentId = id; uiContext = ctx;
    manifest = workspaceFile(ctx.sessionManager);
    persistenceReady = true;
    if (!workspace.tabs.size) {
      try { restoreWorkspace(manifest,id,workspace); }
      catch (e) { persistenceReady = false; error(ctx,e); }
    }
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
      save();
      ctx.ui.notify(`BTW ${tab.id} forked from ${source || "main"}: ${child.manager.getSessionFile()}`,"info");
      if (prompt) void child.session.prompt(prompt).catch(e => error(ctx,e));
    } finally { creating = false; }
  }
  function selected() {
    const tab = workspace.tabs.get(workspace.current);
    if (!tab) throw new Error("Select a BTW first using Ctrl+B/F or /btw list");
    return tab;
  }
  function requireDestination(id: number, source: number) {
    if (id === source) throw new Error("Cannot merge a BTW into itself");
    if (id && (!workspace.tabs.has(id) || workspace.tabs.get(id)!.child.session.closed))
      throw new Error("Target BTW is closed");
  }
  async function chooseMerge(tab: Tab, destination: number, ctx: ExtensionContext) {
    requireDestination(destination,tab.id);
    const version = generation;
    const targets = workspace.listRows(ctx.sessionManager,text => ctx.ui.theme?.fg("dim",text) ?? text)
      .filter(row => row.id !== tab.id && (!row.id || !workspace.tabs.get(row.id)!.child.session.closed));
    const options = await ctx.ui.custom<MergeOptions | undefined>((tui,theme,_keys,done) =>
      new MergeDialog(tui,theme,tab.id,targets,destination,done),
      {overlay:true,overlayOptions:{width:76,maxHeight:"100%"}});
    if (!options || version !== generation) return;
    await merge(tab,options,ctx);
  }
  async function merge(tab: Tab, options: MergeOptions, ctx: ExtensionContext) {
    const {destination} = options;
    const mode = mergeMode(options);
    const pendingKey = `${tab.id}:${destination}`;
    if (pendingMerges.has(pendingKey)) throw new Error("Merge queued; waiting for target receipt");
    if (workspace.tabs.get(tab.id) !== tab) throw new Error("Source BTW is closed");
    if (merging || tab.child.session.isStreaming) throw new Error("Wait until BTW is idle before merging");
    if (tab.child.session.closed) throw new Error("BTW process is closed");
    requireDestination(destination,tab.id);
    const manager = SessionManager.open(tab.child.manager.getSessionFile()!);
    const leaf = manager.getLeafId();
    if (tab.merged.has(destination) && tab.merged.get(destination) === leaf) throw new Error("This BTW revision has already been merged to this target");
    merging = true;
    const version = generation;
    try {
      summaryAbort = new AbortController();
      const content = await mergeContent(rawConversation(manager,tab.child.boundary),mode,ctx,summaryAbort.signal);
      if (version !== generation || ctx.sessionManager.getSessionId() !== parentId) throw new Error("Main session changed; merge cancelled");
      requireDestination(destination,tab.id);
      const mergeId = randomUUID();
      const targetFile = destination === 0 ? ctx.sessionManager.getSessionFile()
        : workspace.tabs.get(destination)!.child.manager.getSessionFile();
      const message = {customType:"pi-btw-merge",display:true,
        content:`BTW ${MERGE_MODES.find(option => option.id === mode)!.label} — explicit user merge\nSession: ${manager.getSessionFile()}\n\n${content}`,
        details:{sessionId:manager.getSessionId(),mode,leaf,options,mergeId}};
      if (destination === 0) pi.sendMessage(message,{triggerTurn:true,deliverAs:"followUp"});
      else await workspace.tabs.get(destination)!.child.session.merge(message);
      const settle = (received: boolean) => {
        pendingMerges.delete(pendingKey);
        if (version !== generation || workspace.tabs.get(tab.id) !== tab) return;
        if (!received) {
          tab.notice = `BTW ${tab.id}: merge receipt timed out; source retained. Target may still be queued; check before retrying.`;
          ctx.ui.notify(tab.notice,"warning");
          return;
        }
        tab.merged.set(destination,leaf);
        // The source may have continued while main was draining its queue.
        let unchanged = false;
        try { unchanged = SessionManager.open(manager.getSessionFile()!).getLeafId() === leaf; } catch {}
        if (workspace.current === tab.id) view?.saveDraft();
        const canClose = options.close && unchanged && !tab.child.session.isStreaming && !tab.draft.trim();
        tab.notice = `BTW ${tab.id} merge confirmed in ${destination || "main"}${options.close && !canClose ? "; source retained (new activity or draft)" : ""}`;
        if (canClose) {
          if (workspace.current === tab.id) finish?.({kind:"main"});
          workspace.close(tab.id);
        }
        save();
        ctx.ui.notify(tab.notice,"info");
      };
      if (hasMergeReceipt(targetFile,mergeId)) settle(true);
      else {
        tab.notice = `BTW ${tab.id}: merge queued; waiting for target receipt (source retained)`;
        ctx.ui.notify(tab.notice,"info");
        pendingMerges.set(pendingKey,watchMergeReceipt(() => hasMergeReceipt(targetFile,mergeId),settle));
      }
    } finally { merging = false; summaryAbort = undefined; }
  }
  async function command(args: string, ctx: ExtensionContext) {
    const [verb,...rest] = args.trim().split(/\s+/);
    if (verb === "list") {
      const rows = workspace.listRows(ctx.sessionManager,text => ctx.ui.theme?.fg("dim",text) ?? text);
      const version = generation;
      const choice = await ctx.ui.custom<ListAction | undefined>((tui,theme,_keys,done) =>
        new ListDialog(tui,theme,rows.map(row => ({...row,
          mergeable:!!row.id && !workspace.tabs.get(row.id)!.child.session.closed})),workspace.current,done));
      if (!choice || version !== generation) return;
      if (choice.kind === "merge") {
        const tab = workspace.tabs.get(choice.id);
        if (!tab) throw new Error("Source BTW is closed");
        await chooseMerge(tab,0,ctx);
      } else if (choice.kind === "close") {
        if (!choice.id) throw new Error("Cannot close main");
        if (merging || creating) throw new Error("BTW operation in progress");
        workspace.close(choice.id); save();
      } else if (!choice.id || workspace.tabs.has(choice.id)) workspace.current = choice.id;
      return;
    }
    if (verb === "next" || verb === "prev") { workspace.move(verb === "next" ? 1 : -1); return; }
    if (verb === "close") { await perform({kind:"close"},ctx); return; }
    if (verb === "merge") {
      const tab = selected();
      if (rest.length > 1 || (rest.length && !["source","main"].includes(rest[0])))
        throw new Error("Use /btw merge [source|main], then confirm merge options");
      const target = rest[0] === "source" ? "source" : "main";
      await chooseMerge(tab,workspace.destination(tab,target),ctx); return;
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
      workspace.close(selected().id); save();
    } else await command(action.text || "",ctx);
  }
  async function show(ctx: ExtensionContext) {
    if (showing) return;
    showing = true;
    const version = generation;
    try {
      while (workspace.current && version === generation) {
        const tab = selected();
        try { await tab.child.session.ensureStarted(); } catch (e) { tab.notice = String(e); }
        if (version !== generation) break;
        const action = await ctx.ui.custom<ViewAction>((tui,theme,_keys,done) => {
          finish = done;
          view = new BtwView(tui,theme,tab,done,async text => {
            if (merging) throw new Error("Summary/merge in progress");
            await tab.child.session.prompt(text);
          });
          return view;
        },{overlay:true,overlayOptions:{width:"100%",maxHeight:"100%",anchor:"top-left",margin:0}});
        save(); finish = undefined; view = undefined;
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
  pi.registerCommand("btw",{description:"Fork BTW | list | next | prev | merge [source|main] | close",
    handler:async (args,ctx) => { await run(ctx,{kind:"command",text:args}); }});
  for (const [key,kind] of [["ctrl+b","prev"],["ctrl+f","next"]] as const)
    pi.registerShortcut(key,{description:`BTW ${kind}`,handler:async ctx => { await run(ctx,{kind}); }});
}
