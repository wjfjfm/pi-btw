/** SDK creation does not run the CLI's proxy bootstrap. Keep workers on Pi's
 * exact transport setup, including NO_PROXY and HTTP idle timeouts.
 * Version-scoped internal adapter: verified against Pi 1.3.0. */
export async function configureNetwork(settings: { httpProxy?: string; httpIdleTimeoutMs?: number | "disabled" }) {
  const module = await import(new URL("./core/http-dispatcher.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  module.applyHttpProxySettings(settings.httpProxy);
  module.configureHttpDispatcher(settings.httpIdleTimeoutMs);
}
