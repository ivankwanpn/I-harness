// M46a G1: the model picker — (no override) first, the catalog list, the
// 10-row window + `and N more…`, and the binder's select/dismiss semantics.

import { describe, expect, it } from "vitest"
import {
  MODEL_MORE,
  MODEL_NO_OVERRIDE,
  MODEL_PICKER_MAX_ROWS,
  bindModelPickerOverlay,
  modelPickerEntries,
  modelPickerWindow,
  type ModelPickerState,
} from "../src/views/model-picker.ts"

describe("model picker — entries + window", () => {
  it("entries: (no override) first, then the catalog (id + name)", () => {
    const entries = modelPickerEntries([{ id: "deepseek-chat", name: "DeepSeek Chat" }, { id: "deepseek-reasoner" }])
    expect(entries.map((e) => e.label)).toEqual([MODEL_NO_OVERRIDE, "deepseek-chat  DeepSeek Chat", "deepseek-reasoner"])
    expect(entries[0]!.value).toBeUndefined()
    expect(entries[1]!.value).toBe("deepseek-chat")
  })

  it("window: capped at 10 visible + `and N more…` for the rest", () => {
    const entries = modelPickerEntries(
      Array.from({ length: 14 }, (_, i) => ({ id: `m${i}` })),
    )
    expect(entries.length).toBe(15)
    expect(MODEL_PICKER_MAX_ROWS).toBe(10)
    const w = modelPickerWindow(entries, 0)
    expect(w.visible.length).toBe(10)
    expect(w.more).toBe(5)
    expect(MODEL_MORE.replace("%d", "5")).toBe("and 5 more…")
    // cursor-anchored: the 12th entry shows the tail window.
    const w2 = modelPickerWindow(entries, 12)
    expect(w2.visible.length).toBe(10)
    expect(w2.visible[0]!.label).toBe(entries[5]!.label)
  })
})

describe("model picker — binder", () => {
  function harness(state: ModelPickerState) {
    const selected: Array<string | undefined> = []
    let closed = false
    const seam = bindModelPickerOverlay(state, {
      onSelect: (v) => selected.push(v),
      onClose: () => { closed = true },
    })
    return { seam, selected, closed: () => closed }
  }

  it("Enter selects at the cursor (row 0 = (no override) → undefined)", () => {
    const h = harness({ entries: modelPickerEntries([{ id: "a" }]), cursor: 0 })
    h.seam.act!("overlay-select")
    expect(h.selected).toEqual([undefined]) // (no override) clear
    expect(h.closed()).toBe(true)
  })

  it("nav + Enter selects a model id", () => {
    const h = harness({ entries: modelPickerEntries([{ id: "a" }, { id: "b", name: "B model" }]), cursor: 0 })
    h.seam.act!("overlay-nav-next")
    h.seam.act!("overlay-nav-next")
    h.seam.act!("overlay-select")
    expect(h.selected).toEqual(["b"])
  })

  it("Esc closes without a selection; prev-nav on row 0 clamps (no-op)", () => {
    const h = harness({ entries: modelPickerEntries([{ id: "a" }]), cursor: 0 })
    h.seam.act!("overlay-nav-prev") // clamps at 0 — no crash, no selection
    h.seam.act!("overlay-nav-next")
    h.seam.act!("overlay-nav-next") // clamps at last row
    h.seam.act!("overlay-dismiss")
    expect(h.closed()).toBe(true)
    expect(h.selected).toEqual([])
  })
})
