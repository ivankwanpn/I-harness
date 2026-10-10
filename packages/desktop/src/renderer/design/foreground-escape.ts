/* SPDX-License-Identifier: MIT
 * IH popover adaptation of the DSH composition policy documented in CONTROL_SOURCES.md.
 */
/** Nonmodal popovers share the modal layer's composition-safe Escape policy.
 * The visible foreground surface owns dismissal; parent listeners leave its key.
 */
export function listenForegroundEscape(element: HTMLElement | null, close: () => void, blocked: () => boolean = () => false, onTab?: (event: KeyboardEvent) => void): () => void {
  if (!element) return () => {}
  const document = element.ownerDocument
  let composing = false, ended = false
  const start = () => { composing = true }
  const end = () => { composing = false; ended = true }
  const release = () => { ended = false }
  const blur = () => { composing = false; ended = false }
  const visible = (node: HTMLElement) => {
    if (node.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
      const style = document.defaultView?.getComputedStyle(parent)
      if (style?.display === "none" || style?.visibility === "hidden") return false
    }
    return true
  }
  const keydown = (event: KeyboardEvent) => {
    const guarded = composing || ended || event.isComposing || event.keyCode === 229
    ended = false
    if (guarded || !["Escape", "Tab"].includes(event.key) || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
    const foreground = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"]')).filter(visible).at(-1)
    if (foreground !== element || blocked()) return
    if (event.key === "Tab") { onTab?.(event); return }
    if (event.shiftKey || event.repeat) return
    event.preventDefault()
    close()
  }
  document.addEventListener("compositionstart", start, true)
  document.addEventListener("compositionend", end, true)
  document.addEventListener("keyup", release, true)
  document.addEventListener("keydown", keydown)
  document.defaultView?.addEventListener("blur", blur)
  return () => {
    document.removeEventListener("compositionstart", start, true)
    document.removeEventListener("compositionend", end, true)
    document.removeEventListener("keyup", release, true)
    document.removeEventListener("keydown", keydown)
    document.defaultView?.removeEventListener("blur", blur)
  }
}
