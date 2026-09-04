// M39 wheel close: overlay freeform capture — the seam widget that routes
// printable chars/Backspace/Enter/Esc to the permission reject row and the
// question `z` row (the loop's onInput consults OverlaySeam.freeform).
import { describe, expect, it } from "vitest"
import { bindPermissionOverlay, bindQuestionOverlay } from "../src/app/overlay-seam.ts"
import type { PermissionSurface } from "../src/views/permission.ts"
import type { QuestionQuestion } from "../src/views/question.ts"

const surf: PermissionSurface = {
  id: "p1",
  kind: "bash",
  title: "echo rm",
  detail: "bash: rm -rf node_modules",
  freeform: true,
  scopes: ["command"],
}

const q: QuestionQuestion = {
  id: "q1",
  label: "Continue?",
  description: "",
  options: [
    { key: "1", label: "Apple" },
    { key: "2", label: "Banana" },
  ],
  multi: false,
  freeform: true,
}

describe("permission freeform", () => {
  it("captures chars while the reject row is focused; submit carries feedback", () => {
    const state = { cursor: 3, scopeIndex: 0, freeformText: "" } // last of 5 rows (4 = reject)
    const decisions: Array<Record<string, unknown>> = []
    let closed = 0
    const seam = bindPermissionOverlay(surf, state, {
      onDecision: (d) => decisions.push(d as unknown as Record<string, unknown>),
      onClose: () => { closed++ },
    })
    expect(seam.freeform?.active()).toBe(false) // row 4 not focused
    state.cursor = 4
    expect(seam.freeform?.active()).toBe(true)
    seam.freeform!.append("don")
    seam.freeform!.append("t ")
    seam.freeform!.append("trust")
    seam.freeform!.backspace()
    expect(state.freeformText).toBe("dont trus")
    seam.freeform!.submit()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ verdict: "reject", approved: false, feedback: "dont trus" })
    expect(closed).toBe(1)
  })

  it("abort closes without a decision", () => {
    const state = { cursor: 4, scopeIndex: 0, freeformText: "x" }
    const decisions: unknown[] = []
    let closed = 0
    const seam = bindPermissionOverlay(surf, state, {
      onDecision: (d) => decisions.push(d),
      onClose: () => { closed++ },
    })
    seam.freeform!.abort()
    expect(decisions).toHaveLength(0)
    expect(closed).toBe(1)
  })
})

describe("question freeform", () => {
  it("captures while `z` focused; submit answers mode freeform", () => {
    const state = { page: 1, pages: 1, cursor: 0, selected: [], freeformFocused: true, freeformText: "" }
    const decisions: Array<Record<string, unknown>> = []
    let closed = 0
    const seam = bindQuestionOverlay(q, state, {
      onDecision: (d) => decisions.push(d as unknown as Record<string, unknown>),
      onClose: () => { closed++ },
    })
    expect(seam.freeform?.active()).toBe(true)
    seam.freeform!.append("hel")
    seam.freeform!.append("lo")
    seam.freeform!.submit()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ mode: "freeform", value: "hello" })
    expect(closed).toBe(1)
  })

  it("abort unfocuses without answering", () => {
    const state = { page: 1, pages: 1, cursor: 0, selected: [], freeformFocused: true, freeformText: "x" }
    const decisions: unknown[] = []
    let closed = 0
    const seam = bindQuestionOverlay(q, state, {
      onDecision: (d) => decisions.push(d),
      onClose: () => { closed++ },
    })
    seam.freeform!.abort()
    expect(state.freeformFocused).toBe(false)
    expect(decisions).toHaveLength(0)
    expect(closed).toBe(0) // the row unfocused; the question stays open
  })
})
