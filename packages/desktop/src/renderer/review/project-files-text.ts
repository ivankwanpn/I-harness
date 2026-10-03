import { useLocale } from "../design/i18n.ts"

// Kept with this slice so parallel central dictionary edits do not conflict.
const english: Record<string, string> = {
  "專案檔案": "Project files", "專案檔案與編輯": "Project files and editor", "重新整理專案檔案": "Refresh project files",
  "專案檔案樹": "Project file tree", "搜尋專案檔名": "Search project filenames", "搜尋檔名或相對路徑": "Search filename or relative path",
  "正在讀取檔案…": "Loading files…", "載入更多檔案": "Load more files", "載入更多搜尋結果": "Load more search results",
  "檔案掃描已達上限；請縮小檔名搜尋。": "The file scan reached its limit. Narrow the filename search.", "搜尋已達掃描上限。": "Search reached the scan limit.",
  "來源檔案分頁": "Source file tabs", "已移出": "Removed", "關閉 {path}": "Close {path}", "關閉未儲存檔案 {path}": "Close unsaved file {path}", "{path} 有未儲存內容。": "{path} has unsaved changes.",
  "儲存並關閉": "Save and close", "保留草稿並關閉": "Keep draft and close", "捨棄草稿並關閉": "Discard draft and close", "取消": "Cancel",
  "未能儲存；分頁和草稿已保留。": "Save failed. The tab and draft have been kept.", "從檔案樹或搜尋開啟檔案。": "Open a file from the tree or filename search.",
  "資料夾已移出目前專案；草稿已保留，無法讀取或儲存。": "This folder was removed from the current project. Its draft is kept; reading and saving are unavailable.",
  "正在確認完整檔案版本；草稿已保留。": "Checking the complete file revision. Your draft is kept.", "無法讀取檔案 ({reason})；草稿已保留。": "Cannot read file ({reason}). Your draft is kept.",
  "重新讀取未儲存檔案": "Reload unsaved file", "重新讀取前選擇如何處理未儲存內容。": "Choose how to handle unsaved changes before reloading.",
  "保留草稿並讀取外部版本": "Keep draft and read external version", "捨棄草稿並重新讀取": "Discard draft and reload",
  "檢視外部版本": "View external version", "已合併變更，使用此版本作為儲存基準": "Changes merged; use this revision as the save base", "捨棄草稿並採用外部版本": "Discard draft and use external version",
  "檔案已在外部變更，編輯內容已保留。請重新讀取後合併變更。": "The file changed externally. Your edits have been kept. Reload and merge the changes.",
}
export function useProjectFilesText() {
  const locale = useLocale((state) => state.locale)
  return (message: string, values: Record<string, string> = {}) => (locale === "en" ? english[message] ?? message : message).replace(/\{(\w+)\}/g, (token, key: string) => values[key] ?? token)
}
