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

const known = (value: string): string | undefined => {
  if (/SdkConnectionError|sdk subprocess exited|sdk-connection/i.test(value))
    return "桌面服務連線已中斷。請重試；若持續發生，請查看診斷記錄。"
  if (/FACT_RECOVERY_REQUIRED|requires recovery|needs reconciliation|cleanup unresolved/i.test(value))
    return "工作狀態需要恢復。請重試；若持續發生，請重新開啟會話或工作區。"
  if (/ENOENT|no such file|not found/i.test(value))
    return "找不到需要的檔案或資源。"
  if (/EACCES|EPERM|permission denied/i.test(value))
    return "沒有足夠權限完成此操作。"
  if (/aborted|cancelled|canceled/i.test(value))
    return "操作已取消。"
  if (/timeout|timed out/i.test(value))
    return "操作逾時，請重試。"
  return undefined
}

export function displayError(input: unknown): DisplayError {
  const raw = input instanceof Error ? input.message : typeof input === "string" ? input : String(input)
  let text = raw.trim()
  let stripped = false
  for (;;) {
    const next = text.replace(RPC, "").replace(RPC_ERROR, "").replace(ERROR, "")
    if (next === text) break
    stripped = true
    text = next.trim()
  }
  const friendly = known(text)
  if (friendly !== undefined) return { summary: friendly, ...(stripped || friendly !== raw ? { detail: raw } : {}) }
  const line = text.split(/\r?\n/)[0]!.trim()
  const summary = line.length > 180 ? line.slice(0, 177) + "…" : line
  if (summary === "") return { summary: "操作未完成，請重試。" }
  return { summary, ...(summary !== raw ? { detail: raw } : {}) }
}
