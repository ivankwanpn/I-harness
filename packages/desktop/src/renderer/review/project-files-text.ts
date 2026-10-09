import { useLocale } from "../design/i18n.ts"

// Kept with this slice so parallel central dictionary edits do not conflict.
const english: Record<string, string> = {
  "關閉對話框": "Close dialog", "正在搜尋檔案…": "Searching files…", "沒有符合的檔案": "No matching files",
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
  "專案搜尋類型": "Project search type", "檔案名稱": "Filename", "檔案內容": "File content", "專案內容搜尋": "Project content search",
  "搜尋檔案內容": "Search file content", "搜尋專案檔案內容": "Search project file content", "輸入內容後按 Enter 搜尋": "Enter content, then press Enter to search", "搜尋內容": "Search content", "停止搜尋": "Stop search",
  "正規表示式": "Regular expression", "區分大小寫": "Case sensitive", "搜尋資料夾": "Search folders", "目前專案所有資料夾": "All current project folders",
  "進階搜尋選項": "Advanced search options", "包含路徑": "Include paths", "排除路徑": "Exclude paths", "每行一個 glob；最多 16 筆。": "One glob per line, up to 16.",
  "前文行數": "Lines before", "後文行數": "Lines after", "結果數量上限": "Result limit", "包含隱藏檔案": "Include hidden files", "專案忽略檔": "Project ignore files",
  "套用專案內 .gitignore、.ignore、.rgignore；固定排除 .git 與 node_modules。": "Apply project .gitignore, .ignore and .rgignore files. .git and node_modules are always excluded.",
  "跨行搜尋": "Multiline search", "正規表示式引擎": "Regex engine", "內容編碼": "Content encoding", "目前後端未提供專案內容搜尋。": "This backend does not provide project content search.",
  "搜尋中…": "Searching…", "正在停止搜尋…": "Stopping search…", "搜尋結果摘要": "Search result summary", "搜尋完成": "Search completed", "已達上限": "Limit reached", "已取消": "Cancelled", "搜尋逾時": "Search timed out", "搜尋失敗": "Search failed", "部分結果": "Partial results", "結果已截斷": "Results truncated",
  "已回傳 {count} 筆；本地第 {page}/{pages} 頁。": "{count} results returned; local page {page}/{pages}.",
  "候選 {candidate} · 已嘗試 {attempted} · 已讀取 {read} · 完整 {completed} · 已確認 EOF {eof} · 內容 {bytes} bytes": "Candidates {candidate} · attempted {attempted} · read {read} · complete {completed} · proven EOF {eof} · content {bytes} bytes",
  "實際篩選": "Effective filters", "排除隱藏檔案": "Hidden files excluded", "不套用專案忽略檔": "Project ignore files disabled", "套用專案忽略檔": "Project ignore files applied", "篩選與限制詳情": "Filter and limit details",
  "沒有符合的內容。": "No matching content.", "搜尋未涵蓋全部內容；請縮小範圍或重新搜尋。": "The search did not cover all content. Narrow the scope or search again.", "內容已截斷": "Text truncated", "前後文": "Context",
  "本地搜尋結果頁面": "Local result pages", "上一頁搜尋結果": "Previous result page", "下一頁搜尋結果": "Next result page", "頁面僅切換本次已回傳結果；重新搜尋會讀取目前檔案。": "Pages show this returned result set. A new search reads the current files.",
  "請輸入有效搜尋內容（最多 4096 字元）。": "Enter a valid pattern (up to 4096 characters).", "搜尋數量或前後文行數超出範圍。": "The result limit or context count is out of range.", "路徑篩選最多 16 筆，每筆 512 字元。": "Path filters allow up to 16 entries of 512 characters each.", "此資料夾已移出目前專案。": "This folder was removed from the current project.",
  "搜尋位置來自磁碟；未儲存草稿的位置可能不同。": "Search positions come from disk; positions in an unsaved draft may differ.", "檔案已在搜尋後變更；標示位置可能不同。": "The file changed after the search; marked positions may differ.",
  "唯讀搜尋預覽": "Read-only search preview", "僅顯示有界預覽視窗；無法儲存。": "A bounded preview window is shown. Saving is unavailable.", "搜尋行未在此預覽視窗中；已顯示最近可讀取位置。": "The searched line is outside this preview window. The nearest readable position is shown.",
  "未回報完整篩選設定": "The effective filters were not fully reported", "路徑篩選合計最多 4096 字元。": "Path filters allow up to 4096 characters in total.",
  "唯讀檔案預覽": "Read-only file preview", "專案外檔案僅供唯讀。": "This file is outside the project and is read-only.", "此檔案僅供唯讀。": "This file is read-only.", "專案外檔案僅供唯讀；草稿已保留。": "This file is outside the project and is read-only. Your draft is kept.", "此檔案僅供唯讀；草稿已保留。": "This file is read-only. Your draft is kept.", "專案外唯讀": "External, read-only", "唯讀": "Read-only",
  "參考位置（唯讀）": "Reference location (read-only)", "貼上絕對檔案或資料夾路徑；此搜尋只讀取參考位置，不會加入專案。": "Paste an absolute file or folder path. This search reads only that reference location without adding it to the project.", "參考位置需要絕對檔案或資料夾路徑。": "The reference location requires an absolute file or folder path.", "唯讀參考位置": "Read-only reference location", "唯讀參考檔案": "Read-only reference file", "關閉唯讀參考檔案": "Close read-only reference file", "重新讀取唯讀檔案": "Reload read-only file", "唯讀開啟 {path}": "Open {path} read-only",
}
export function useProjectFilesText() {
  const locale = useLocale((state) => state.locale)
  return (message: string, values: Record<string, string> = {}) => (locale === "en" ? english[message] ?? message : message).replace(/\{(\w+)\}/g, (token, key: string) => values[key] ?? token)
}
