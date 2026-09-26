/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 settings/SettingsSearchInput.tsx.
 * Modified: native input/button and props replace upstream UI helpers.
 */
import { Search, X } from "lucide-react"
import type { ComponentProps } from "react"
export function SearchInput({ clearLabel, onClear, ...props }: ComponentProps<"input"> & { clearLabel: string; onClear(): void }) {
  return <div className="zc-search relative">
    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" aria-hidden />
    <input {...props} type="search" className="zc-search-input h-9 rounded-xl pl-9 pr-9" />
    {props.value && !props.disabled ? <button type="button" className="zc-search-clear absolute right-1 top-1/2 -translate-y-1/2 rounded-full text-foreground-subtle" aria-label={clearLabel} onClick={onClear}><X size={14} aria-hidden /></button> : null}
  </div>
}
