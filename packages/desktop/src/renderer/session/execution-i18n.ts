import { useCallback } from "react"
import { useUiStore } from "../shell/ui-store.ts"

const english: Record<string, string> = {
  "重新整理": "Refresh", "正在讀取…": "Loading…", "返回": "Back", "活躍": "Live", "歷史": "History", "目前有效模式": "Current effective mode",
  "儲存後套用到新執行環境及新子代理。現有環境與正在執行的 cell 保持原模式。": "Saved changes apply to new execution environments and new subagents. Existing environments and running cells retain their mode.",
  "直接呼叫工具": "Direct tools", "直接工具與程式編排": "Direct tools and code orchestration", "透過程式呼叫工具": "Tools through code", "新設定將於新執行環境生效": "New settings apply to new environments", "目前沒有活躍執行環境": "No live execution environment",
  "執行檢視": "Execution", "已儲存執行記錄": "Saved execution history", "Cell 內容": "Cell contents", "程式": "Code", "輸出": "Output", "巢狀呼叫": "Nested calls", "尚無 Code Mode cell": "No Code Mode cells yet",
  "此記錄未保存程式": "Source was not saved in this record", "此 cell 尚無輸出": "No output from this cell", "已派送": "Dispatched", "未派送": "Not dispatched", "尚無結果": "No result yet", "此 cell 尚無巢狀呼叫": "No nested calls in this cell", "內容已截斷": "Content was truncated",
  "已儲存狀態，未確認仍在執行；無法恢復或停止此 cell。": "Saved state has no live execution owner. This cell cannot be resumed or stopped.", "停止 cell": "Stop cell", "確認停止 cell": "Confirm cell stop", "停止此 cell 及其巢狀呼叫？": "Stop this cell and its nested calls?", "確認停止": "Confirm stop", "較新記錄": "Newer records", "較舊記錄": "Older records",
  "重試": "Retry",
  "工具與環境診斷": "Tools and environment diagnostics", "檢測執行檔版本": "Probe executable versions", "目前活躍環境": "Current live environment", "目前沒有活躍執行環境；工具及角色清單於執行環境建立後可讀。": "No live environment. Tool and role lists become readable after an environment is created.", "實際 Agent Shell": "Actual Agent Shell", "未設定": "Unconfigured", "執行檔與版本": "Executables and versions", "名稱": "Name", "狀態": "Status", "執行檔／版本": "Executable / version", "工具宣告與目前模型可见範圍": "Tool declarations and current model visibility", "工具": "Tool", "宣告曝光": "Declared exposure", "目前模型可見": "Model visible", "是": "Yes", "否": "No", "角色工具 allowlist": "Role tool allowlists", "空 allowlist": "Empty allowlist",
  "Agent 程序與背景工作": "Agent processes and background jobs", "Agent PTY／程序": "Agent PTY / processes", "目前沒有此會話擁有的 PTY 程序": "No PTY processes owned by this conversation", "附接輸出": "Attach output", "終止程序": "Terminate process", "強制終止": "Force termination", "關閉程序": "Close process", "背景工作": "Background jobs", "尚無背景工作": "No background jobs", "已儲存狀態，未確認仍在執行": "Saved state; live execution is unconfirmed", "查看輸出": "View output", "取消工作": "Cancel job", "程序輸出": "Process output", "關閉輸出": "Close output", "尚無輸出": "No output", "較早輸出已離開保留視窗": "Earlier output has left the retained window", "輸出已截斷": "Output was truncated", "讀取後續輸出": "Read subsequent output", "終端輸入": "Terminal input", "送出輸入": "Send input", "欄數": "Columns", "列數": "Rows", "調整 PTY 大小": "Resize PTY", "確認程序操作": "Confirm process action", "確認對此 owner 的程序／工作執行操作？": "Confirm this action on the owner's process or job?", "確認執行": "Confirm action",
}
export function useExecutionText() {
  const locale = useUiStore(state => state.locale)
  return useCallback((message: string) => locale === "en" ? english[message] ?? message : message, [locale])
}
