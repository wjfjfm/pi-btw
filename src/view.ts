import { AssistantMessageComponent, UserMessageComponent, CustomMessageComponent, ToolExecutionComponent,
  getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Text, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Tab } from "./workspace.js";
import { childPreview, inlinePreview } from "./preview.js";

export type ViewAction = { kind: "main" | "new" | "close" | "command"; text?: string };
export const HELP = "Esc main | /btw · /btw list · /btw merge · /btw close";

/** Pi's native message components and child footer in a full-screen viewport. */
export class BtwView {
  private editor: Editor;
  private unsubscribe: () => void;
  private offset = 0;
  private preview?: { messages: Tab["child"]["session"]["messages"]; lines: string[] };
  private error = "";
  private cache?: { width: number; lines: string[] };
  private history?: { width: number; messages: Tab["child"]["session"]["messages"]; lines: string[] };
  constructor(private tui: TUI, private theme: Theme, private tab: Tab,
    private act: (action: ViewAction) => void, private submit: (text: string) => Promise<void>) {
    this.editor = new Editor(tui, { borderColor: text => theme.fg("accent", text), selectList: getSelectListTheme() });
    this.editor.setText(tab.draft);
    this.editor.onSubmit = text => {
      if (!text.trim()) return;
      this.editor.setText(""); this.offset = 0; this.error = ""; this.tab.notice = undefined;
      if (text === "/btw" || text.startsWith("/btw ")) { this.action({kind:"command",text:text.slice(4).trim()}); return; }
      if (text === "/main" || text.startsWith("/merge")) { this.error = "Use the shortcuts below or /btw merge [source|main]"; return; }
      void this.submit(text).catch(error => { this.error = String(error); if (!this.editor.getText()) this.editor.setText(text); })
        .finally(() => { this.invalidate(); tui.requestRender(); });
    };
    this.unsubscribe = tab.child.session.observe(() => { this.cache = undefined; tui.requestRender(); });
  }
  private action(action: ViewAction) { this.tab.draft = this.editor.getText(); this.act(action); }
  get focused() { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  invalidate() { this.cache = undefined; this.history = undefined; this.editor.invalidate(); }
  saveDraft() { this.tab.draft = this.editor.getText(); }
  dispose() { this.saveDraft(); this.unsubscribe(); }
  handleInput(data: string) {
    if (matchesKey(data,"escape")) { this.action({kind:"main"}); return; }
    if (matchesKey(data,"ctrl+c")) {
      void this.tab.child.session.abort().catch(error => { this.error = String(error); this.tui.requestRender(); }); return;
    }
    if (matchesKey(data,"pageUp")) { this.offset += 10; this.tui.requestRender(); return; }
    if (matchesKey(data,"pageDown")) { this.offset = Math.max(0,this.offset-10); this.tui.requestRender(); return; }
    this.editor.handleInput(data); this.tui.requestRender();
  }
  private transcript(width: number, messages: Tab["child"]["session"]["messages"]) {
    const session = this.tab.child.session;
    const components: Component[] = [];
    const tools = new Map<string,ToolExecutionComponent>();
    const tool = (id: string,name: string,args: unknown) => {
      let component = tools.get(id);
      if (!component) {
        component = new ToolExecutionComponent(name,id,args,{showImages:false},undefined,this.tui,this.tab.child.cwd);
        tools.set(id,component); components.push(component);
      }
      return component;
    };
    for (const message of messages) {
      if (message.role === "system") continue;
      if (message.role === "assistant") {
        const component = new AssistantMessageComponent(message);
        if (message === session.partial) component.updateContent(message,true);
        components.push(component);
        for (const block of message.content) if (block.type === "toolCall") tool(block.id,block.name,block.arguments);
      } else if (message.role === "toolResult") {
        tool(message.toolCallId,message.toolName,{}).updateResult({...message,isError:!!message.isError});
      } else if (message.role === "user") {
        const text = typeof message.content === "string" ? message.content : message.content.map(b => b.type === "text" ? b.text : "[image]").join("\n");
        components.push(new UserMessageComponent(text));
      } else if (message.role === "custom") {
        if (message.display) components.push(new CustomMessageComponent(message));
      } else if ("summary" in message) {
        components.push(new CustomMessageComponent({role:"custom",customType:message.role,content:message.summary,display:true,timestamp:message.timestamp}));
      } else {
        components.push(new Text(JSON.stringify(message),1,0));
      }
    }
    return components.flatMap(component => component.render(Math.max(4,width)));
  }
  render(width: number): string[] {
    const height = Math.max(4,this.tui.terminal.rows);
    const session = this.tab.child.session;
    if (!this.preview || this.preview.messages !== session.messages)
      this.preview = {messages:session.messages,lines:childPreview(this.tab.child)};
    const status = [...(session.footer?.(width,this.theme.name) ?? []),
      this.theme.fg("accent",`当前会话：BTW ${this.tab.id} · 来源：${this.tab.source ? `BTW ${this.tab.source}` : "main"}`)
        + inlinePreview(this.preview.lines,text => this.theme.fg("dim",text))]
      .slice(0,Math.max(0,height-5));
    const hint = this.error || session.error || this.tab.notice || "";
    const footer = wrapTextWithAnsi(hint ? `${hint}\n${HELP}` : HELP,Math.max(1,width)).slice(0,Math.max(1,Math.min(Math.floor(height/3),height-status.length-3)));
    const editor = this.editor.render(width).slice(-(height-footer.length-status.length-1));
    const room = Math.max(0,height-editor.length-footer.length-status.length-1);
    if (!this.cache || this.cache.width !== width) {
      if (!this.history || this.history.width !== width || this.history.messages !== session.messages)
        this.history = {width,messages:session.messages,lines:this.transcript(width,session.messages)};
      this.cache = {width,lines:[...this.history.lines,...(session.partial ? this.transcript(width,[session.partial]) : [])]};
    }
    const lines = this.cache.lines;
    this.offset = Math.min(this.offset,Math.max(0,lines.length-room));
    const end = lines.length-this.offset;
    const body = lines.slice(Math.max(0,end-room),end);
    while (body.length < room) body.push("");
    return [this.theme.fg("accent",`当前：BTW ${this.tab.id} · 来源：${this.tab.source ? `BTW ${this.tab.source}` : "main"} · ${session.closed ? "closed" : session.isStreaming ? "running" : "idle"}`),
      ...body,...footer,...editor,...status].map(line => truncateToWidth(line,width));
  }
}
