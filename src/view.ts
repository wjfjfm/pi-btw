import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, truncateToWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { Child } from "./child.js";

export class BtwView {
  private editor: Editor;
  private unsubscribe: () => void;
  private offset = 0;
  private live = "";
  private error = "";
  private cache?: { width: number; lines: string[] };
  constructor(private tui: TUI, private theme: Theme, private child: Child,
    draft: string, private close: (draft: string) => void,
    private submit: (text: string) => Promise<void>) {
    this.editor = new Editor(tui, { borderColor: text => theme.fg("accent", text), selectList: getSelectListTheme() });
    this.editor.setText(draft);
    this.editor.onSubmit = text => {
      if (!text.trim()) return;
      this.editor.setText(""); this.offset = 0; this.error = "";
      void this.submit(text).catch(error => { this.error = String(error); this.editor.setText(text); })
        .finally(() => { this.invalidate(); tui.requestRender(); });
    };
    this.unsubscribe = child.session.subscribe(event => {
      if (event.type === "message_update") {
        this.live = event.message.role === "assistant"
          ? event.message.content.filter(b => b.type === "text").map(b => b.text).join("") : "";
      } else if (event.type === "message_end") this.live = "";
      this.invalidate(); tui.requestRender();
    });
  }
  get focused() { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  invalidate() { this.cache = undefined; this.editor.invalidate(); }
  dispose() { this.unsubscribe(); }
  handleInput(data: string) {
    if (matchesKey(data, "ctrl+alt+b") || matchesKey(data, "ctrl+alt+f") || matchesKey(data, "escape")) {
      this.close(this.editor.getText()); return;
    }
    if (matchesKey(data, "ctrl+c")) {
      void this.child.session.abort().catch(error => { this.error = String(error); this.tui.requestRender(); });
      return;
    }
    if (matchesKey(data, "pageUp")) { this.offset += 10; this.tui.requestRender(); return; }
    if (matchesKey(data, "pageDown")) { this.offset = Math.max(0, this.offset - 10); this.tui.requestRender(); return; }
    this.editor.handleInput(data); this.tui.requestRender();
  }
  render(width: number): string[] {
    const height = Math.max(4, this.tui.terminal.rows);
    const editor = this.editor.render(width).slice(-(height - 2));
    const room = Math.max(0, height - editor.length - 2);
    if (!this.cache || this.cache.width !== width) {
      const text = this.child.session.messages.map(message => {
        if (message.role === "system") return "";
        const body = "content" in message ? message.content : "summary" in message ? message.summary : JSON.stringify(message);
        const rendered = typeof body === "string" ? body : body.map(b => {
          if (b.type === "text") return b.text;
          if (b.type === "toolCall") return `[tool ${b.name}] ${JSON.stringify(b.arguments)}`;
          if (b.type === "image") return "[image]";
          return "";
        }).filter(Boolean).join("\n");
        return rendered ? `${message.role}: ${rendered}` : "";
      }).filter(Boolean).join("\n\n") + (this.live ? `\n\nassistant (streaming): ${this.live}` : "");
      this.cache = { width, lines: text.split("\n").flatMap(line => wrapTextWithAnsi(line, Math.max(1, width))) };
    }
    const lines = this.cache.lines;
    this.offset = Math.min(this.offset, Math.max(0, lines.length - room));
    const end = lines.length - this.offset;
    const body = lines.slice(Math.max(0, end - room), end);
    while (body.length < room) body.push("");
    return [
      this.theme.fg("accent", truncateToWidth(`BTW · ${this.child.session.isStreaming ? "running" : "idle"} · Esc/Ctrl+Alt+B main · Ctrl+C stop BTW · PgUp/PgDn`, width)),
      ...body,
      truncateToWidth(this.error || " /merge full | /merge summary · /main · shared working directory", width),
      ...editor,
    ].map(line => truncateToWidth(line, width));
  }
}
