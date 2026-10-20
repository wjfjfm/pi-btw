import type { Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, type TUI } from "@earendil-works/pi-tui";

export interface ListAction { kind: "switch" | "merge"; id: number }
export class ListDialog {
  private list: SelectList;
  private notice = "";
  constructor(private tui: Pick<TUI,"requestRender">, private theme: Theme,
    rows: {id:number;label:string;mergeable:boolean}[], current: number,
    private done: (action: ListAction | undefined) => void) {
    this.list = new SelectList(rows.map(row => ({value:String(row.id),label:row.label})),10,{
      selectedPrefix:text=>theme.fg("accent",text),selectedText:text=>theme.fg("accent",text),
      description:text=>theme.fg("muted",text),scrollInfo:text=>theme.fg("dim",text),noMatch:text=>theme.fg("warning",text),
    });
    this.list.setSelectedIndex(Math.max(0,rows.findIndex(row=>row.id===current)));
    this.list.onSelect = item => done({kind:"switch",id:Number(item.value)});
    this.list.onCancel = () => done(undefined);
    this.mergeable = new Set(rows.filter(row=>row.mergeable).map(row=>row.id));
  }
  private mergeable: Set<number>;
  invalidate() { this.list.invalidate(); }
  handleInput(data: string) {
    this.notice = "";
    if (data === "m" || data === "M") {
      const item = this.list.getSelectedItem();
      if (item && this.mergeable.has(Number(item.value))) {
        this.done({kind:"merge",id:Number(item.value)}); return;
      }
      this.notice = "Select an available BTW to merge";
    } else this.list.handleInput(data);
    this.tui.requestRender();
  }
  render(width: number) {
    return [this.theme.fg("accent","BTW sessions"),"",...this.list.render(width),"",
      this.theme.fg("dim","↑↓ navigate · Enter switch · m merge · Esc cancel"),
      ...(this.notice ? [this.theme.fg("warning",this.notice)] : []),
    ].map(line=>truncateToWidth(line,width));
  }
}
