import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChildSession, type Capture, type WorkerConfig } from "./child.js";
import { Workspace } from "./workspace.js";

interface SavedTab {
  id: number; source: number; draft: string; merged: [number,string | null][];
  capture: Omit<Capture,"manager"> & {file: string};
}
interface Manifest { version: 1; parentId: string; serial: number; tabs: SavedTab[] }
export function workspaceFile(manager: ExtensionContext["sessionManager"]) {
  const file = manager.getSessionFile();
  return file ? join(dirname(file),"btw-workspaces",`${manager.getSessionId()}.json`) : undefined;
}
/** Sidecar only: never append model-facing entries or restore running turns. */
export function saveWorkspace(file: string | undefined, parentId: string, workspace: Workspace) {
  if (!file) return;
  const tabs: SavedTab[] = [...workspace.tabs.values()].map(tab => {
    const {session: _session,manager,...capture} = tab.child;
    return {id:tab.id,source:tab.source,draft:tab.draft,merged:[...tab.merged],capture:{...capture,file:manager.getSessionFile()!}};
  });
  const data: Manifest = {version:1,parentId,serial:workspace.serial,tabs};
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary,JSON.stringify(data),{mode:0o600,flag:"wx"});
  renameSync(temporary,file);
}
export function restoreWorkspace(file: string | undefined, parentId: string, workspace: Workspace) {
  if (!file || !existsSync(file)) return;
  const data: Manifest = JSON.parse(readFileSync(file,"utf8"));
  if (data.version !== 1 || data.parentId !== parentId || !Array.isArray(data.tabs)) throw new Error("Invalid BTW workspace manifest");
  const restored = new Workspace();
  try {
    for (const saved of data.tabs) {
      if (!Number.isSafeInteger(saved.id) || saved.id <= 0 || restored.tabs.has(saved.id) || !Number.isSafeInteger(saved.source) || saved.source < 0)
        throw new Error("Invalid BTW workspace tab");
      if (!existsSync(saved.capture.file)) throw new Error(`BTW session file missing: ${saved.capture.file}`);
      const {file: childFile,...capture} = saved.capture;
      const manager = SessionManager.open(childFile);
      if (!manager.getBranch().some(entry => entry.id === capture.boundary)) throw new Error(`BTW boundary missing: ${childFile}`);
      const {origin:_origin,boundary:_boundary,pendingCount:_pending,...config} = capture;
      const session = new ChildSession(capture.cwd,{...config,file:childFile} as WorkerConfig);
      session.messages = manager.buildSessionContext().messages;
      const tab = restored.add({...capture,manager,session},saved.source,saved.id);
      tab.draft = saved.draft || ""; tab.merged = new Map(saved.merged);
    }
    restored.serial = Math.max(restored.serial,Number.isSafeInteger(data.serial) ? data.serial : 0);
    workspace.tabs = restored.tabs; workspace.serial = restored.serial; workspace.current = 0;
  } catch (error) { restored.dispose(); throw error; }
}
