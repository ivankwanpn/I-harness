import { useLocale } from "../design/i18n.ts"

/** Tool presentation copy stays scoped to the recorded output surfaces. */
export function useToolText() {
  const locale = useLocale(state => state.locale)
  return (zh: string, en: string) => locale === "en" ? en : zh
}
