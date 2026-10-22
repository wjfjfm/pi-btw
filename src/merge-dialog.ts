import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

export interface MergeOptions {
  destination: number;
  close: boolean;
  summary: boolean;
  conversation: "Full" | "Strip" | "None";
}
export function mergeMode(options: MergeOptions) {
  if (!options.summary && options.conversation === "None") throw new Error("Select Summary or Conversation");
  if (options.conversation === "None") return "summary";
  if (options.conversation === "Full") return options.summary ? "summary-with-full" : "full";
  return options.summary ? "summary-with-conversation" : "conversation";
}

/** One interaction, with explicit confirmation before any model or session operation. */
export class MergeDialog {
  private focus = 0;
  private error = "";
  private options: MergeOptions;
  constructor(private tui: Pick<TUI,"requestRender">, private theme: Theme,
    private source: number, private targets: {id:number;label:string}[],
    destination: number, private done: (result: MergeOptions | undefined) => void) {
    this.options = {destination,close:true,summary:false,conversation:"Strip"};
  }
  invalidate() {}
  handleInput(data: string) {
    if (matchesKey(data,"escape")) { this.done(undefined); return; }
    if (matchesKey(data,"tab") || matchesKey(data,"down")) this.focus = (this.focus + 1) % 6;
    else if (matchesKey(data,"shift+tab") || matchesKey(data,"up")) this.focus = (this.focus + 5) % 6;
    else if (matchesKey(data,"enter") && this.focus < 2) {
      if (this.focus === 1) { this.done(undefined); return; }
      try { mergeMode(this.options); this.done({...this.options}); return; }
      catch (e) { this.error = (e as Error).message; }
    } else if (matchesKey(data,"left") || matchesKey(data,"right") || matchesKey(data,"enter") || data === " ") {
      const direction = matchesKey(data,"left") ? -1 : 1;
      if (this.focus < 2) this.focus = 1 - this.focus;
      if (this.focus === 2) {
        const index = this.targets.findIndex(t => t.id === this.options.destination);
        this.options.destination = this.targets[(index + direction + this.targets.length) % this.targets.length].id;
      } else if (this.focus === 3) this.options.close = !this.options.close;
      else if (this.focus === 4) this.options.summary = !this.options.summary;
      else if (this.focus === 5) {
        const values = ["Full","Strip","None"] as const;
        this.options.conversation = values[(values.indexOf(this.options.conversation) + direction + 3) % 3];
      }
      this.error = "";
    }
    this.tui.requestRender();
  }
  render(width: number) {
    const field = (index:number, label:string, value:string) => {
      const text = `${this.focus === index ? "›" : " "} ${label.padEnd(20)} ${value}`;
      return this.focus === index ? this.theme.fg("accent",text) : text;
    };
    const button = (index:number, label:string) => this.focus === index ? this.theme.fg("accent",`[${label}]`) : ` ${label} `;
    const lines = [this.theme.fg("accent",`Merge BTW ${this.source}`), "",
      field(2,"Merge to:",this.targets.find(t => t.id === this.options.destination)?.label ?? "main"),
      field(3,"Close current btw:",this.options.close ? "Yes" : "No"),
      field(4,"Summary:",this.options.summary ? "Yes" : "No"),
      field(5,"Conversation:",this.options.conversation), "",
      `  ${button(0,"OK")}  ${button(1,"Cancel")}`, "",
      this.theme.fg("dim","Tab/↑↓ focus · ←→ change · Enter select · Esc cancel"),
      ...(this.error ? [this.theme.fg("error",this.error)] : []),
    ];
    if (width < 4) return lines.map(line => truncateToWidth(line,width));
    const border = (text:string) => this.theme.fg("border",text);
    return [border("╭" + "─".repeat(width - 2) + "╮"),
      ...lines.map(line => {
        const text = truncateToWidth(line,width - 4);
        return border("│") + " " + text + " ".repeat(width - 3 - visibleWidth(text)) + border("│");
      }), border("╰" + "─".repeat(width - 2) + "╯")];
  }
}
