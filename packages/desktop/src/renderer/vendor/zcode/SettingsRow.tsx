/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 settings/SettingsPageParts.tsx.
 * Modified: prop-only native group, responsive control width; no service imports.
 */
import type { ReactNode } from "react"
export function SettingsRow({ label, description, control, detail }: { label: string; description?: string; control: ReactNode; detail?: ReactNode }) {
  return <div className="zc-settings-row border-t border-border px-4 py-3 first:border-t-0">
    <div className="zc-settings-row-grid grid items-center gap-4">
      <div className="min-w-0"><div className="text-ui-base font-medium text-foreground">{label}</div>
        {description ? <div className="mt-1 text-ui-base leading-6 text-foreground-subtle">{description}</div> : null}
      </div>
      <div className="flex w-full flex-nowrap items-center justify-end gap-2">{control}</div>
    </div>
    {detail ? <div className="mt-3 min-w-0">{detail}</div> : null}
  </div>
}
export function SettingsGroup({ children }: { children: ReactNode }) {
  return <div className="zc-settings-group overflow-hidden rounded-xl border border-border bg-card py-0 shadow-none"><div className="space-y-0 px-0">{children}</div></div>
}
