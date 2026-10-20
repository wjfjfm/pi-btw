import { generateBranchSummary, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** Full mode is lossless; summary deliberately follows Pi /tree's native policy. */
export async function mergeContent(raw: string, mode: string, ctx: Pick<ExtensionContext, "model" | "modelRegistry">, signal?: AbortSignal) {
  if (mode !== "full" && mode !== "summary") throw new Error("Use /btw merge full|summary");
  if (!raw) throw new Error("No BTW conversation to merge");
  if (mode === "full") return raw;
  if (!ctx.model) throw new Error("No model selected for summary");
  const entries: SessionEntry[] = raw.split("\n").filter(Boolean).map(line => JSON.parse(line));
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
  return result.summary;
}
