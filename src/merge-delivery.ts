import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type MergeMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

/** Keep explicit merges outside the cancellable steering queue until a safe boundary. */
export function createMergeDelivery(pi: ExtensionAPI) {
  const pending: {sessionId: string; message: MergeMessage}[] = [];
  function take(ctx: ExtensionContext) {
    return pending.splice(0).filter(item=>item.sessionId === ctx.sessionManager.getSessionId()).map(item=>item.message);
  }
  pi.on("turn_end",(event,ctx)=>{
    const messages=take(ctx);
    if (!messages.length) return;
    // All tool results are finalized here, including aborted calls. Persist even
    // on abort, but never turn an explicit stop into a new model request.
    return {
      entries:[...event.entries,...messages.map(message=>({type:"custom_message" as const,...message}))],
      ...(!ctx.signal?.aborted && event.message.role === "assistant" && !["error","aborted"].includes(event.message.stopReason) ? {continue:true} : {}),
    };
  });
  pi.on("agent_settled",(_event,ctx)=>{
    // Startup/compaction can be interrupted before any turn_end. At settled it is
    // safe to append without starting execution; no timer or automatic resend.
    for (const message of take(ctx)) pi.sendMessage(message,{triggerTurn:false});
  });
  pi.on("session_tree",()=>{ pending.splice(0); });
  return {
    send(message: MergeMessage,ctx: ExtensionContext) {
      if (ctx.isIdle()) pi.sendMessage(message,{triggerTurn:true,deliverAs:"steer"});
      else pending.push({sessionId:ctx.sessionManager.getSessionId(),message});
    },
    clear() { pending.splice(0); },
  };
}
