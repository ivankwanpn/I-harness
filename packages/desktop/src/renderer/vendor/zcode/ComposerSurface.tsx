/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 prompt-editor/ChatPromptEditor.tsx.
 * Modified 2026-09-26: prop slots replace Lexical and service-backed controls.
 * Modified 2026-10-11: IH theme-aware surface and responsive toolbar classes.
 * See packages/desktop/licenses/zcode/README.md.
 */
import type { ReactNode } from "react"
export function ComposerSurface({ editor, leadingActions, trailingActions, error, onSubmit }: {
  editor: ReactNode; leadingActions: ReactNode; trailingActions: ReactNode;
  error?: ReactNode; onSubmit(): void
}) {
  return <div className="zc-composer">
    <form className="relative" onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
      <div className="composer-surface">
        {error ? <div className="zc-composer-error" role="alert">{error}</div> : null}
        {editor}
        <div className="composer-toolbar">
          <div data-composer-leading-actions>
            <div data-composer-leading-content>{leadingActions}</div>
          </div>
          <div data-composer-trailing-actions>{trailingActions}</div>
        </div>
      </div>
    </form>
  </div>
}
