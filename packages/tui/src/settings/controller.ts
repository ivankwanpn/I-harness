// @i-harness/tui — M49 Task 6: the settings controller.
//
// The controller enforces the preview/commit/rollback discipline one row at a
// time: a definition's read() supplies the CURRENT value, preview() applies
// it live, commit() persists through the definition (settings store /
// provider runtime / backend — the definition owns the write target), and a
// failed commit triggers rollback(previous) before the error rethrows so the
// modal's live state never disagrees with the durable document (spec §12:
// settings persist failure = rollback live preview, keep the editor input).

import type { SettingDefinition, SettingsContext } from "./registry.ts"

export interface SettingsController {
  /** The controller's execution context (settings + providers + backend). */
  context(): SettingsContext
  /** Apply value through the definition for `key`: preview → commit; a
   * commit failure rolls back with the pre-change value and rethrows. */
  commit(key: string, value: unknown): Promise<void>
}

export function createSettingsController(
  defs: readonly SettingDefinition[],
  ctx: SettingsContext,
): SettingsController {
  return {
    context: () => ctx,
    async commit(key, value) {
      const def = defs.find((d) => d.key === key)
      if (def === undefined) throw new Error(`settings row "${key}" is not defined`)
      const previous = def.read(ctx)
      def.preview?.(ctx, value)
      try {
        await def.commit(ctx, value)
      } catch (error) {
        def.rollback?.(ctx, previous)
        throw error
      }
    },
  }
}
