import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** A queue acknowledgement is not a receipt: require the exact merge in persisted active history. */
export function hasMergeReceipt(file: string | undefined, mergeId: string) {
  if (!file || !existsSync(file)) return false;
  try {
    return SessionManager.open(file).getBranch().some(entry => entry.type === "custom_message"
      && entry.customType === "pi-btw-merge"
      && (entry.details as {mergeId?:string} | undefined)?.mergeId === mergeId);
  } catch { return false; }
}
export function watchMergeReceipt(check: () => boolean, settled: (received: boolean) => void,
  timeout = 120_000, interval = 500) {
  const deadline = Date.now() + timeout;
  const timer = setInterval(() => {
    if (check()) { clearInterval(timer); settled(true); }
    else if (Date.now() >= deadline) { clearInterval(timer); settled(false); }
  },interval);
  timer.unref();
  return () => clearInterval(timer);
}
