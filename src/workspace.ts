import type { Child } from "./child.js";

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
  move(direction: 1 | -1) {
    const ids = [0, ...this.tabs.keys()];
    const index = Math.max(0, ids.indexOf(this.current));
    return this.current = ids[(index + direction + ids.length) % ids.length];
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
    if (this.current === id) this.move(-1);
    this.tabs.delete(id); tab.child.session.dispose();
  }
  dispose() {
    for (const tab of this.tabs.values()) tab.child.session.dispose();
    this.tabs.clear(); this.current = 0; this.serial = 0;
  }
}
