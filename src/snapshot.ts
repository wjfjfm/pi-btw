import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
type ReadonlySessionManager = ExtensionContext["sessionManager"];

export const ORIGIN = "pi-btw-origin";
export interface Origin {
  parentId: string;
  parentFile?: string;
  parentLeaf: string | null;
  createdAt: number;
}

/** Capture synchronously, before any await. Fork only the detached manager. */
export function forkSnapshot(source: ReadonlySessionManager, cwd: string, partial?: unknown, directory?: string) {
  const header = source.getHeader();
  if (!header) throw new Error("Cannot fork a session without a header");
  const leaf = source.getLeafId();
  const entries = structuredClone([header, ...source.getBranch()]);
  const detached = SessionManager.inMemory(cwd, undefined, entries);
  if (leaf) detached.createBranchedSession(leaf);
  // Empty sessions also need a new identity.
  const forkHeader = leaf ? detached.getHeader()! : SessionManager.inMemory(cwd).getHeader()!;
  const origin: Origin = {
    parentId: source.getSessionId(), parentFile: source.getSessionFile(),
    parentLeaf: leaf, createdAt: Date.now(),
  };
  const dir = directory ?? (source.getSessionDir() || SessionManager.create(cwd).getSessionDir());
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${forkHeader.id}.jsonl`);
  writeFileSync(file, [ { ...forkHeader, parentSession: origin.parentFile }, ...detached.getEntries() ]
    .map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  const manager = SessionManager.open(file);

  // In-flight side effects belong to the parent. Complete their protocol envelopes
  // with explicit snapshot errors, never run them again or pretend they succeeded.
  const pendingCount = sealPendingCalls(manager, "BTW snapshot boundary: this call had no finalized result at capture time. It may still be executing in the parent session. It was NOT executed or cancelled by BTW; do not repeat side effects without checking.", origin.createdAt);
  if (partial) manager.appendCustomMessageEntry("pi-btw-inflight", [{ type: "text", text:
    `Unfinished parent response at snapshot time (observation only, not a completed response or an instruction to execute its tool calls):\n${JSON.stringify(partial)}` }], true);
  const boundary = manager.appendCustomEntry(ORIGIN, origin);
  return { manager, origin, boundary, pendingCount };
}

export function sealPendingCalls(manager: SessionManager, text: string, timestamp = Date.now()) {
  const pending = new Map<string, string>();
  for (const message of manager.buildSessionContext().messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") pending.set(block.id, block.name);
    } else if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  for (const [toolCallId, toolName] of pending) {
    manager.appendMessage({ role: "toolResult", toolCallId, toolName, isError: true,
      content: [{ type: "text", text }], timestamp });
  }
  return pending.size;
}

/** Raw entries after the fork boundary: no compaction/projection and no truncation. */
export function rawConversation(manager: ReadonlySessionManager, boundary: string): string {
  const branch = manager.getBranch();
  const index = branch.findIndex(entry => entry.id === boundary);
  if (index < 0) throw new Error("BTW fork boundary is not on the active branch");
  return branch.slice(index + 1)
    .filter(entry => entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "compaction")
    .map(entry => JSON.stringify(entry)).join("\n");
}
