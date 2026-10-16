import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin, PluginContext } from "@i-harness/core-plugin"
import { diagnosticsFor } from "@i-harness/diagnostics"
import {
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_ABORTED_MID_FLIGHT,
  TOOL_CANCELLED_BY_SIBLING,
  TOOL_FAILED,
  TOOL_TIMEOUT,
} from "@i-harness/core-tools"
import { createSpillStore, createTextRetainer, spillNotice, type SpillStore } from "./index.ts"

// W6 T6: ONE module-scope handle for this file's one report, and the phase is
// `mount` because the GC it reports runs once at MOUNT (best-effort: the
// spill-house chore never blocks a mount, but a failure is not silent). With
// nothing installed the handle delegates to console.warn verbatim (one
// argument) — unset mode is the pre-migration bytes.
const d = diagnosticsFor("mount")

export interface OutputSpillGuardConfig {
  /** Shipping policy; absent preserves the legacy synthetic verdict exemption. */
  boundSyntheticFailures?: boolean
  // 缺省 64_000. The cap has a FLOOR as well: the replacement always carries the
  // notice, whose own text plus the spill path is ~200 B, so a cap below that
  // can never hold a replacement — an over-cap result then comes back
  // byte-identical through the give-up path (fitWithinCap): unbounded and
  // notice-less. The shipped default sits far above the floor; a caller lowering
  // this below a few hundred bytes gets that give-up path, not truncation.
  maxOutputBytes?: number
  spillRoot?: string        // 缺省 <tmpdir>/i-harness-spill（穩定目錄——GC 有意義）
  gc?: { maxAgeMs?: number; maxTotalBytes?: number } // 缺省 24h / 512MiB
}

const DEFAULT_MAX_OUTPUT_BYTES = 64_000
const DEFAULT_MAX_AGE_MS = 86_400_000
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024

// ── What the cap measures ────────────────────────────────────────────────────
// The authority for the model-visible text of a tool result is `toolResultText`
// in packages/core-session/src/index.ts — `deriveMessages` hands the model
// exactly its output. This copy is DELIBERATE: output-retention does not depend
// on core-session (its deps are core-plugin + core-tools), and this repo has
// ruled that a duplication is the cheaper defect. If the two ever disagree,
// THAT one is the authority; change this one to match it.
//
// The bound has four parts, each with its own test in test/spill-guard.test.ts:
//   (i)  the notice's own byte length is charged INSIDE the cap;
//   (ii) the size measured is the authority's text, never `JSON.stringify(out)`
//        — the two differ in both directions: a `{ output, outputPaths, spill }`
//        envelope is counted IN FULL (the model does see all of it), while a
//        real `images` array is measured at descriptor size (the model never
//        sees those bytes as text — they ride a follow-up user message as image
//        parts, M61);
//   (iii) a real `images` array is CARRIED THROUGH a replacement, not dropped —
//        `deriveMessages` reads `output.images`, so dropping the key deletes
//        the picture;
//   (iv) when no replacement fits, the original is kept: dsh's rule (spec §4.2)
//        is "the policy NEVER emits a replacement larger than the cap", so a
//        bound whose own replacement would exceed it is the defect this guard
//        exists to remove.
function imageDescriptor(images: readonly unknown[]): string {
  return (
    "\n" +
    images
      .map((image) => {
        const i = image as { name?: string; width?: number; height?: number; dataBase64: string }
        return `image: ${i.name ?? "unnamed"} ${i.width ?? "?"}x${i.height ?? "?"} ${Math.ceil((i.dataBase64.length * 3) / 4)}B base64:${i.dataBase64.slice(0, 8)}`
      })
      .join("\n")
  )
}

/** An OBJECT result split the way the authority splits it: the text with a real
 *  `images` array removed (empty when there is nothing else), and the array
 *  itself — `undefined` when the member is absent, empty or malformed, because
 *  only a REAL array is stripped; anything else stays part of the faithful
 *  payload (the authority's defensive rule). */
function splitRealImages(output: object): { text: string; images: unknown[] | undefined } {
  const record = output as Record<string, unknown>
  const images = record["images"]
  if (!Array.isArray(images) || images.length === 0) {
    return { text: JSON.stringify(output) ?? String(output), images: undefined }
  }
  const { images: _images, ...rest } = record
  const hasRest = Object.keys(rest).length > 0
  return { text: hasRest ? (JSON.stringify(rest) ?? String(rest)) : "", images }
}

/** The model-visible text of a tool result — see the block comment above. */
function modelVisibleText(output: unknown): string {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return JSON.stringify(output) ?? String(output)
  }
  const { text, images } = splitRealImages(output)
  if (images === undefined) return text
  const descriptor = imageDescriptor(images)
  return text.length > 0 ? text + descriptor : descriptor.trimStart()
}

function modelVisibleBytes(output: unknown): number {
  return Buffer.byteLength(modelVisibleText(output), "utf-8")
}

// A replacement is assembled from a retained head/tail PLUS a notice whose own
// byte cost (it carries the omitted-byte count and the spill path) is only known
// once the retained size is — so rather than guess it, this measures the REAL
// candidate and shrinks the retainer budget by the overage. Round counts are
// MEASURED per fixture, not assumed small (a probe counts retainer
// constructions, and nothing else builds one): 2 rounds for 10,000 plain chars
// at a 2,000-byte cap; 3 for 10,000 quotes; 4 for 10,000 NULs; 3 for a
// quote-heavy object; 3 for the 34,200-quote band row at the shipped cap, and 5
// for the 11,900-NUL one. The geometric fallback is why the escape-heavy rows
// cost more than the linear step alone did — convergence is bounded by
// MAX_FIT_ROUNDS, not by any small constant.
//
// THE STEP MUST BE GEOMETRIC WHEN LINEAR STALLS, and this loop needed that
// lesson twice. The budget is RAW bytes while the measure is the ESCAPED
// (model-visible) one, so while the retainer is still keeping the WHOLE input,
// subtracting the measured overage moves the budget and NOT the candidate: the
// same overage comes back every round, and the loop can give up while a fitting
// budget exists. Measured at the shipped 64,000 cap, STRING BRANCH ONLY — the
// object branch retains and measures the SAME JSON string, so its budget and
// its measure move together (the escape-heavy object fixture converges in 3
// rounds, counted the same way): `'"'.repeat(n)` for n ∈ [32,000, 34,200]
// step 100 came back as the ORIGINAL at up to 68,402 model-visible bytes
// (106.9% of the cap) at n = 34,200, and `"\u0000".repeat(n)` for n ∈ [11,000,
// 11,900] step 100 at up to 71,402 (111.6%) at n = 11,900 — all 33 rows giving
// up. A fit genuinely existed in both families: the fixed loop returns a
// replacement for every one of the 33, which is the band test's green run. So:
// subtract the overage only while the candidate actually SHRANK; when it did
// not shrink, or the subtraction cannot stay positive, halve the budget
// instead. A geometric descent reaches any fitting budget in ≤ log2(cap)
// rounds, which is why the round cap below sits well above log2 of any
// practical cap: a bound that cannot outlast the descent would re-introduce the
// give-up it exists to avoid.
//
// REACHABILITY of that band: no IN-TREE tool returns a bare string result
// today (fs, shell and fs-search all return objects), so the band's producer is
// a plugin-provided tool that does — real, but not something the tree ships.
// Stated so this fix is not read as covering a shape production produces.
//
// `null` HAS TWO EXITS: the budget is cut below 1 (nothing the retainer can
// keep measures within the cap — the notice-alone case), or the round cap
// expires. They coincide only while the geometric descent fits inside the round
// cap, i.e. log2(cap) + 1 <= MAX_FIT_ROUNDS (64,000 → 17 <= 32 today). That is
// a BOUND argument, not a sweep: the widest measurements here and in the block
// review reach 5 rounds, and no shape is known that spends all 32 with a fit
// still available — but a cap raised past 2^31 without raising the constant
// would make the second exit reachable on its own. On either exit the caller
// keeps the original (atom (iv)).
const MAX_FIT_ROUNDS = 32

/** Fit a replacement inside `cap` model-visible bytes: `assemble(budget)` runs
 *  the retainer at `budget` and returns the real candidate. `null` = no
 *  replacement fits. */
function fitWithinCap(cap: number, assemble: (budget: number) => unknown): unknown | null {
  let budget = cap
  let previous = Number.POSITIVE_INFINITY
  for (let round = 0; round < MAX_FIT_ROUNDS; round++) {
    if (budget < 1) return null
    const candidate = assemble(budget)
    const bytes = modelVisibleBytes(candidate)
    if (bytes <= cap) return candidate
    // Linear while it makes progress: the overage the measure reports, given
    // back to the budget that produced it. Geometric when it cannot: a
    // candidate that did not shrink means the budget is still above everything
    // the retainer keeps, so the same overage would be subtracted forever —
    // halving is the step that gets below the input and moves the candidate.
    const linear = budget - (bytes - cap)
    budget = linear >= 1 && bytes < previous ? linear : Math.floor(budget / 2)
    previous = bytes
  }
  return null
}

// Legacy callers preserve the original code-value exemption when the injected
// shipping policy is absent. Shipping uses an explicit synthetic-producer
// cascade below; an ordinary result with a matching code string is still data.
// The timeout guard and scheduler commit lane invoke that cascade without
// replaying the tool or its post-execute hooks.
const SYNTHETIC_FAILURE_CODES = new Set([
  TOOL_FAILED,                    // a body that tried and failed
  TOOL_ABORTED_BEFORE_DISPATCH,   // a call that never started
  TOOL_CANCELLED_BY_SIBLING,      // a call a sibling's failure cancelled
  TOOL_ABORTED_MID_FLIGHT,        // the abort path wrote this verdict
  TOOL_TIMEOUT,                   // the timeout guard replaced a partial result
])
const isSyntheticFailure = (out: unknown): boolean =>
  typeof out === "object" && out !== null && SYNTHETIC_FAILURE_CODES.has((out as { code?: string }).code as string)

// WHY THE SET STOPS AT FIVE. The repair path in session-persistence
// (src/repair.ts) writes a SIXTH synthetic code — one code shared by TWO arms:
// a DISPATCHED call whose outcome the log does not contain, and (Q8/M71) a
// pending call in a log that records no dispatch marker ANYWHERE. It is
// deliberately not here, because it cannot reach this guard: the mount point is
// the live `tools/execute` cascade, and a result read back from a REPAIRED log
// never passes through it. If "synthetic" is ever widened to mean "read back
// from a repaired log", this set stops being complete — and the `replay: false`
// sentence the repair path attaches is exactly what a truncation would hide.

/** registry 級統一落盤（opencode/dsh spill policy 吸收）。string 超限 → 截斷字串 + spill notice
 *  （notice 內含完整路徑）；object 超限 → { output, outputPaths, spill } 信封。**core-tools 零改動**
 *  ——core-tools 的 tools/execute cascade 縫（guard-timeout 先例）是唯一接入點。 */
export function createOutputSpillGuard(_ctx: PluginContext, config?: OutputSpillGuardConfig): Plugin {
  const maxBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const root = config?.spillRoot ?? join(tmpdir(), "i-harness-spill")
  const store: SpillStore = createSpillStore({ root })
  // 掛載時跑一次 GC（best-effort；失敗只 warn——GC 是維生屋事，不阻擋掛載）
  const gcOpts = { maxAgeMs: config?.gc?.maxAgeMs ?? DEFAULT_MAX_AGE_MS, maxTotalBytes: config?.gc?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES }
  void gcSpillStore(root, gcOpts).catch((e) => d.warn(`[i-harness] spill GC failed: ${String(e)}`))

  return {
    name: "output-spill",
    mount(ctx: PluginContext): void {
      if (config?.boundSyntheticFailures) ctx.onCascade("tools/project-synthetic-result", async (dispatch, next) => {
        const out = await next()
        if (modelVisibleBytes(out) <= maxBytes) return out
        const { name } = dispatch as { name: string }
        const { text, images } = splitRealImages(out as object)
        const raw = out as { code: string; error: string; outcome?: string }
        const path = await store.saveText(text, `${name}-failure`)
        const reason = createTextRetainer({ maxBytes: 2048, mode: "head" })
        reason.push(raw.error)
        const replacement = fitWithinCap(maxBytes, budget => {
          const r = createTextRetainer({ maxBytes: budget, mode: "headTail" })
          r.push(text)
          const kept = r.finish()
          return { code: raw.code, error: reason.finish().text,
            ...(raw.outcome !== undefined ? { outcome: raw.outcome } : {}),
            output: kept.text + "\n" + spillNotice(kept.omittedBytes, path), outputPaths: [path],
            spill: { omittedBytes: kept.omittedBytes, label: name, retention: "temporary", maxAgeMs: gcOpts.maxAgeMs, maxTotalBytes: gcOpts.maxTotalBytes },
            ...(images !== undefined ? { images } : {}),
          }
        })
        if (replacement === null) throw new Error("Synthetic result metadata exceeds output budget; full result retained at " + path)
        return replacement
      })
      ctx.onCascade("tools/execute", async (dispatch, next) => {
        const out = await next()
        if (out === undefined || out === null || typeof out === "number" || typeof out === "boolean") return out
        const d = dispatch as { name: string }
        // Read owns its source-backed range policy in shipping registrations.
        // Legacy path-only callers preserve their full read behavior here.
        if (d.name === "read") return out
        // Keep the old code-value exemption only for legacy registrations.
        // Explicit shipping synthetic producers have already retained/projected
        // their verdict; arbitrary code-string collisions still use normal spill.
        if (!config?.boundSyntheticFailures && isSyntheticFailure(out)) return out
        if (typeof out === "string") {
          // Atom (ii): what the model sees for a string result is the
          // authority's JSON-quoted form, so that — not the raw byte length —
          // is what the cap is checked and measured against.
          if (modelVisibleBytes(out) <= maxBytes) return out
          const path = await store.saveText(out, `${d.name}-output`)
          // Atoms (i) and (iv): the notice is inside the budget this loop
          // measures, and a fit that cannot be found keeps the original.
          return fitWithinCap(maxBytes, (budget) => {
            const r = createTextRetainer({ maxBytes: budget, mode: "headTail" })
            r.push(out)
            const kept = r.finish()
            return kept.text + "\n" + spillNotice(kept.omittedBytes, path)
          }) ?? out
        }
        // Atom (ii), both halves: the authority counts the envelope in full and
        // a real `images` array at descriptor size — so a 10 MiB `read_image`
        // result passes through here untouched instead of being spilled into a
        // replacement that deletes the picture and puts base64 in its place.
        if (modelVisibleBytes(out) <= maxBytes) return out
        // The text a spill can bound is the authority's text: with a real
        // `images` array in play the base64 is not text, and re-retaining it
        // would put a wall of it back in front of the model.
        const { text, images } = splitRealImages(out as object)
        const path = await store.saveText(text, `${d.name}-output`)
        const envelope = fitWithinCap(maxBytes, (budget) => {
          const r = createTextRetainer({ maxBytes: budget, mode: "headTail" })
          r.push(text)
          const kept = r.finish()
          return {
            output: kept.text + "\n" + spillNotice(kept.omittedBytes, path),
            outputPaths: [path],
            spill: { omittedBytes: kept.omittedBytes, label: d.name },
            // Atom (iii): carried through, so `deriveMessages` still finds them.
            ...(images !== undefined ? { images } : {}),
          }
        })
        return envelope ?? out
      })
    },
  }
}

/** GC：刪 maxAgeMs 前的檔案（mtime），再按總量修剪——最舊先刪。回報刪除數/位元組。 */
export async function gcSpillStore(
  root: string,
  opts: { maxAgeMs: number; maxTotalBytes: number; now?: number },
): Promise<{ removedFiles: number; removedBytes: number }> {
  const { readdir, stat, unlink } = await import("node:fs/promises")
  const now = opts.now ?? Date.now()
  const entries: Array<{ path: string; mtime: number; size: number }> = []
  for (const name of await readdir(root)) {
    try {
      const st = await stat(join(root, name))
      if (st.isFile()) entries.push({ path: join(root, name), mtime: st.mtimeMs, size: st.size })
    } catch { /* 競態刪除中——跳過 */ }
  }
  let removedBytes = 0
  let removedFiles = 0
  const remaining: typeof entries = []
  for (const e of entries) {
    if (now - e.mtime > opts.maxAgeMs) { removedFiles++; removedBytes += e.size; await unlink(e.path).catch(() => {}) }
    else remaining.push(e)
  }
  remaining.sort((a, b) => a.mtime - b.mtime) // 最舊先
  let total = remaining.reduce((s, e) => s + e.size, 0)
  for (const e of remaining) {
    if (total <= opts.maxTotalBytes) break
    total -= e.size
    removedFiles++; removedBytes += e.size
    await unlink(e.path).catch(() => {})
  }
  return { removedFiles, removedBytes }
}

export function createUnifiedSpillStore(root?: string): SpillStore {
  return createSpillStore({ root: root ?? join(tmpdir(), "i-harness-spill") })
}
