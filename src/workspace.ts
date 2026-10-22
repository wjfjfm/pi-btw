import { statSync } from "node:fs";
import type { Child } from "./child.js";
import { childPreview, sessionPreview, inlinePreview } from "./preview.js";

export interface Tab {
  id: number;
  source: number;
  child: Child;
  draft: string;
  notice?: string;
  merged: Map<number, string | null>;
}
/** 0 is the real main TUI; child IDs never get reused after close. */
export class Workspace {
  tabs = new Map<number, Tab>();
  current = 0;
  serial = 0;
  add(child: Child, source = this.current, id = this.serial + 1) {
    this.serial = Math.max(this.serial,id);
    const tab: Tab = { id, source, child, draft: "", merged: new Map() };
    this.tabs.set(tab.id, tab); this.current = tab.id;
    return tab;
  }
  listRows(main?: Parameters<typeof sessionPreview>[0], dim?: (text: string) => string) {
    const rows = [{id:0,label:"main" + (main ? inlinePreview(sessionPreview(main),dim) : "")}];
    const children = new Map<number,Tab[]>();
    const own = new Map<number,{time:number; id:number}>();
    for (const tab of this.tabs.values()) {
      const siblings = children.get(tab.source) ?? [];
      siblings.push(tab); children.set(tab.source,siblings);
      let time = Math.max(tab.child.origin?.createdAt ?? 0,tab.child.session.lastActivity ?? 0);
      const file = tab.child.manager?.getSessionFile();
      if (file) { try { time = Math.max(time,statSync(file).mtimeMs); } catch {} }
      own.set(tab.id,{time,id:tab.id});
    }
    const ranks = new Map<number,{time:number; id:number}>();
    const ranking = new Set<number>();
    const newer = (a: {time:number; id:number}, b: {time:number; id:number}) => a.time-b.time || a.id-b.id;
    const rank = (id: number): {time:number; id:number} => {
      if (ranks.has(id)) return ranks.get(id)!;
      let latest = own.get(id)!;
      if (ranking.has(id)) return latest; // Defensive support for legacy cycles.
      ranking.add(id);
      for (const child of children.get(id) ?? []) {
        const descendant = rank(child.id);
        if (newer(descendant,latest) > 0) latest = descendant;
      }
      ranking.delete(id); ranks.set(id,latest);
      return latest;
    };
    for (const tab of this.tabs.values()) rank(tab.id);
    const visited = new Set<number>();
    const walk = (tabs: Tab[], prefix: string) => {
      tabs.sort((a,b) => newer(rank(b.id),rank(a.id)) || b.id-a.id).forEach((tab,index) => {
        if (visited.has(tab.id)) return;
        visited.add(tab.id);
        const last = index === tabs.length - 1;
        const status = tab.child.session.closed ? "closed" : tab.child.session.dormant ? "saved" : tab.child.session.isStreaming ? "running" : "idle";
        const source = tab.source || "main";
        const preview = inlinePreview(childPreview(tab.child),dim);
        rows.push({id:tab.id,label:`${prefix}${last ? "└─" : "├─"} BTW ${tab.id} · source ${source}${tab.source && !this.tabs.has(tab.source) ? " (closed)" : ""} · ${status}${preview}`});
        walk((children.get(tab.id) ?? []).filter(child => !visited.has(child.id)),prefix + (last ? "   " : "│  "));
      });
    };
    walk([...this.tabs.values()].filter(tab => !tab.source || !this.tabs.has(tab.source)),"");
    // Corrupt/legacy cycles must not hide sessions or recurse forever.
    walk([...this.tabs.values()].filter(tab => !visited.has(tab.id)),"");
    return rows;
  }
  destination(tab: Tab, target: "source" | "main") {
    const id = target === "main" ? 0 : tab.source;
    if (id && (!this.tabs.has(id) || this.tabs.get(id)!.child.session.closed))
      throw new Error("Source BTW is closed; choose main instead");
    return id;
  }
  close(id: number) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.current === id) this.current = 0;
    this.tabs.delete(id); tab.child.session.dispose();
  }
  dispose() {
    for (const tab of this.tabs.values()) tab.child.session.dispose();
    this.tabs.clear(); this.current = 0; this.serial = 0;
  }
}
