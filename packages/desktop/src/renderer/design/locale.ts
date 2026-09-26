export type Locale = "zh-TW" | "en"
export function resolveLocale(saved: unknown, languages: readonly string[]): Locale {
  if (saved === "zh-TW" || saved === "en") return saved
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-TW"
    if (/^en(?:-|$)/i.test(language)) return "en"
  }
  return "en"
}
