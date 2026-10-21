import { statSync } from "node:fs";
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
  const textOf = (entry: typeof branch[number]) => {
    if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return "";
    const content = entry.message.content;
    return brief(typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("\n"));
  };
  let first = "", last = "";
  for (let i=index+1;i<branch.length && !first;i++) first = textOf(branch[i]);
  for (let i=branch.length-1;i>index && !last;i--) last = textOf(branch[i]);
  return first ? [`首：${first}`,`末：${last}`] : ["暂无新对话"];
}
export function inlinePreview(lines: string[], dim: (text: string) => string = text => text) {
  const snippets = [...new Set(lines.map(line => line.replace(/^[首末]：/,"")))];
  const text = snippets.map(line => stripVTControlCharacters(truncateToWidth(line,24))).join(" … ");
  return text ? `  ${dim(text)}` : "";
}
const previews = new WeakMap<Child,{stamp:string; lines:string[]}>();
function previewStamp(child: Child, file: string) {
  const stat = statSync(file,{bigint:true});
  return `${file}:${child.boundary}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
/** Only for a freshly captured manager, before its worker starts writing. */
export function primePreview(child: Child) {
  const file = child.manager.getSessionFile();
  if (file) previews.set(child,{stamp:previewStamp(child,file),lines:sessionPreview(child.manager,child.boundary)});
}
export function childPreview(child: Child): string[] {
  if (child.session?.preview) return child.session.preview;
  const file = child.manager?.getSessionFile();
  if (!file) return [];
  try {
    const stamp = previewStamp(child,file);
    const cached = previews.get(child);
    if (cached?.stamp === stamp) return cached.lines;
    const lines = sessionPreview(SessionManager.open(file),child.boundary);
    previews.set(child,{stamp,lines});
    return lines;
  }
  catch { return ["预览不可用：无法读取会话文件"]; }
}
