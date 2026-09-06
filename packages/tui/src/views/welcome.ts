// @i-harness/tui — Welcome shell and model gate presentation.
// The hero keeps the established <=120-col / 90-col split; the prompt and
// model status are part of the same top-level view so startup can paint before
// model resolution without creating or opening a session.

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { BackendModelState } from "../contracts.ts"
import type { PromptState } from "./prompt.ts"
import { renderPrompt } from "./prompt.ts"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import { strWidth } from "./status.ts"

export type WelcomeAction = "new" | "resume" | "settings" | "quit"
export type WelcomeModelState = BackendModelState | { status: "loading" }

export interface WelcomeState {
  version: string
  menus: Array<{ action: WelcomeAction; key: string; label: string }>
  cursor: number
  modelState: WelcomeModelState
  startupError?: string
}

export interface WelcomeLayout {
  error: Rect
  hero: Rect
  prompt: Rect
  modelStatus: Rect
  nextContent: Rect
}

export const WELCOME_SUBTITLE = "Thanks for trying I-harness, give feedback with /feedback!"
export const WELCOME_WIDE_MIN = 90
export const WELCOME_BOX_MAX_W = 120

function modelError(state: WelcomeState): string | undefined {
  if (state.startupError !== undefined && state.startupError.trim() !== "") return state.startupError
  return state.modelState.status === "invalid" || state.modelState.status === "unconfigured"
    ? state.modelState.reason
    : undefined
}

export function layoutWelcome(ctx: Rect, state: WelcomeState, _prompt: PromptState): WelcomeLayout {
  const wide = ctx.w >= WELCOME_WIDE_MIN
  const contentW = Math.min(WELCOME_BOX_MAX_W, Math.max(20, ctx.w - 4))
  const contentX = ctx.x + Math.max(0, Math.floor((ctx.w - contentW) / 2))
  const top = ctx.y + (ctx.h > 8 ? 1 : 0)
  const errorText = modelError(state)
  const error: Rect = { x: contentX, y: top, w: contentW, h: errorText === undefined ? 0 : 1 }
  const heroY = top + (error.h > 0 ? 2 : 0)
  const heroH = 2 + (wide ? Math.max(2, state.menus.length) : 2 + state.menus.length)
  const hero: Rect = { x: contentX, y: heroY, w: contentW, h: heroH }
  const prompt: Rect = { x: contentX, y: hero.y + hero.h + 1, w: contentW, h: 3 }
  const modelStatus: Rect = { x: contentX, y: prompt.y + prompt.h, w: contentW, h: 1 }
  const nextContent: Rect = { x: contentX, y: modelStatus.y + 1, w: contentW, h: 1 }
  return { error, hero, prompt, modelStatus, nextContent }
}

export function renderWelcome(
  ctx: Rect,
  state: WelcomeState,
  prompt: PromptState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): WelcomeLayout {
  const layout = layoutWelcome(ctx, state, prompt)
  const error = modelError(state)
  if (error !== undefined && layout.error.h > 0) {
    view.text(layout.error.x, layout.error.y, error, view.color(palette.accentError), layout.error.x + layout.error.w)
  }

  renderHero(layout.hero, state, view, palette)

  const ready = state.modelState.status === "ready"
  const promptState: PromptState = {
    ...prompt,
    focused: ready,
    model: state.modelState.status === "ready" ? state.modelState.label : "unconfigured",
    title: "New session",
  }
  renderPrompt(layout.prompt, promptState, view, palette, glyphs)
  if (!ready && prompt.text.length === 0 && layout.prompt.h >= 3) {
    const y = layout.prompt.y + 1
    const x0 = layout.prompt.x + 1
    const x1 = layout.prompt.x + layout.prompt.w - 1
    const blank = view.color(palette.bgBase)
    for (let x = x0; x < x1; x++) {
      view.cell(x, y, { text: " ", style: { bg: blank.fg }, width: 1, continuation: false })
    }
    let x = view.text(x0, y, glyphs.promptArrow, view.color(palette.grayDim), x1)
    view.text(x, y, "No model configured. Open Settings > Models & Providers.", view.color(palette.gray), x1)
  }

  view.text(
    layout.modelStatus.x,
    layout.modelStatus.y,
    modelStatusText(state.modelState),
    view.color(ready ? palette.accentModel : state.modelState.status === "loading" ? palette.grayDim : palette.warning),
    layout.modelStatus.x + layout.modelStatus.w,
  )
  view.text(
    layout.nextContent.x,
    layout.nextContent.y,
    `Local agent · v${state.version}`,
    view.color(palette.grayDim),
    layout.nextContent.x + layout.nextContent.w,
  )
  return layout
}

function modelStatusText(state: WelcomeModelState): string {
  if (state.status === "loading") return "Resolving model..."
  if (state.status === "ready") return state.label
  const reason = state.reason.trim().replace(/[.]+$/, "")
  return `${reason}. Open Settings > Models & Providers.`
}

function renderHero(ctx: Rect, state: WelcomeState, view: ViewDraw, palette: Palette): void {
  const wide = ctx.w >= WELCOME_WIDE_MIN
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const border = view.color(palette.promptBorder)

  view.text(x0, y0, `╭${"─".repeat(Math.max(0, ctx.w - 2))}╮`, border)
  view.text(x0, y1, `╰${"─".repeat(Math.max(0, ctx.w - 2))}╯`, border)
  const version = `v${state.version}`
  view.text(x1 - strWidth(version), y0, version, view.color(palette.gray), x1 + 1)

  const rightX = wide ? x0 + Math.floor(ctx.w * 0.5) : x0 + 2
  const menuTop = wide ? y0 + 1 : y0 + 3
  const leftLimit = wide ? rightX - 2 : x1 - 1
  view.text(x0 + 2, y0 + 1, "I-harness", view.color(palette.textPrimary, { bold: true }), x1)
  view.text(x0 + 2, y0 + 2, WELCOME_SUBTITLE, view.color(palette.gray), leftLimit)

  const menuBg: Style = { bg: hexToRgbLocal(palette.bgVisual), bold: true }
  for (let i = 0; i < state.menus.length; i++) {
    const y = menuTop + i
    if (y >= y1) break
    const menu = state.menus[i]!
    const cursor = i === state.cursor
    const fillFrom = wide ? rightX : x0 + 1
    if (cursor) fillRow(fillFrom, y, x1, menuBg, view)
    let x = view.text(rightX, y, menu.key, view.color(palette.accentUser, { bold: cursor }), x1)
    view.text(x, y, ` ${menu.label}`, view.color(palette.textPrimary, { bold: cursor }), x1)
  }

  for (let y = y0 + 1; y < y1; y++) {
    view.text(x0, y, "│", border)
    view.text(x1, y, "│", border)
  }
}

function fillRow(x0: number, y: number, limitX: number, style: Style, view: ViewDraw): void {
  for (let x = x0; x < limitX; x++) {
    view.cell(x, y, { text: " ", style, width: 1, continuation: false })
  }
}

function hexToRgbLocal(hex: string): NonNullable<Style["bg"]> {
  const value = hex.startsWith("#") ? hex.slice(1) : hex
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  }
}
