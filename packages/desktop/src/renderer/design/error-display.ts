/** Turn a bridge/runtime error into a short, human-readable summary.
 *
 * Raw IPC failures arrive as
 *   Error invoking remote method 'ih-desktop:request': RpcError: <cause>
 * and the cause itself is often a class name plus a stack-less message. The
 * transcript should name the failure in product terms; the exact text stays
 * available in the diagnostics log (and in the raw value returned here).
 */
export interface DisplayError {
  /** Short, user-facing description. */
  summary: string
  /** Original message when the summary dropped or rewrote any part of it. */
  detail?: string
}

const RPC = /^Error invoking remote method '[^']+':\s*/
const RPC_ERROR = /^RpcError:\s*/
const ERROR = /^Error:\s*/

const modelErrors: Record<string, readonly [string, string]> = {
  AUTH: ["供應商拒絕授權。請檢查模型與提供商的憑證。", "The provider rejected authorization. Check its credentials in Models and providers."],
  QUOTA: ["供應商額度不足。請查看供應商用量。", "The provider quota is exhausted. Check usage with the provider."],
  RATE_LIMIT: ["供應商暫時限制請求。請稍後重試。", "The provider is rate limiting requests. Try again shortly."],
  CAPACITY: ["所選模型暫時達到容量上限。請稍後重試。", "The model is temporarily at capacity. Try again shortly."],
  CONTEXT_WINDOW_EXCEEDED: ["輸入超過模型的上下文上限。請縮短內容或另開會話。", "The input exceeds the model’s context window. Shorten it or start a new conversation."],
  INVALID_ARGUMENT: ["供應商拒絕這次模型請求。", "The provider rejected this model request."],
  ROUTE_NOT_FOUND: ["供應商找不到模型或 API 端點。請核對模型 ID、網址與通訊協定。", "The provider could not find the model or API endpoint. Check the model ID, URL and protocol."],
  TIMEOUT: ["模型回應逾時。請稍後重試。", "The model response timed out. Try again shortly."],
  TRANSPORT: ["無法連上模型服務。請檢查網路或供應商端點。", "Could not reach the model service. Check the network or provider endpoint."],
  TLS: ["無法建立安全的供應商連線。請檢查端點或憑證設定。", "Could not establish a secure connection. Check the provider endpoint or certificate settings."],
  SERVER: ["供應商服務暫時出錯。請稍後重試。", "The provider service returned an error. Try again shortly."],
  MALFORMED_RESPONSE: ["模型回傳了無法讀取的內容。請查看診斷資料。", "The response could not be read. Open diagnostics for details."],
  EMPTY_RESPONSE: ["模型沒有回傳可顯示的回覆。", "The model returned no displayable response."],
  ABORTED: ["本次生成已停止。", "Generation was stopped."],
}

const known = (value: string, english: boolean): string | undefined => {
  const t = (zh: string, en: string) => english ? en : zh
  if (/SdkTimeoutError|sdk-timeout/i.test(value))
    return t("操作逾時。服務仍可能在處理，請先查看工作狀態。", "The operation timed out. Check its status before retrying because the service may still be working.")
  if (/SdkConnectionError|sdk subprocess exited|sdk-connection/i.test(value))
    return t("桌面服務連線已中斷。請重試或查看診斷記錄。", "The desktop service disconnected. Retry or check the diagnostic log.")
  if (/invalid model protocol/i.test(value))
    return t("無法套用模型協定。請重新選擇模型後重試。", "The model protocol could not be applied. Select the model again and retry.")
  if (/draft changed|draft.*revision conflict/i.test(value))
    return t("草稿版本已變更，目前的輸入仍保留。", "The draft revision changed. Your current input is still here.")
  if (/FACT_RECOVERY_REQUIRED|requires recovery|needs reconciliation|cleanup unresolved/i.test(value))
    return t("工作狀態需要恢復。請重試或重新開啟會話。", "The work state needs recovery. Retry or reopen the conversation.")
  if (/ENOENT|no such file|not found/i.test(value))
    return t("找不到需要的檔案或資源。", "The required file or resource could not be found.")
  if (/EACCES|EPERM|permission denied/i.test(value))
    return t("沒有足夠權限完成此操作。", "This operation requires more permission.")
  if (/aborted|cancelled|canceled/i.test(value))
    return t("操作已取消。", "The operation was cancelled.")
  if (/timeout|timed out/i.test(value))
    return t("操作逾時，請重試。", "The operation timed out. Try again.")
  return undefined
}

export function displayError(input: unknown, { english = false, code, httpStatus }: { english?: boolean; code?: string; httpStatus?: number } = {}): DisplayError {
  const raw = input instanceof Error ? input.message : typeof input === "string" ? input : String(input)
  let text = raw.trim()
  let stripped = false
  for (;;) {
    const next = text.replace(RPC, "").replace(RPC_ERROR, "").replace(ERROR, "")
    if (next === text) break
    stripped = true
    text = next.trim()
  }
  const category = code === "INVALID_API_KEY" ? "AUTH" : code === "INVALID_ARGUMENT" && httpStatus === 404 ? "ROUTE_NOT_FOUND" : code
  const message = category && Object.hasOwn(modelErrors, category) ? modelErrors[category] : undefined
  const friendly = message?.[english ? 1 : 0] ?? known(text, english)
  if (friendly !== undefined) return { summary: friendly, ...(stripped || friendly !== raw ? { detail: raw } : {}) }
  const line = text.split(/\r?\n/)[0]!.trim()
  const summary = line.length > 180 ? line.slice(0, 177) + "…" : line
  if (summary === "") return { summary: english ? "The operation did not finish." : "操作未完成。" }
  return { summary, ...(summary !== raw ? { detail: raw } : {}) }
}
