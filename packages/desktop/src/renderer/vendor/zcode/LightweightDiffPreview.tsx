/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 components/ui/lightweight-diff-preview.tsx.
 * Modified: accepts raw unified diff, keeps metadata neutral and protocol markers
 * visible, omits synthetic line numbers and ZCode settings/i18n dependencies.
 */
import { useMemo } from "react"

export function LightweightDiffPreview({ text }: { text: string }) {
  const lines = useMemo(() => {
    let inHunk = false
    return text.split("\n").map((line) => {
      if (line.startsWith("diff --git ")) inHunk = false
      if (line.startsWith("@@")) { inHunk = true; return { line, kind: "context" } }
      const kind = !inHunk ? "context" : line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context"
      return { line, kind }
    })
  }, [text])
  return <div className="zc-diff w-full min-w-0 overflow-auto bg-background" data-lightweight-diff-preview>
    <div className="min-w-full w-max font-mono leading-relaxed text-foreground" style={{ fontSize: 12 }}>
      {lines.map(({ line, kind }, index) => {
        const color = kind === "added" ? "var(--color-diff-added)" : "var(--color-diff-removed)"
        return <div className="flex min-w-full w-full" key={index} style={kind === "context" ? undefined : {
          backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
          boxShadow: `inset 3px 0 0 ${color}`,
        }}><code className="block flex-1 px-3 whitespace-pre">{line || " "}</code></div>
      })}
    </div>
  </div>
}
