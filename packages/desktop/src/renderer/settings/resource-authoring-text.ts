import { useCallback } from "react"
import { useLocale, useText, type Message } from "../design/i18n.ts"
const english = {
  "專案": "Project", "開啟專案": "Open project", "未分類會話": "Ungrouped conversations", "尚未開啟專案": "No project open", "選擇來源資料夾": "Choose source folder",
  "不支援的 Hook 格式": "Unsupported hook format", "Hook 設定無效": "Invalid hook configuration", "Claude 插件格式": "Claude plugin format",
  "來源：{source}": "Source: {source}", "格式：{format}": "Format: {format}",
  "此插件使用 Claude Hooks 格式。I-harness 目前支援原生 v1 設定；其他插件功能仍可使用。": "This plugin uses the Claude hook format. I-harness currently supports native v1 configuration; other plugin capabilities remain available.",
  "此本機設定使用不支援的 Claude Hooks 格式，請改用原生 v1 設定。": "This local configuration uses the unsupported Claude hook format. Use native v1 configuration.",
  "請修正設定後重新套用 Hooks。": "Correct the configuration and reapply hooks.",
  "尚未建立筆記": "No notes yet", "重新讀取筆記": "Reload note",
  "筆記已變更；已保留。請重新讀取後再決定是否刪除。": "The note changed and was retained. Reload it before deciding whether to delete it.",
  "批次刪除（{count}）": "Forget selected ({count})", "清除選取": "Clear selection", "確認刪除選取筆記": "Confirm forgetting selected notes",
  "永久刪除選取筆記；若其中一筆已變更，整批會保留。": "Permanently forget selected notes. If a note changed, the entire batch is retained.",
  "筆記已變更；整批已保留。請重新讀取後選取。": "A note changed. The entire batch is retained. Reload and select again.",
  "未收到已刪除的結果": "Deletion was not confirmed by the backend", "選取 {title}": "Select {title}", "編輯筆記": "Edit note",
  "筆記已變更；草稿已保留。請重新讀取並比較內容。": "The note changed. Your draft is retained. Reload and compare the content.",
  "未收到已保存的結果": "The backend did not confirm a saved result", "儲存變更": "Save changes",
  "來源已變更；草稿已保留。請關閉編輯並重新讀取來源，再比較內容。": "The source changed. Your draft is retained. Close the editor, reload the source, and compare the content.",
  "本機 Hooks 編輯器": "Local hook editor", "保存位置": "Save location",
  "保存設定或腳本會取消此本機設定的內容信任，需重新審查及授權。Hook 只有通過後端信任檢查才可執行。": "Saving a configuration or script invalidates this local configuration's grant. Review and approve it again. Hooks run only after passing backend trust checks.",
  "Hooks 設定 JSON": "Hook configuration JSON",
  "使用 version: 1 及 handlers；trust.script 指向 scripts/名稱.cjs，trust.sha256 使用下方保存後的完整雜湊。": "Use version: 1 and handlers. Point trust.script to scripts/name.cjs and use the complete saved hash below for trust.sha256.",
  "驗證並保存 Hooks": "Validate and save hooks", "腳本名稱": "Script name", "讀取或建立腳本": "Read or create script", "Hook 腳本內容": "Hook script content", "保存腳本": "Save script", "保存後的 SHA-256：": "Saved SHA-256: ",
  "關閉本機 Hooks 編輯器": "Close local hook editor", "編輯本機 Hooks": "Edit local hooks", "目前有效的 Hooks": "Effective hooks",
  "資源編輯器": "Resource editor", "複製插件到本機": "Copy plugin content locally", "編輯本機內容": "Edit local content", "建立資源": "Create resource",
  "尚未建立技能": "No skills yet", "尚未建立命令": "No commands yet",
  "參數的 JSON 格式有誤；請使用字串陣列。": "Arguments contain invalid JSON. Use an array of strings.",
  "參數必須是 JSON 字串陣列。": "Arguments must be a JSON array of strings.",
  "進階設定的 JSON 格式有誤；請使用物件。": "Advanced settings contain invalid JSON. Use an object.",
  "此內容會建立本機版本，來源插件仍可辨識。": "This creates a local version with the source plugin still identified.", "名稱": "Name", "完整 Markdown（含 frontmatter）": "Complete Markdown (including frontmatter)",
  "最多 128 KiB；技能需含相符名稱及描述的 frontmatter。": "Maximum 128 KiB. Skills require frontmatter with a matching name and description.",
  "儲存資源": "Save resource", "保留草稿並關閉": "Keep draft and close", "移除本機版本": "Remove local version", "確認移除本機版本": "Confirm removing local version",
  "移除此本機版本後，可能重新顯示同名插件或全域版本。": "Removing this local version may reveal a plugin or global version with the same name.",
  "匯入 SKILL.md": "Import SKILL.md", "關閉資源編輯器": "Close resource editor",
  "重新讀取來源以比較": "Reload source for comparison", "保留草稿並採用此來源修訂": "Keep draft and use this source revision", "目前來源內容": "Current source content",
  "重新讀取 Hooks 以比較": "Reload hooks for comparison", "重新讀取腳本以比較": "Reload script for comparison", "保留草稿並採用此設定修訂": "Keep draft and use this configuration revision", "保留草稿並採用此腳本修訂": "Keep draft and use this script revision",
  "保留草稿並採用此筆記修訂": "Keep draft and use this note revision", "目前保存的筆記": "Currently saved note",
  "被同名資源覆蓋": "Shadowed by another source",
  "目前執行使用其他來源的同名項目。此版本仍可編輯或複製。": "Execution uses a version from another source with the same name. You can edit or copy this version.",
  "顯示有效命令；同名項目的優先順序為工作區、插件、全域。帶入輸入框後由你送出。": "Shows effective commands, with workspace precedence over plugins and global commands. Insert into the composer and send when ready.",
} as const
type AuthoringMessage = Message | keyof typeof english
export function useAuthoringText() {
  const base = useText(), locale = useLocale(state => state.locale)
  return useCallback((message: AuthoringMessage, values: Record<string, string | number> = {}) => {
    if (!(message in english)) return base(message as Message, values)
    const text = locale === "en" ? english[message as keyof typeof english] : message
    return text.replace(/\{(\w+)\}/g, (token, key: string) => values[key] === undefined ? token : String(values[key]))
  }, [base, locale])
}
