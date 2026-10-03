import type { EditableSource } from "./SourceFileEditor.tsx"
import { useText } from "../design/i18n.ts"
import { useProjectFilesText } from "./project-files-text.ts"

export function ReadonlyFilePreview({ value }: { value: Extract<EditableSource, { kind: "text" }> }) {
  const pf = useProjectFilesText(), t = useText()
  return <section className="review-text" aria-label={pf("唯讀檔案預覽")}>
    <p className="notice">{pf(value.external ? "專案外檔案僅供唯讀。" : "此檔案僅供唯讀。")}</p>
    {value.truncated ? <p className="notice">{t("檔案過大，僅供預覽，無法儲存")}</p> : null}
    <pre className="tool-output review-code">{value.text}</pre>
  </section>
}
