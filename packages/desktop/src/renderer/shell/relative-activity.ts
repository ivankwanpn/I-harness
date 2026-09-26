export function relativeActivity(timestamp: number | string, locale: string, now = Date.now()): string {
  const time = new Date(timestamp).getTime()
  if (!Number.isFinite(time)) return "—"
  const seconds = (time - now) / 1000
  const absolute = Math.abs(seconds)
  const [scale, unit] = absolute < 60 ? [1, "second"] as const
    : absolute < 3600 ? [60, "minute"] as const
      : absolute < 86400 ? [3600, "hour"] as const : [86400, "day"] as const
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(Math.round(seconds / scale), unit)
}
