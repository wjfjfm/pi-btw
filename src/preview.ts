import { stripVTControlCharacters } from "node:util";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Child } from "./child.js";

type ReadonlyManager = ExtensionContext["sessionManager"];
function brief(text: string) {
  return stripVTControlCharacters(truncateToWidth(stripVTControlCharacters(text).replace(/[\s\x00-\x1f\x7f-\x9f]+/g," ").trim(),64));
}
/** Read only dialogue after the fork boundary, never inherited history or tools. */
export function sessionPreview(manager: ReadonlyManager, boundary?: string): string[] {
  const branch = manager.getBranch();
  const index = boundary ? branch.findIndex(entry => entry.id === boundary) : -1;
  if (boundary && index < 0) return ["预览不可用：分支起点缺失"];
  let first = "", last = "";
  for (const entry of branch.slice(index+1)) {
    if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) continue;
    const content = entry.message.content;
    const text = brief(typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("\n"));
    if (!text) continue;
    if (!first) first = text;
    last = text;
  }
  return first ? [`首：${first}`,`末：${last}`] : ["暂无新对话"];
}
export function childPreview(child: Child): string[] {
  const file = child.manager?.getSessionFile();
  if (!file) return [];
  try { return sessionPreview(SessionManager.open(file),child.boundary); }
  catch { return ["预览不可用：无法读取会话文件"]; }
}
