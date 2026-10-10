/* SPDX-License-Identifier: MIT
 * Adapted from OpenCode 1.18.30 packages/ui/src/v2/components/button-v2.*.
 * React/native semantics, IH tokens, and a disabled loading state are Desktop
 * adaptations. See renderer/design/CONTROL_SOURCES.md for source hashes/notices.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react"

export function Button({ variant = "secondary", size = "normal", icon, className = "", children, type = "button", disabled, loading = false, loadingLabel, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger"
  size?: "small" | "normal"
  icon?: ReactNode
  loading?: boolean
  /** A localized operation label; the ordinary label is retained when omitted. */
  loadingLabel?: string
}) {
  return <button {...props} type={type} disabled={disabled || loading} aria-busy={loading || props["aria-busy"]} className={`oc-button ${className}`} data-variant={variant} data-size={size} data-loading={loading || undefined}>
    {loading ? <span className="oc-button-spinner" aria-hidden="true" /> : icon ? <span className="oc-button-icon" aria-hidden="true">{icon}</span> : null}
    {loading && loadingLabel ? loadingLabel : children}
  </button>
}
