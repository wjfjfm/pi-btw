import { generateBranchSummary, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const MERGE_MODES = [
  {id:"summary",label:"summary"},
  {id:"conversation",label:"conversation"},
  {id:"summary-with-conversation",label:"summary with conversation"},
  {id:"full",label:"full conversation with thinking and toolcall"},
] as const;

/** Preserve dialogue text/images, not hidden reasoning or tool protocol. */
export function conversation(entries: SessionEntry[]) {
  return entries.flatMap(entry => {
    const message = entry.type === "message" ? entry.message
      : entry.type === "custom_message" && entry.display ? {role:"user",content:entry.content} : undefined;
    if (!message || (message.role !== "user" && message.role !== "assistant")) return [];
    const content = typeof message.content === "string" ? message.content
      : message.content.filter(block => block.type === "text" || block.type === "image");
    if (!content.length) return [];
    return [JSON.stringify({role:message.role,content})];
  }).join("\n");
}

export async function mergeContent(raw: string, mode: string, ctx: Pick<ExtensionContext, "model" | "modelRegistry">, signal?: AbortSignal) {
  if (!MERGE_MODES.some(option => option.id === mode)) throw new Error("Invalid merge mode");
  if (!raw) throw new Error("No BTW conversation to merge");
  if (mode === "full") return raw;
  const entries: SessionEntry[] = raw.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const dialogue = conversation(entries);
  if (mode === "conversation") {
    if (!dialogue) throw new Error("No dialogue text or images to merge");
    return dialogue;
  }
  if (!ctx.model) throw new Error("No model selected for summary");
  let hasSummaryText = false;
  const result = await generateBranchSummary(entries, {
    model: ctx.model,
    signal: signal ?? new AbortController().signal,
    streamFn: async (model, context, options) => {
      const stream = ctx.modelRegistry.streamSimple(model, context, options);
      const response = await stream.result();
      hasSummaryText = response.content.some(block => block.type === "text" && block.text.trim());
      return stream;
    },
  });
  if (result.aborted) throw new Error("Summary aborted; nothing merged");
  if (result.error) throw new Error(result.error);
  if (!hasSummaryText || !result.summary?.trim()) throw new Error("Empty summary; nothing merged");
  return mode === "summary-with-conversation" ? `## Summary\n\n${result.summary}\n\n## Conversation (JSONL)\n\n${dialogue}` : result.summary;
}
