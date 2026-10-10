import { errorMessage } from "../design/error-message.ts"

const guidance: Record<string, readonly [string, string]> = {
  "Session is busy": ["會話仍有執行中或排隊的工作。請先停止目前執行，並在工作面板檢查排隊訊息後重試。", "The conversation has running or queued work. Stop the current execution and review queued messages in the task panel, then retry."],
  "Session has pending durable inputs": ["會話仍有待處理訊息。請在工作面板逐一繼續或取消排隊訊息後重試。", "The conversation has pending messages. Resume or cancel the queued messages in the task panel, then retry."],
  "Session has active or pending durable agents/inbox": ["子代理仍有執行中或待處理的工作。請查看子代理狀態，待工作完成或明確取消後重試。", "Subagents have running or pending work. Review their status and wait for completion or explicitly cancel the work, then retry."],
  "Session has pending durable tasks/outbox": ["會話仍有待處理任務或尚未送達的結果。請查看工作與子代理狀態，處理完成後重試。", "The conversation has pending tasks or undelivered results. Review the task and subagent status, resolve the pending work, then retry."],
  "Session has active Code Mode cells or processes": ["會話仍有執行中的程式或終端程序。請先在執行面板停止相關工作，再重試。", "The conversation has running code or terminal processes. Stop the relevant work in the execution panel, then retry."],
  "Session has pending interactions": ["會話仍有待回覆的問題或核准要求。請先回覆或停止相關執行，再重試。", "The conversation has unanswered questions or approval requests. Respond or stop the relevant execution, then retry."],
  "Session has active workflow work": ["會話仍有執行中的工作流程。請先停止相關目標或工作流程，再重試。", "The conversation has an active workflow. Stop its goal or workflow, then retry."],
  "Session has an unfinished durable turn": ["上次執行尚未完整結束，需要先檢查會話的中斷狀態。記錄會保留；請先處理復原問題再重試。", "A previous turn did not finish. Review the interrupted conversation and resolve its recovery state, then retry. Its records have been preserved."],
  "Session has a pending rewind recording": ["檔案回復記錄尚未完成。請稍候重試；若仍失敗，請保留記錄並檢查中斷回合的復原狀態。", "The rewind recording is incomplete. Wait briefly and retry; if it persists, keep the recording and inspect the interrupted turn's recovery state."],
}

/** Only known management failures are translated; arbitrary diagnostics stay intact. */
export function managementError(reason: unknown, english = false): string {
  const message = errorMessage(reason)
  const known = guidance[message.replace(/^RpcError:\s*/, "")]
  return known?.[english ? 1 : 0] ?? message
}
