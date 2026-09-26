import { create } from "zustand"
import { useCallback } from "react"

export type Locale = "zh-TW" | "en"
const english = {
  "關閉成果面板": "Close review pane",
  "調整成果面板寬度": "Resize review pane",
  "會話內容": "Conversation content", "回到最新內容": "Jump to latest", "關閉側欄": "Close sidebar",
  "最小化視窗": "Minimize window", "最大化或還原視窗": "Maximize or restore window", "關閉視窗": "Close window",
  "視窗與通知": "Window and notifications", "背景待處理通知": "Notify when attention is needed",
  "此系統不支援桌面通知。": "Desktop notifications are not supported on this system.", "視窗不在前景時，有審批或問題需要處理便通知。": "Notify about approvals and questions while the window is in the background.",
  "視窗位置與大小": "Window position and size", "關閉時保存，下次啟動恢復。": "Saved on close and restored on the next launch.", "重設視窗": "Reset window",
  "任務": "Tasks", "佇列": "Queue", "回合": "turns", "等候中": "Waiting", "已完成": "Completed", "已失敗": "Failed", "已取消": "Cancelled",
  "佇列狀態未知": "Queue state unavailable", "佇列為空": "Queue is empty", "任務狀態未知": "Task state unavailable", "暫無可確認的任務": "No reported tasks",
  "已修改": "Modified", "已新增": "Added", "已刪除": "Deleted", "未追蹤": "Untracked", "已重新命名": "Renamed",
  "不是 Git 工作區，無法列出變更": "This is not a Git workspace; changes cannot be listed", "找不到 Git，無法列出變更": "Git was not found; changes cannot be listed",
  "儲存庫還沒有任何提交，無法比對": "This repository has no commits to compare against", "未追蹤的檔案沒有 diff": "Untracked files have no diff",
  "二進位內容不顯示": "Binary content is not displayed", "檔案已刪除": "The file was deleted", "沒有差異": "No differences", "找不到檔案": "File not found",
  "沒有可比較的提交": "No commit to compare against", "不是 Git 工作區": "Not a Git workspace", "找不到 Git": "Git not found",
  "無法讀取": "Unable to read", "變更": "Changes", "重新整理": "Refresh", "正在讀取變更…": "Loading changes…", "預覽": "Preview",
  "工作區目前沒有未提交的變更": "No uncommitted changes in this workspace",
  "變更列表已截斷，只顯示前 {count} 筆": "Change list truncated; showing the first {count} files",
  "（已截斷，僅顯示前 {bytes} bytes）": " (truncated to the first {bytes} bytes)",
  "SDK 連線已中斷，送出已停用": "SDK disconnected; sending is disabled",
  "沙箱尚未接線：宿主未回報可執行模式，送出已停用": "The host has not reported an active sandbox; sending is disabled",
  "模型狀態未知，送出已停用": "Model state unavailable; sending is disabled", "正在壓縮上下文": "Compacting context",
  "模型拒絕產生內容": "The model declined to produce content", "輸出達到上限被截斷": "Output was truncated at its limit", "模型回覆為空": "The model returned no content",
  "圖片": "Image", "工具請求": "Tool request", "代理提出問題": "The agent has a question",
  "已選擇會話 {title}": "Selected conversation: {title}", "SDK 連線中斷：{message}": "SDK disconnected: {message}",
  "歷史視窗已載入 {count} 筆；可使用會話搜尋查找其他內容。": "Loaded {count} history events. Use conversation search to find other content.",
  "設定": "Settings", "設定分類": "Settings categories", "一般": "General", "關於": "About", "外觀": "Appearance",
  "深色": "Dark", "淺色": "Light", "跟隨系統": "System", "文字大小": "Text size", "顯示側欄": "Show sidebar",
  "外觀偏好只儲存在此電腦。": "Appearance preferences are stored on this computer only.", "重設外觀偏好": "Reset appearance preferences",
  "本機 Agent 工作台；使用既有後端執行任務。": "A local agent workbench powered by the existing backend.",
  "第三方 UI 程式碼": "Third-party UI code", "部分介面改編自 ZCode，依 Apache-2.0 保留授權與來源說明。": "Parts of the interface are adapted from ZCode under Apache-2.0, with licenses and attribution retained.",
  "壓縮上下文": "Compact context", "整理目前會話的上下文；可能呼叫模型。保留重點可留空。": "Condense this conversation's context; this may call the model. Retention instructions are optional.",
  "希望保留的重點": "What to preserve", "內容超過 4096 bytes，請縮短。": "Instructions exceed 4096 bytes. Please shorten them.",
  "正在壓縮…": "Compacting…", "開始壓縮": "Start compaction", "摘要產生失敗，未完成壓縮。": "Summary generation failed; compaction did not complete.",
  "上下文已整理完成。": "Context processing completed.", "目前沒有需要壓縮的內容。": "There is nothing to compact right now.", "查看摘要": "View summary",
  "搜尋會話": "Search conversations", "搜尋會話內容": "Search conversation content", "清除搜尋": "Clear search",
  "搜尋此工作區已保存的會話內容，最多顯示 50 筆。": "Search saved conversations in this workspace. Up to 50 results are shown.",
  "只搜尋目前會話": "Search only this conversation", "正在搜尋…": "Searching…",
  "結果已截斷，請縮小搜尋範圍。": "Results were truncated. Refine your search.", "沒有符合的會話內容": "No matching conversation content",
  "待人處理": "Needs your attention", "回答": "Answer", "送出回答": "Send answer",
  "尚未回報結果": "Awaiting result", "已收到結果": "Result received", "工具詳情": "Tool details",
  "需要你的確認": "Your confirmation is needed", "選擇回覆": "Choose a response", "批准": "Allow", "拒絕": "Deny",
  "僅允許這一次": "Only this time", "不執行此操作": "Do not perform this action", "選擇後按確認送出": "Choose an option, then confirm",
  "正在送出…": "Submitting…", "確認": "Confirm",
  "工作區記憶": "Workspace memory", "啟用工作區記憶": "Enable workspace memory",
  "筆記保存在此工作區，可供不同會話查找。目前不會自動生成記憶。": "Notes are stored in this workspace for recall across conversations. Automatic memory generation is not available.",
  "搜尋筆記": "Search notes", "搜尋": "Search", "全部筆記": "All notes", "正在讀取…": "Loading…",
  "最多顯示 100 筆；可搜尋其他筆記。": "Showing up to 100 notes. Search to find more.",
  "沒有符合的筆記": "No matching notes", "新增筆記": "New note", "標題": "Title", "內容": "Content", "儲存筆記": "Save note",
  "刪除筆記": "Delete note", "確認刪除此筆記": "Confirm deletion", "取消": "Cancel", "返回會話": "Back to conversation",
  "啟用記憶後才可新增筆記；現有筆記仍可閱讀。": "Enable memory to add notes. Existing notes remain readable.",
  "Enter 送出，Shift+Enter 換行": "Enter to send, Shift+Enter for a new line",
  "工作區": "Workspaces", "新增會話": "New conversation", "開啟工作區": "Open workspace",
  "尚未開啟工作區": "No workspace open", "尚未選擇會話": "No conversation selected",
  "未命名會話": "Untitled conversation", "成果檢查": "Review", "會話": "Conversation",
  "今天想完成甚麼？": "What would you like to work on?", "描述你的目標，從這個工作區開始。": "Describe your goal and start in this workspace.",
  "讓想法成為成果": "Bring your ideas to life", "選擇本機資料夾，開始你的第一個任務。": "Choose a local folder to start your first task.",
  "延續左側的會話，或開始一項新任務。": "Continue a conversation in the sidebar or start a new task.",
  "選擇資料夾": "Choose folder", "開始新任務": "Start a new task", "等待工作區連線": "Waiting for workspace",
  "選擇工作區以檢查檔案變動。": "Choose a workspace to review file changes.", "重試": "Retry",
  "無法取得會話列表": "Conversation list unavailable", "尚無會話": "No conversations yet",
  "執行中": "Running", "最後活動": "Last active", "沙箱": "Sandbox", "唯讀": "Read only",
  "可寫入工作區": "Workspace write", "完整存取": "Full access",
  "提示": "Prompt", "輸入提示…": "Describe a task…", "目前無法送出": "Cannot send right now",
  "送出": "Send", "停止": "Stop", "語言": "Language",
} as const
export type Message = keyof typeof english
function initialLocale(): Locale {
  try { return localStorage.getItem("ih:locale") === "en" ? "en" : "zh-TW" } catch { return "zh-TW" }
}
export const useLocale = create<{ locale: Locale; setLocale(locale: Locale): void }>((set) => ({
  locale: initialLocale(),
  setLocale: (locale) => {
    try { localStorage.setItem("ih:locale", locale) } catch { /* Preference remains usable in memory. */ }
    document.documentElement.lang = locale
    set({ locale })
  },
}))
export function useText(): (message: Message, values?: Record<string, string | number>) => string {
  const locale = useLocale((state) => state.locale)
  return useCallback((message: Message, values: Record<string, string | number> = {}) => (locale === "en" ? english[message] : message).replace(/\{(\w+)\}/g, (token, key: string) => values[key] === undefined ? token : String(values[key])), [locale])
}
