/* SPDX-License-Identifier: MIT
 * Adapted from opencode packages/ui/src/components/button.tsx (999.0.15).
 * Rewritten for React native buttons; visual tokens follow this Desktop's
 * ZCode-inspired dark theme. No Solid/Kobalte runtime is included.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react"

export function Button({ variant = "secondary", size = "normal", icon, className = "", children, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost"
  size?: "small" | "normal"
  icon?: ReactNode
}) {
  return <button {...props} type={type} className={`oc-button ${className}`} data-variant={variant} data-size={size}>
    {icon ? <span className="oc-button-icon" aria-hidden="true">{icon}</span> : null}{children}
  </button>
}
