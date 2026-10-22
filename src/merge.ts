import { generateBranchSummary, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { transcript, prefixContent } from "./transcript.js";

export const MERGE_MODES = [
  {id:"summary",label:"summary"},
  {id:"conversation",label:"conversation"},
  {id:"summary-with-conversation",label:"summary with conversation"},
  {id:"full",label:"full conversation with thinking and toolcall"},
  {id:"summary-with-full",label:"summary with full conversation"},
] as const;

/** Preserve dialogue text/images, not hidden reasoning or tool protocol. */
export function conversation(entries: SessionEntry[]) {
  return transcript(entries,false);
}

export async function mergeContent(raw: string, mode: string, ctx: Pick<ExtensionContext, "model" | "modelRegistry">, signal?: AbortSignal) {
  if (!MERGE_MODES.some(option => option.id === mode)) throw new Error("Invalid merge mode");
  if (!raw) throw new Error("No BTW conversation to merge");
  const entries: SessionEntry[] = raw.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const full = mode === "full" || mode === "summary-with-full";
  const dialogue = mode === "summary" ? "" : transcript(entries,full);
  if (mode === "conversation" || mode === "full") {
    if (!dialogue.length) throw new Error("No dialogue text or images to merge");
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
  if (mode === "summary") return result.summary;
  return prefixContent(`## Summary\n\n${result.summary}\n\n# Conversation\n\n`,dialogue);
}
