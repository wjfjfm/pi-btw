import { FooterComponent, initTheme, type AgentSession, type ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";

/** Render the standard Pi footer against the real child session, never parent stats. */
export async function createFooter(session: AgentSession, cwd: string, themeName: string | undefined, changed: () => void) {
  const {FooterDataProvider} = await import(new URL("./core/footer-data-provider.js",import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const data = new FooterDataProvider(cwd);
  data.onBranchChange(changed);
  let theme = themeName;
  initTheme(theme,false);
  const footer = new FooterComponent(session,data as ReadonlyFooterDataProvider);
  footer.setAutoCompactEnabled(session.settingsManager.getCompactionEnabled());
  return {
    setStatus(key: string,text?: string) { data.setExtensionStatus(key,text); changed(); },
    render(width: number,name?: string) {
      if (name && name !== theme) { theme = name; initTheme(theme,false); }
      return footer.render(Math.max(4,Math.min(1000,width)));
    },
    dispose() { footer.dispose(); data.dispose(); },
  };
}
