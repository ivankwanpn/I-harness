import { useLocale } from "../design/i18n.ts"
const words = { "已截斷": "Truncated", "未送出附件保留 7 天；本機草稿上限 128 MiB。": "Unsent attachments are kept for 7 days; local draft storage is limited to 128 MiB.", "草稿儲存失敗；目前輸入仍保留。": "Draft persistence failed; your current input is retained.", "影片保留原檔案位置；分析完成前請勿移動或刪除。": "Videos stay at their original location; keep the files there until analysis finishes." } as const
export function useAttachmentText() { const locale = useLocale((state) => state.locale); return (key: keyof typeof words) => locale === "en" ? words[key] : key }
