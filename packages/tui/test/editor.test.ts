// M49 Task 7: the grapheme-safe PromptEditor — the single transaction path for
// insert/delete/newline/motion/history/stash/mouse/external-editor.
//
// Cursor discipline: every cursor() is a grapheme boundary of value() (never
// a UTF-16 code unit); `Intl.Segmenter(undefined, {granularity:"grapheme"})`
// with a code-point fallback. A paste chip is ONE atomic cursor element — the
// cursor never lands inside its displayed text; expandPaste replaces the
// element with its source. Undo units: one printable burst (coalesced inserts
// until movement/paste/newline/delete/submit/500ms gap — UNDO_COALESCE_MS),
// a paste-chip expand, a newline, a delete, or a replaceAll.

import { describe, expect, it } from "vitest"
import { createPromptEditor, UNDO_COALESCE_MS, graphemesOf } from "../src/editor/index.ts"

describe("graphemesOf", () => {
  it("splits grapheme clusters (ZWJ and combining marks stay whole)", () => {
    expect(graphemesOf("A\u{1F642}B")).toEqual(["A", "\u{1F642}", "B"])
    expect(graphemesOf("é")).toEqual(["é"])
    expect(graphemesOf("\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}").length).toBe(1)
    expect(graphemesOf("")).toEqual([])
  })
})

describe("PromptEditor — grapheme boundaries", () => {
  it.each([
    ["A\u{1F642}B", 3, "AB"],
    ["AéB", 3, "AB"],
    ["A\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}B", 12, "AB"],
  ])("backspace removes one grapheme from %s", (text, cursor, expected) => {
    const editor = createPromptEditor(text, cursor)
    editor.backspace()
    expect(editor.value()).toBe(expected)
  })

  it("inserting a combining mark lands the cursor on the cluster end", () => {
    const editor = createPromptEditor("a", 1)
    editor.insert("́", 0) // combining acute: "á" is ONE grapheme
    expect(editor.value()).toBe("á")
    expect(editor.cursor()).toBe(2) // the cluster end, never 1
    editor.backspace()
    expect(editor.value()).toBe("")
  })

  it("deleteForward removes one grapheme", () => {
    const editor = createPromptEditor("AB \u{1F642}C", 3) // on the emoji
    editor.deleteForward()
    expect(editor.value()).toBe("AB C")
    expect(editor.cursor()).toBe(3)
  })

  it("move: left/right step per grapheme, word hops skip whitespace", () => {
    const editor = createPromptEditor("one two here", 12)
    editor.move("left")
    expect(editor.cursor()).toBe(11) // one grapheme left
    editor.move("word-left")
    expect(editor.cursor()).toBe(8) // "here" start
    editor.move("word-left")
    expect(editor.cursor()).toBe(4) // "two" start
    editor.move("word-right")
    expect(editor.cursor()).toBe(7) // "two" end
    editor.move("home")
    expect(editor.cursor()).toBe(0)
    editor.move("end")
    expect(editor.cursor()).toBe(12)
  })

  it("home/end move per visual line (newlines included)", () => {
    const editor = createPromptEditor("ab\ncd\nef", 7) // in "ef", after "e"
    editor.move("home")
    expect(editor.cursor()).toBe(6) // "ef" line start
    editor.move("end")
    expect(editor.cursor()).toBe(8)
  })

  it("move with extend makes a selection; insert replaces it", () => {
    const editor = createPromptEditor("hello", 5)
    editor.move("home", true)
    expect(editor.selection()).toEqual({ anchor: 5, focus: 0 })
    expect(editor.value()).toBe("hello")
    editor.insert("X", 0)
    expect(editor.value()).toBe("X")
    expect(editor.selection()).toBeUndefined()
  })

  it("selectAll selects and typing replaces it", () => {
    const editor = createPromptEditor("hello", 2)
    editor.selectAll()
    expect(editor.selection()).toEqual({ anchor: 0, focus: 5 })
    editor.insert("X", 0)
    expect(editor.value()).toBe("X")
  })
})

describe("PromptEditor — newline and undo/redo", () => {
  it("inserts a newline at the cursor and supports undo/redo", () => {
    const editor = createPromptEditor("abcd", 2)
    editor.newline()
    expect(editor.value()).toBe("ab\ncd")
    expect(editor.undo()).toBe(true)
    expect(editor.value()).toBe("abcd")
    expect(editor.redo()).toBe(true)
    expect(editor.value()).toBe("ab\ncd")
  })

  it("coalesces a printable burst into one undo record; movement breaks it", () => {
    const editor = createPromptEditor()
    editor.insert("h", 0)
    editor.insert("i", 10)
    editor.insert("!", 20)
    expect(editor.undo()).toBe(true) // one burst = one record
    expect(editor.value()).toBe("")
    editor.insert("h", 0)
    editor.insert("i", 10)
    editor.move("right") // movement ends the burst
    editor.insert("!", 30)
    expect(editor.undo()).toBe(true)
    expect(editor.value()).toBe("hi")
  })

  it("a 500ms gap splits the burst into two undo records", () => {
    const editor = createPromptEditor()
    editor.insert("a", 0)
    editor.insert("b", UNDO_COALESCE_MS + 1)
    expect(editor.undo()).toBe(true)
    expect(editor.value()).toBe("a")
    expect(editor.undo()).toBe(true)
    expect(editor.value()).toBe("")
  })

  it("delete is its own undo record", () => {
    const editor = createPromptEditor("ab", 2)
    editor.backspace()
    editor.backspace()
    expect(editor.undo()).toBe(true)
    expect(editor.value()).toBe("a")
    expect(editor.undo()).toBe(true)
    expect(editor.value()).toBe("ab")
  })

  it("a fresh editor has no undo history; redo collapses on a new edit", () => {
    const editor = createPromptEditor("x")
    expect(editor.undo()).toBe(false)
    editor.insert("y", 0)
    expect(editor.value()).toBe("xy")
    expect(editor.undo()).toBe(true)
    expect(editor.value()).toBe("x")
    expect(editor.redo()).toBe(true)
    expect(editor.value()).toBe("xy")
    editor.insert("z", 0)
    expect(editor.redo()).toBe(false) // redo stack cleared
  })
})

describe("PromptEditor — paste atoms", () => {
  it("treats a paste chip as one atomic cursor element", () => {
    const editor = createPromptEditor()
    editor.insertPaste({ display: "[Pasted: 20 lines]", source: "a\n".repeat(20) })
    editor.move("left")
    expect(editor.cursor()).toBe(0)
    editor.expandPasteAtCursor()
    expect(editor.value()).toBe("a\n".repeat(20))
  })

  it("backspace on the atom end removes the whole atom block", () => {
    const editor = createPromptEditor()
    editor.insertPaste({ display: "[Pasted: 2 lines]", source: "one\ntwo" }, 0)
    editor.move("end")
    editor.backspace() // removes the atom as ONE step
    expect(editor.value()).toBe("")
    expect(editor.undo()).toBe(true)
    expect(editor.value()).toBe("one\ntwo")
  })

  it("pasteAtoms exposes the M46c stash source", () => {
    const editor = createPromptEditor()
    editor.insertPaste({ display: "[Pasted: 2 lines]", source: "a\nb" }, 0)
    expect(editor.pasteAtoms()).toEqual([{ display: "[Pasted: 2 lines]", source: "a\nb" }])
    expect(editor.value()).toBe("a\nb")
  })

  it("expandPaste makes the block editable; undo brings the atom back", () => {
    const editor = createPromptEditor("L", 1)
    editor.insertPaste({ display: "[Pasted: 2 lines]", source: "a\nb" })
    editor.expandPasteAtCursor()
    expect(editor.value()).toBe("La\nb")
    // the expanded text is now plain — movement enters the block
    editor.move("left")
    expect(editor.cursor()).toBe(3)
    expect(editor.undo()).toBe(true) // undo the expand → atom back
    expect(editor.pasteAtoms()).toHaveLength(1)
    expect(editor.value()).toBe("La\nb") // the atom renders as its source again
  })

  it("moveTo snaps into the nearest atom boundary (mouse clicks)", () => {
    const editor = createPromptEditor()
    editor.insertPaste({ display: "[Pasted: 2 lines]", source: "a\nb" })
    editor.insert("Z", 0) // cursor at the atom end → value "a\nbZ", atom spans 0..3
    editor.moveTo(2) // inside the atom: dist(0)=2, dist(3)=1 → 3
    expect(editor.cursor()).toBe(3)
    editor.moveTo(1) // dist(0)=1, dist(3)=2 → 0
    expect(editor.cursor()).toBe(0)
    editor.moveTo(3.5 as number) // value-length clamp
    expect(editor.cursor()).toBe(3) // nearest boundary of 4 → 3
  })

  it("the atom never splits: arrow steps stay on atom boundaries", () => {
    const editor = createPromptEditor()
    editor.insertPaste({ display: "[Pasted: 2 lines]", source: "a\nb" })
    const seen: number[] = []
    for (let i = 0; i < 4; i++) {
      editor.move("left")
      seen.push(editor.cursor())
    }
    expect(seen).toEqual([0, 0, 0, 0]) // end-then-left = 0; no interior ever
  })

  it("right steps across a chip junction: start→end (the atom), end→next char", () => {
    const editor = createPromptEditor("ab", 2)
    editor.insertPaste({ display: "[Pasted: 1 line]", source: "CHIP" }) // atom 2..6
    editor.insert("c", 0) // "ab" + atom + "c", cursor 7
    editor.move("left")
    editor.move("left") // 2 — the atom start
    expect(editor.cursor()).toBe(2)
    editor.move("right") // the junction: one atom step → 6
    expect(editor.cursor()).toBe(6)
    editor.move("right") // the following text: one grapheme → 7
    expect(editor.cursor()).toBe(7)
    editor.move("right") // at the end: stays
    expect(editor.cursor()).toBe(7)
  })

  it("deleteForward at the chip start removes the WHOLE chip; after it removes the next char", () => {
    const editor = createPromptEditor("ab", 2)
    editor.insertPaste({ display: "[Pasted: 1 line]", source: "CHIP" })
    editor.insert("c", 0)
    editor.move("left")
    editor.move("left") // 2 — the chip start
    editor.deleteForward() // the junction: the chip is ONE unit
    expect(editor.value()).toBe("abc")
    expect(editor.cursor()).toBe(2)
    editor.deleteForward() // now plain text: the "c"
    expect(editor.value()).toBe("ab")
  })

  it("right from the atom end enters the following text without freezing (junction symmetry)", () => {
    const editor = createPromptEditor()
    editor.insertPaste({ display: "[Pasted: 1 line]", source: "XY" }, 0) // atom 0..2
    editor.insert("Z", 0) // "XY" + "Z", cursor 3
    editor.move("left") // 2 (atom end)
    editor.move("right") // one grapheme → 3 (the "Z")
    expect(editor.cursor()).toBe(3)
  })
})

describe("PromptEditor — replaceAll transactions", () => {
  it("history/stash/external-editor restore is one undoable replaceAll", () => {
    const editor = createPromptEditor("draft", 3)
    editor.insert("X", 0) // "dra" + "X" + "ft"
    expect(editor.value()).toBe("draXft")
    editor.replaceAll("restored", 0)
    expect(editor.value()).toBe("restored")
    expect(editor.undo()).toBe(true)
    expect(editor.value()).toBe("draXft")
  })

  it("clear() empties and is undoable", () => {
    const editor = createPromptEditor("hi", 2)
    editor.clear()
    expect(editor.value()).toBe("")
    expect(editor.undo()).toBe(true)
    expect(editor.value()).toBe("hi")
  })
})
