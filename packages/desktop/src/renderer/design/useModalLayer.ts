/* SPDX-License-Identifier: MIT
 * Adapted from DSH 0.2.0-rc.2 ui-primitives useModalLayer.ts and
 * keyboard-composition.ts. IH adds background inert lifetime, hidden-control
 * filtering, busy ownership, and out-of-order focus restoration.
 * See CONTROL_SOURCES.md for source hashes and the retained MIT notice.
 */
import { useLayoutEffect, useRef, type RefObject } from "react"

interface Layer {
  element: HTMLElement
  overlay: HTMLElement
  previous: Element | null
}

const layers = new WeakMap<Document, Layer[]>()
const inertRoots = new WeakMap<Element, { count: number; wasInert: boolean }>()
const modalSelector = '[role="dialog"][aria-modal="true"], [role="menu"]'
const focusableSelector = 'button, a[href], input, select, textarea, summary, [tabindex], [contenteditable="true"]'

function available(element: HTMLElement): boolean {
  if (element.closest('[inert], [hidden], [aria-hidden="true"]')) return false
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(ancestor)
    if (style?.display === "none" || style?.visibility === "hidden") return false
    // Each closed disclosure hides its content, including nested summaries.
    if (ancestor.matches("details:not([open])") && ancestor.querySelector(":scope > summary")?.contains(element) !== true) return false
  }
  return true
}

function focusable(element: HTMLElement): boolean {
  return available(element) && !element.matches(":disabled, input[type='hidden']") && element.tabIndex >= 0
}

function controls(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>(focusableSelector)).filter(focusable)
}

function foreground(element: HTMLElement): boolean {
  const document = element.ownerDocument
  if (layers.get(document)?.at(-1)?.element !== element) return false
  // An unregistered foreground dialog or portaled menu owns its own keys.
  return Array.from(document.querySelectorAll<HTMLElement>(modalSelector)).filter(available).at(-1) === element
}

function isolate(background: Element | null): () => void {
  if (!background) return () => {}
  const state = inertRoots.get(background) ?? { count: 0, wasInert: background.hasAttribute("inert") }
  state.count += 1
  inertRoots.set(background, state)
  background.setAttribute("inert", "")
  return () => {
    state.count -= 1
    if (state.count !== 0) return
    if (!state.wasInert) background.removeAttribute("inert")
    inertRoots.delete(background)
  }
}

function updateLayers(stack: Layer[]): void {
  for (const [index, layer] of stack.entries()) {
    const active = index === stack.length - 1
    layer.overlay.toggleAttribute("inert", !active)
    if (active) layer.overlay.removeAttribute("aria-hidden")
    else layer.overlay.setAttribute("aria-hidden", "true")
    layer.overlay.style.zIndex = String(110 + index)
  }
}

/** Only the foreground modal owns dismissal and traversal. A nested menu may
 * consume its event before the document listener. Entry and return preserve
 * scroll position; callers may restore a replacement trigger after list reload. */
export function useModalLayer(dialog: RefObject<HTMLElement | null>, options: {
  initialFocusSelector: string
  busy: boolean
  active?: boolean
  onClose(): void
}): () => void {
  const current = useRef(options)
  current.current = options
  const active = options.active ?? true
  const requestClose = () => {
    const element = dialog.current
    if (current.current.active !== false && element && foreground(element) && !current.current.busy) current.current.onClose()
  }

  useLayoutEffect(() => {
    if (!active) return
    const element = dialog.current
    if (!element) return
    const document = element.ownerDocument
    const stack = layers.get(document) ?? []
    layers.set(document, stack)
    const layer: Layer = { element, overlay: element.parentElement ?? element, previous: document.activeElement }
    stack.push(layer)
    const background = document.querySelector("#root") ?? document.querySelector(".settings-pane")
    const releaseBackground = isolate(background?.contains(element) ? null : background)
    updateLayers(stack)
    const initial = element.querySelector<HTMLElement>(current.current.initialFocusSelector)
    const target = initial && focusable(initial) ? initial : controls(element)[0] ?? element
    if (!element.contains(document.activeElement)) target.focus({ preventScroll: true })

    let composing = false, ended = false
    const start = () => { composing = true }
    const end = () => { composing = false; ended = true }
    const release = () => { ended = false }
    const blur = () => { composing = false; ended = false }
    document.addEventListener("compositionstart", start, true)
    document.addEventListener("compositionend", end, true)
    document.addEventListener("keyup", release, true)
    document.defaultView?.addEventListener("blur", blur)

    const keydown = (event: KeyboardEvent) => {
      if (!foreground(element)) return
      const guarded = composing || ended || event.isComposing || event.keyCode === 229
      ended = false
      if (guarded || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
      if (event.key === "Escape" && !event.shiftKey) {
        event.preventDefault()
        if (!event.repeat) requestClose()
        return
      }
      if (event.key !== "Tab" || document.activeElement?.closest('[role="menu"]')) return
      const items = controls(element)
      const first = items[0] ?? element, last = items.at(-1) ?? element
      const atEdge = event.shiftKey ? document.activeElement === first : document.activeElement === last
      if (document.activeElement === element || !element.contains(document.activeElement) || atEdge) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target.focus({ preventScroll: true })
      }
    }
    document.addEventListener("keydown", keydown)

    return () => {
      const wasTop = stack.at(-1) === layer
      // If a lower preview closes first, its editor inherits the original trigger.
      for (const other of stack) if (other !== layer && layer.element.contains(other.previous)) other.previous = layer.previous
      stack.splice(stack.indexOf(layer), 1)
      document.removeEventListener("keydown", keydown)
      document.removeEventListener("compositionstart", start, true)
      document.removeEventListener("compositionend", end, true)
      document.removeEventListener("keyup", release, true)
      document.defaultView?.removeEventListener("blur", blur)
      releaseBackground()
      updateLayers(stack)
      if (stack.length === 0) layers.delete(document)
      if (!wasTop) return
      const previous = layer.previous instanceof HTMLElement && layer.previous.isConnected && focusable(layer.previous) ? layer.previous : undefined
      const remaining = stack.at(-1)?.element
      const restore = previous && (!remaining || remaining.contains(previous)) ? previous : remaining
      restore?.focus({ preventScroll: true })
    }
  }, [dialog, active])
  return requestClose
}
