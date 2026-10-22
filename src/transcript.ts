import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type MergeContent = string | (TextContent | ImageContent)[];
export function prefixContent(prefix: string, content: MergeContent): MergeContent {
  return typeof content === "string" ? prefix + content : [{type:"text",text:prefix},...content];
}
function fenced(text: string, language = "") {
  const longest = (text.match(/`+/g) ?? []).reduce((max,run) => Math.max(max,run.length),2);
  const fence = "`".repeat(longest+1);
  return `${fence}${language}\n${text}\n${fence}`;
}

/** Readable quoted history, not session-storage JSON or replayable tool protocol. */
export function transcript(entries: SessionEntry[], full: boolean): MergeContent {
  const output: (TextContent | ImageContent)[] = [];
  const calls = new Map<string,number>();
  const call = (id: string) => {
    if (!calls.has(id)) calls.set(id,calls.size+1);
    return `#${calls.get(id)}`;
  };
  const text = (value: string) => {
    if (!value) return;
    const last = output.at(-1);
    if (last?.type === "text") last.text += `\n\n${value}`;
    else output.push({type:"text",text:value});
  };
  const body = (content: unknown, tools = false) => {
    if (typeof content === "string") { text(content); return; }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === "text") text(tools ? fenced(block.text) : block.text);
      else if (block.type === "image") output.push({type:"image",mimeType:block.mimeType,data:block.data});
      else if (full && block.type === "thinking" && block.thinking) text(`### Thinking\n\n${block.thinking}`);
      else if (full && block.type === "toolCall")
        text(`### Tool call ${call(block.id)}: ${block.name}\n\n${fenced(JSON.stringify(block.arguments,null,2) ?? "null","json")}`);
    }
  };
  for (const entry of entries) {
    if (entry.type === "custom_message") {
      if (full || entry.display) { text(`## Note: ${entry.customType}${entry.display ? "" : " (hidden in source UI)"}`); body(entry.content); }
    } else if (full && (entry.type === "branch_summary" || entry.type === "compaction")) {
      text(`## ${entry.type === "compaction" ? "Compaction summary" : "Branch summary"}\n\n${entry.summary}`);
    } else if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user" || message.role === "assistant") {
        const content = message.content;
        const visible = typeof content === "string" ? !!content : content.some(block =>
          block.type === "text" && !!block.text || block.type === "image" || full && (block.type === "thinking" || block.type === "toolCall"));
        const error = full && message.role === "assistant" ? message.errorMessage : undefined;
        const status = full && message.role === "assistant" && ["error","aborted","length"].includes(message.stopReason) ? message.stopReason : undefined;
        if (!visible && !error && !status) continue;
        text(`## ${message.role === "user" ? "User" : "Assistant"}`);
        body(content);
        if (error) text(`### Error\n\n${error}`);
        if (status) text(`Response status: ${status}`);
      } else if (full && message.role === "toolResult") {
        text(`## Tool result ${call(message.toolCallId)}: ${message.toolName}${message.isError ? " (error)" : ""}`);
        body(message.content,true);
        if (message.details != null) text(`### Tool details\n\n${fenced(JSON.stringify(message.details,null,2),"json")}`);
      } else if (full && message.role === "bashExecution") {
        text(`## Shell command\n\n${fenced(message.command,"sh")}\n\n${fenced(message.output)}\n\nExit code: ${message.exitCode ?? "unknown"}${message.cancelled ? " (cancelled)" : ""}${message.truncated ? " (output truncated at source)" : ""}`);
        if (message.fullOutputPath) text(`Full output: ${message.fullOutputPath}`);
      }
      // System prompt/tool schemas are runtime configuration, not dialogue.
    }
  }
  return output.some(block => block.type === "image") ? output : output.map(block => (block as TextContent).text).join("\n\n");
}
