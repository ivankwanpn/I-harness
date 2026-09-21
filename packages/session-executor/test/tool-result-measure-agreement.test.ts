import { describe, expect, it } from "vitest"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { append, createSession, deriveMessages } from "@i-harness/core-session"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createOutputSpillGuard } from "@i-harness/output-retention"

// ── the deliberate copy, pinned to the authority ────────────────────────────
// `createOutputSpillGuard` re-implements the rule for the MODEL-VISIBLE text of
// a tool result — `toolResultText` / `imageDescriptor` in
// packages/core-session/src/index.ts — because output-retention does not depend
// on core-session. The copy is a decision this repo allows ("a duplication is
// the cheaper defect"); an UNPINNED copy is not, because it is a second truth
// that drifts. Nothing in the build made the two agree until this file.
//
// The agreement asserted, per corpus member: the authority's byte count of the
// tool text the model actually receives is EXACTLY the largest cap under which
// the guard leaves the result untouched — and one byte below it, the guard must
// treat the result as over the cap. That pins the two texts' LENGTHS equal in
// both directions: a copy that measures MORE than the authority spills a result
// the model could read in full; a copy that measures LESS lets an over-cap text
// through.
//
// The witness is the spill-file WRITE, not the replacement: the guard writes
// the file before it knows whether a replacement fits, and its give-up path
// (a cap below the notice's own size) keeps the original byte-identical. So the
// write happens iff the guard's measure exceeded the cap, and the assertions
// can tell "untouched because it fits" from "untouched because nothing fits".
//
// THE CORPUS HAS SEVEN MEMBERS: a plain string, a real `images` array, a mixed
// object, an empty `images` array, and the three malformed (non-array) `images`
// members a persisted log can carry — null, a string, an object. The last three
// are the authority's defensive branch (M14), and they need a DIFFERENT ROAD IN:
// `append` VALIDATES and throws for every non-array member (`image attachment:
// images must be an array` — null, "nope", {}, 0, false all measured), so those
// rows push the event directly, which is the road a log read back takes
// (`fromJSONL` does the same). The rule under test is applied on the way OUT,
// by `deriveMessages`, which is unchanged by the road in. All seven agree.
const VIA_APPEND = "append" // the validating road: the normal producer path
const VIA_PUSH = "push"     // the persisted-log road: skips append's validation

const mkdir = () => mkdtempSync(join(tmpdir(), "m5-agree-"))

const image = (rawBytes: number, extra: Record<string, unknown> = {}) => ({
  mediaType: "image/png",
  dataBase64: "A".repeat(Math.ceil(rawBytes / 3) * 4),
  ...extra,
})

const CORPUS: Array<[string, unknown, typeof VIA_APPEND | typeof VIA_PUSH]> = [
  ["a plain string", "The quick brown fox jumps over the lazy dog. ".repeat(40), VIA_APPEND],
  ["a real images array", { images: [image(4_000, { name: "shot.png", width: 12, height: 7 })] }, VIA_APPEND],
  ["a mixed object", { note: "N".repeat(600), images: [image(4_000)] }, VIA_APPEND],
  ["an empty images array", { images: [] }, VIA_APPEND],
  ["a malformed images member (null)", { images: null }, VIA_PUSH],
  ["a malformed images member (a string)", { images: "nope" }, VIA_PUSH],
  ["a malformed images member (an object)", { images: { mediaType: "image/png" } }, VIA_PUSH],
]

/** The model-visible text, through the AUTHORITY and only through it: the tool
 *  message `deriveMessages` hands the model. The function is module-private, so
 *  the projection is the only observable form it has. */
function authorityText(output: unknown, via: typeof VIA_APPEND | typeof VIA_PUSH): string {
  const session = createSession()
  append(session, { type: "tool/call", callId: "c0", name: "corpus", args: {} } as never)
  const result = { type: "tool/result", callId: "c0", name: "corpus", output } as never
  // Deliberately NOT a try/catch around append: the road is declared per row, so
  // a row marked VIA_APPEND that starts throwing is a red test rather than a
  // silently different drive.
  if (via === VIA_APPEND) append(session, result)
  else session.events.push(result)
  const tool = deriveMessages(session).find((m) => m.role === "tool")
  expect(tool).toBeDefined() // the corpus member reached the model at all
  return tool!.content as string
}

/** The guard's answer for one corpus member at one cap: the output it emits,
 *  whether it wrote a spill file (its own witness that its MEASURE exceeded the
 *  cap — pass-through returns before the store is touched), and — when it did
 *  write one — the file's text, which is the guard's durable copy of the
 *  model-visible text. */
async function guardAt(output: unknown, cap: number): Promise<{ out: unknown; files: number; saved?: string }> {
  const root = mkdir()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  registry.register({ name: "corpus", description: "", inputSchema: {}, execute: async () => output } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: cap, spillRoot: root }))
  const result = await registry.execute({ name: "corpus", args: {} })
  const entries = readdirSync(root)
  const saved = entries.length > 0 ? readFileSync(join(root, entries[0]!), "utf-8") : undefined
  rmSync(root, { recursive: true, force: true })
  return { out: result.output, files: entries.length, saved }
}

// The one corpus member where BOTH a non-empty rest and images coexist, so the
// authority's text is separable and the guard's split is observable on both
// sides of the boundary.
const MIXED = "a mixed object"

describe("the guard's measure agrees with core-session's toolResultText", () => {
  for (const [label, output, via] of CORPUS) {
    it(`agrees on ${label}`, async () => {
      const text = authorityText(output, via)
      const cap = Buffer.byteLength(text, "utf-8")
      // At the cap the AUTHORITY itself computed, the guard must consider the
      // result within budget: untouched, and no spill file written.
      const at = await guardAt(output, cap)
      expect(at.out).toEqual(output)
      expect(at.files).toBe(0)
      // One byte below, the model-visible text is over the cap, so the guard
      // must consider it over budget — the spill-file write is that judgement.
      const below = await guardAt(output, cap - 1)
      expect(below.files).toBeGreaterThan(0)
      if (label === MIXED) {
        // CONTENT, not only length. The assertions above pin the two measures'
        // byte counts equal; a drift that preserves LENGTH (measured: a key
        // reordering, or `?` rendered as `0`) is invisible to them — and the
        // guard's copy is also the text it RETAINS, so a content drift would
        // put the wrong text in the durable record while the boundary stayed
        // green. The spill file holds exactly the guard's split text, and it
        // must be the authority's rest text, character for character.
        const rest = text.slice(0, text.indexOf("\nimage: "))
        expect(rest.length).toBeGreaterThan(0) // the split was really exercised
        expect(below.saved).toBe(rest)
      }
    })
  }
})
