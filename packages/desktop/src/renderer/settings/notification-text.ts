import { useLocale } from "../design/i18n.ts"

const words = {
  "通知記錄": "Notification history",
  "未讀": "unread",
  "正在讀取…": "Loading…",
  "重新整理通知": "Refresh notifications",
  "全部標為已讀": "Mark all as read",
  "清除通知記錄": "Clear notification history",
  "清除所有通知記錄？": "Clear all notification history?",
  "取消": "Cancel",
  "確認清除": "Confirm clear",
  "尚無通知記錄": "No notifications yet",
  "需要確認或回答的通知會保留在這裡。": "Notifications that need your approval or answer are kept here.",
  "需要核准": "Approval needed",
  "等待回答": "Waiting for an answer",
  "開啟會話": "Open conversation",
  "標為已讀": "Mark as read",
} as const

export function useNotificationText() {
  const locale = useLocale(state => state.locale)
  return (key: keyof typeof words) => locale === "en" ? words[key] : key
}
