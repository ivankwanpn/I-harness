import { useLocale } from "../design/i18n.ts"
import type { NotificationKind } from "../../shared/notification-preferences.ts"

export const notificationLabels = {
  completed: "工作完成", attention: "需要處理", approval: "需要核准", question: "等待回答", error: "執行錯誤",
} as const satisfies Record<NotificationKind, string>

const words = {
  "通知記錄": "Notification history",
  "背景通知": "Background notifications",
  "事件通知": "Notification events",
  "桌面提示": "Desktop alert",
  "提示音": "Sound",
  "系統提示音": "System sound",
  "靜音": "Off",
  "工作完成": "Work completed",
  "需要處理": "Attention needed",
  "執行錯誤": "Execution error",
  "視窗在背景時，依下方事件設定顯示通知或播放提示音。": "Show alerts or play sounds for selected events while the app is in the background.",
  "未讀": "unread",
  "正在讀取…": "Loading…",
  "重新整理通知": "Refresh notifications",
  "全部標為已讀": "Mark all as read",
  "清除通知記錄": "Clear notification history",
  "清除所有通知記錄？": "Clear all notification history?",
  "取消": "Cancel",
  "確認清除": "Confirm clear",
  "尚無通知記錄": "No notifications yet",
  "需要核准": "Approval needed",
  "等待回答": "Waiting for an answer",
  "開啟會話": "Open conversation",
  "標為已讀": "Mark as read",
} as const

export function useNotificationText() {
  const locale = useLocale(state => state.locale)
  return (key: keyof typeof words) => locale === "en" ? words[key] : key
}
