import { useCallback } from "react"
import { useUiStore } from "../shell/ui-store.ts"

const english = {
  "工作流程": "Workflow", "目標與計畫": "Goal and plan", "背景任務": "Background jobs", "代審記錄": "Approval history",
  "重新整理": "Refresh", "正在讀取工作流程…": "Loading workflow…", "重試": "Retry", "更新中…": "Updating…",
  "目標": "Goal", "目標內容": "Objective", "尚未設定目標": "No goal set", "建立目標": "Create goal", "建立並開始": "Create and start",
  "儲存目標": "Save goal", "開始執行目標": "Start goal", "暫停目標": "Pause goal", "繼續目標": "Resume goal", "完成目標": "Complete goal", "清除目標": "Clear goal",
  "目標可在多個回合中持續執行；建立並開始會送出一個新回合。": "A goal can continue across turns. Create and start submits a new turn.",
  "計畫模式": "Plan mode", "計畫內容": "Plan proposal", "套用計畫": "Apply plan", "已啟用": "Enabled", "已停用": "Disabled",
  "計畫模式會限制工具執行；套用內容後，下一個步驟會讀取計畫。": "Plan mode restricts tool execution. The next step reads the applied proposal.",
  "進行中": "Active", "已暫停": "Paused", "已完成": "Completed", "待開始": "Pending", "執行中": "Running", "已取消": "Cancelled", "已失敗": "Failed", "建立中": "Provisioning", "已就緒": "Ready", "閒置": "Idle",
  "修訂 {revision}": "Revision {revision}",
  "目前回合結束後可變更計畫模式。": "Plan mode can be changed after the current turn finishes.",
  "尚無背景任務": "No background jobs", "背景任務 {name}": "Background job {name}", "取消工作": "Cancel job", "查看輸出": "View output", "已儲存狀態，未確認仍在執行": "Saved status; running state is unconfirmed",
  "背景任務輸出": "Job output", "關閉輸出": "Close output", "正在讀取輸出…": "Loading output…", "輸出已截斷": "Output truncated", "此工作尚無輸出": "No output available yet",
  "尚無代審記錄": "No delegated approval reviews", "代審檢查 {name}": "Approval review {name}", "已核准": "Approved", "已拒絕": "Denied", "交由人工決定": "Deferred to human", "已逾時": "Timed out", "格式錯誤": "Malformed result", "檢查失敗": "Review failed", "暫停自動代審": "Delegated approval paused",
  "請求原因": "Request reason", "操作參數": "Arguments", "參數已截斷": "Arguments truncated", "代審模型": "Review model", "沿用主模型": "Inherited model", "決定理由": "Decision rationale", "模型原始決定": "Reviewer decision", "模型理由": "Reviewer rationale", "處理時間": "Duration", "使用既有代審上下文": "Reused reviewer context",
  "重新讀取失敗，請重試後再操作。": "Reload failed. Retry before making another change.",
  "目標已變更；草稿已保留。比較目前目標後再儲存。": "The goal changed. Your draft is preserved. Compare the current goal before saving.",
  "草稿原本的目標": "Original goal for this draft", "保留草稿並採用此目標修訂": "Keep draft and use this goal revision", "捨棄草稿": "Discard draft",
  "計畫已變更；草稿已保留。比較目前計畫後再套用。": "The plan changed. Your draft is preserved. Compare the current plan before applying.",
  "保留草稿並採用此計畫版本": "Keep draft and use this plan version", "尚無計畫內容": "No plan proposal",
  "取消工作失敗；請重新讀取後再試。": "Job cancellation failed. Reload before trying again.", "此工作目前無法取消。": "This job is no longer cancellable.", "關閉確認": "Close confirmation",
  "使用小寫字母和數字，可用連字號分隔；最多 64 字，不可使用 lead。": "Use lowercase letters and digits, optionally separated by hyphens; up to 64 characters. The name lead is reserved.",
  "請按名稱規則修改；目前草稿仍保留。": "Choose a name that follows these rules. Your draft is preserved.",
} as const

export type WorkflowMessage = keyof typeof english
export type WorkflowText = (message: WorkflowMessage, values?: Record<string, string | number>) => string
export function useWorkflowText(): WorkflowText {
  const locale = useUiStore((state) => state.locale)
  return useCallback((message: WorkflowMessage, values?: Record<string, string | number>) => {
    let result: string = locale === "en" ? english[message] : message
    for (const [name, value] of Object.entries(values ?? {})) result = result.replaceAll(`{${name}}`, String(value))
    return result
  }, [locale])
}

export function workflowStatus(value: string, t: WorkflowText): string {
  const statuses: Record<string, WorkflowMessage> = { active: "進行中", paused: "已暫停", complete: "已完成", pending: "待開始", in_progress: "進行中", running: "執行中", completed: "已完成", killed: "已取消", cancelled: "已取消", error: "已失敗", failed: "已失敗", provisioning: "建立中", timeout: "已逾時", malformed: "格式錯誤", operational: "檢查失敗", breaker: "暫停自動代審", approve: "已核准", deny: "已拒絕", allow: "交由人工決定" }
  return statuses[value] ? t(statuses[value]) : value
}
