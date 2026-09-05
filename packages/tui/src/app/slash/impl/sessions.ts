// @i-harness/tui — G2 (M46a): session slash commands — /new /home /resume
// /delete /rename /session-info.
// Backend truth: the embedded session is in-process (mock-first; persistence
// + coordinator arrival = M38 per the embedded bridge header), so /new and
// /delete are CONFIRMED app-level resets with honest persistence notes —
// never a plain no-op, never a fake id on disk.

import type { SlashCommand } from "../types.ts"
import { sessionInfoRows } from "../../../views/light-session-info.ts"
import { bindTextInput } from "./text-input.ts"

export const sessionCommands: SlashCommand[] = [
  {
    name: "new",
    description: "Start a new session",
    run(ctx) {
      ctx.openPanel({
        kind: "session-info",
        title: "New session?",
        rows: [
          { label: "Start a new session (current in-session state is discarded)" },
          { label: "Cancel" },
        ],
        cursor: 1,
        onSelect: (i) => {
          if (i !== 0) { ctx.toast("cancelled"); return }
          ctx.resetSession()
        },
      })
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
    run(ctx) {
      ctx.openSessions()
    },
  },
  {
    name: "delete",
    description: "Delete the current session (confirm → welcome)",
    run(ctx) {
      ctx.openPanel({
        kind: "session-info",
        title: "Delete session?",
        rows: [
          { label: "Delete this session" },
          { label: "Cancel" },
        ],
        cursor: 1,
        onSelect: (i) => {
          if (i !== 0) { ctx.toast("cancelled"); return }
          ctx.deleteSession()
        },
      })
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
