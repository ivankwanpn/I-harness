/* SPDX-License-Identifier: MIT
 * DSH 0.2.0-rc.2 use-copy-feedback, adapted with pending/error feedback,
 * cleanup and capture-change guards. See TOOL_OUTPUT_SOURCES.md.
 */
import { useEffect, useRef, useState } from "react"
import { useToolText } from "./tool-text.ts"

export function useOutputCopy(text: string, getCopyText?: () => string) {
  const t = useToolText()
  const [state, setState] = useState<"idle" | "pending" | "copied">("idle")
  const [error, setError] = useState<string>()
  const request = useRef(0), feedback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    request.current++; setState("idle"); setError(undefined)
    if (feedback.current) clearTimeout(feedback.current)
    return () => { request.current++; if (feedback.current) clearTimeout(feedback.current) }
  }, [text])
  async function copy() {
    const current = ++request.current
    setState("pending"); setError(undefined)
    try {
      if (!navigator.clipboard?.writeText) throw new Error(t("剪貼簿不可用", "Clipboard unavailable"))
      await navigator.clipboard.writeText(getCopyText ? getCopyText() : text)
      if (current !== request.current) return
      setState("copied")
      feedback.current = setTimeout(() => { if (current === request.current) setState("idle") }, 1800)
    } catch (reason) {
      if (current !== request.current) return
      setState("idle")
      setError(`${t("複製失敗", "Could not copy")}: ${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }
  return { state, error, copy }
}
