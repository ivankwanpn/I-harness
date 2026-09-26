/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 prompt-editor/ChatPromptEditor.tsx.
 * Modified 2026-09-26: prop slots replace Lexical and service-backed controls.
 * See packages/desktop/licenses/zcode/README.md.
 */
import type { ReactNode } from "react"
export function ComposerSurface({ editor, leadingActions, trailingActions, error, onSubmit }: {
  editor: ReactNode; leadingActions: ReactNode; trailingActions: ReactNode;
  error?: ReactNode; onSubmit(): void
}) {
  return <div className="zc-composer">
    {error ? <div className="zc-composer-error" role="alert">{error}</div> : null}
    <form className="relative" onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
      <div className="relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused">
        {editor}
        <div className="group/toolbar flex items-end gap-3">
          <div className="flex min-w-0 flex-1 items-center" data-composer-leading-actions>
            <div className="flex min-w-0 items-center gap-1" data-composer-leading-content>{leadingActions}</div>
          </div>
          <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5" data-composer-trailing-actions>{trailingActions}</div>
        </div>
      </div>
    </form>
  </div>
}
