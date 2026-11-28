export const notificationKinds = ["completed", "attention", "approval", "question", "error"] as const
export type NotificationKind = typeof notificationKinds[number]
export type NotificationRule = { enabled: boolean; sound: "system" | "off" }
export type NotificationRules = Record<NotificationKind, NotificationRule>
export type NotificationRuleChange = { event: NotificationKind } & Partial<NotificationRule>

export function isNotificationKind(value: unknown): value is NotificationKind {
  return notificationKinds.some(kind => kind === value)
}

export function readNotificationRules(saved?: unknown): NotificationRules {
  function rule(kind: NotificationKind): NotificationRule {
    const value = (saved as Partial<NotificationRules> | undefined)?.[kind]
    const legacy = kind === "approval" || kind === "question"
    return {
      enabled: typeof value?.enabled === "boolean" ? value.enabled : legacy,
      sound: value?.sound === "system" || value?.sound === "off" ? value.sound : legacy ? "system" : "off",
    }
  }
  return { completed: rule("completed"), attention: rule("attention"), approval: rule("approval"), question: rule("question"), error: rule("error") }
}

export function parseNotificationRuleChange(input: unknown): NotificationRuleChange {
  const value = input as Partial<NotificationRuleChange> | null
  if (!isNotificationKind(value?.event) || (value.enabled === undefined && value.sound === undefined)
    || (value.enabled !== undefined && typeof value.enabled !== "boolean")
    || (value.sound !== undefined && value.sound !== "off" && value.sound !== "system")) throw new Error("Invalid notification preference")
  return { event: value.event, ...(value.enabled !== undefined ? { enabled: value.enabled } : {}), ...(value.sound !== undefined ? { sound: value.sound } : {}) }
}
