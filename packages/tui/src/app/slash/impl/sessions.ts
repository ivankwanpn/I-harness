// @i-harness/tui — G2 (M46a): session slash commands — /new /home /resume
// /dashboard /rename /session-info (+ the capability-gated /fork — spec
// §10.2 "Conditional session": registered, visible only with the "fork"
// backend capability; the loop derives it from backend.forkSession).
// M49 Task 14 (spec §10.3): /delete is NOT registered (no durable delete API —
// the permanent exclusion list) and /new goes through the backend create
// seam (ctx.createSession) instead of an app-level confirm+reset.

import type { SlashCommand } from "../types.ts"
import { hasCapability } from "../types.ts"
import { sessionInfoRows } from "../../../views/light-session-info.ts"
import { bindTextInput } from "./text-input.ts"

export const sessionCommands: SlashCommand[] = [
  {
    name: "new",
    description: "Start a new session (backend create)",
    visible: (ctx) => hasCapability(ctx, "session-create"),
    run(ctx) {
      if (ctx.createSession === undefined) {
        ctx.toast("new session: backend create seam absent")
        return
      }
      void ctx.createSession()
    },
  },
  {
    name: "home",
    description: "Show the welcome screen",
    run(ctx) {
      ctx.setScreen("welcome")
    },
  },
  {
    name: "resume",
    description: "Open the session picker",
    visible: (ctx) => hasCapability(ctx, "session-list"),
    run(ctx) {
      ctx.openSessions()
    },
  },
  {
    // M49 Task 13 (spec §8.3): the local dashboard — the SAME view the Welcome
    // menu entry and Ctrl+\ use (no remote/team/cost fields, ever).
    name: "dashboard",
    description: "Open the local session dashboard",
    visible: (ctx) => hasCapability(ctx, "dashboard"),
    run(ctx) {
      if (ctx.dashboard === undefined) {
        ctx.toast("dashboard: backend projection absent")
        return
      }
      ctx.dashboard()
    },
  },
  {
    // "Conditional session" (spec §10.2): the fork capability comes from
    // backend.forkSession — the production TUI backend has no fork member
    // (registered; visible only where one exists).
    name: "fork",
    description: "Fork the current session (backend fork)",
    argumentHint: "[title]",
    visible: (ctx) => hasCapability(ctx, "fork"),
    run(ctx) {
      if (ctx.fork === undefined) {
        ctx.toast("fork: backend fork seam absent")
        return
      }
      const title = ctx.arg.trim()
      ctx.fork(title === "" ? undefined : title)
    },
  },
  {
    // M49 Task 14 (spec §10.2 "Conditional session"): the live context-usage
    // panel — visible only when the backend prices the session context.
    name: "context",
    description: "Context usage for this session (local)",
    visible: (ctx) => hasCapability(ctx, "context"),
    run(ctx) {
      if (ctx.openContext === undefined) {
        ctx.toast("context: backend context seam absent")
        return
      }
      ctx.openContext()
    },
  },
  {
    name: "rename",
    description: "Rename the session title",
    argumentHint: "[title]",
    run(ctx) {
      const title = ctx.arg.trim()
      if (title.length > 0) {
        ctx.renameSession(title)
        return
      }
      // Prompt-for-title overlay: let the type through, accept via Enter.
      ctx.app.overlay = bindTextInput({
        title: "Rename session",
        initial: ctx.app.title,
        onSubmit: (text) => { ctx.app.overlay = undefined; ctx.renameSession(text.trim() || ctx.app.title) },
        onCancel: () => { ctx.app.overlay = undefined; ctx.toast("rename cancelled") },
      })
    },
  },
  {
    name: "session-info",
    description: "Session details (id/model/turns/context)",
    run: async (ctx) => {
      const usage = await ctx.backend.context?.().catch(() => undefined)
      ctx.openPanel({
        kind: "session-info",
        title: "Session info",
        rows: sessionInfoRows({
          id: ctx.sessionId,
          title: ctx.app.title,
          model: ctx.app.prompt.model,
          turns: ctx.turns(),
          lines: ctx.engine.lineCount(),
          used: usage?.used,
          total: usage?.total,
        }),
      })
    },
  },
]
