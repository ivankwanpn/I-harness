import { readFile, writeFile, readdir } from "node:fs/promises"
import { resolve, relative, isAbsolute } from "node:path"
import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { FsToolFailure } from "./error.ts"
import { createTextDiff, type TextDiff } from "@i-harness/text-diff"
import { FsToolError, softFail } from "./error.ts"
import { writeFileAtomic } from "./atomic.ts"
import { assertSnapshotFresh } from "./version.ts"
import { normalizeLineEndings, detectLineEndings, restoreLineEndings, assertTextData, applyLiteralEdit } from "./text.ts"
import { parsePatch, applyPatch, type RewindCapture } from "./patch.ts"
import type { EscalationApprover, SandboxDenial, SandboxExecutionPolicy, SandboxMode } from "@i-harness/sandbox"
import { ESCALATION_TARGETS, resolveCallPolicy } from "@i-harness/sandbox"

export { FsToolError, softFail, type FsToolErrorCode, type FsToolFailure } from "./error.ts"
export { writeFileAtomic } from "./atomic.ts"
export { assertSnapshotFresh, type FileSnapshot } from "./version.ts"
export type { RewindCapture } from "./patch.ts"
export {
  normalizeLineEndings,
  detectLineEndings,
  restoreLineEndings,
  assertTextData,
  applyLiteralEdit,
  type LiteralEditResult,
} from "./text.ts"

// 既有行為：絕對輸入原樣（讀取 workspace 外檔案——read 保留）；`..` 逃逸 → 現在拒
export function resolvePath(workspace: string, path: string): string {
  const isAbsoluteInput = path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)
  const resolved = isAbsoluteInput ? resolve(path) : resolve(workspace, path)
  if (!isAbsoluteInput) {
    const rel = relative(workspace, resolved)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new FsToolError("FS_NOT_FOUND", `path escapes workspace: ${path}`)
    }
  }
  return resolved
}

/**
 * Refuse a write the session's sandbox policy forbids.
 *
 * Called at EVERY write point in this package and in patch.ts. `resolvePath`
 * cannot carry this: it is a pure path function with no policy, and its escape
 * check is skipped for absolute inputs by design, so an absolute path bypassed
 * confinement entirely while the shell sandbox refused the same write.
 *
 * STILL SYNCHRONOUS, and `modeOverride` is a MODE rather than a context on
 * purpose: `applyPatch` calls this once per hunk (patch.ts:186-189), so anything
 * awaited in here would run once per hunk. The escalation ladder is therefore
 * awaited ONCE PER CALL in the tool body, and only its resulting mode travels
 * down; `"allowed-once"` means one call, not one hunk.
 */
function guardWrite(deps: FsToolDeps, target: string, modeOverride?: SandboxMode): void {
  if (deps.writeGuard === undefined) return
  const decision = deps.writeGuard(target, modeOverride)
  if (!decision.ok) throw new FsToolError("FS_SANDBOX_DENIED", JSON.stringify(decision.denial))
}

/**
 * Run the escalation ladder ONCE for this call, at the top of a write tool's
 * body (spec §3.3; `@i-harness/sandbox`'s `resolveCallPolicy`).
 *
 * The APPROVER comes from deps — the assembly builds it once, because it is a
 * pure function of the plugin context — while the CONTEXT is composed here,
 * because this is the only layer that holds a `ToolExec` and therefore the only
 * one that can name the call (`callId`) and route the signal. A context built at
 * mount time could not tell the human which call they are approving.
 *
 * A refusal is RETURNED as a VALUE, never thrown: a throwing tool body fails the
 * whole turn and appends no `tool/result`, so the model would read a hung call
 * instead of an answer (`./error.ts:19-31`). And the refusal is returned AS THE
 * LADDER BUILT IT — it is not re-made here, because the denial's missing
 * `escalation` sentence is exactly what branches 1/5/6 of the ladder exist to
 * withhold (spec §3.2 corollary 2).
 */
async function resolveWriteCall(
  deps: FsToolDeps,
  exec: ToolExec,
  toolName: string,
  args: { sandbox_permissions?: string; justification?: string },
  subject: string,
): Promise<{ kind: "proceed"; mode: SandboxMode | undefined } | { kind: "refused"; failure: FsToolFailure }> {
  const escalation = deps.escalationApprover === undefined
    ? undefined
    : {
        approver: deps.escalationApprover,
        agent: exec,
        callId: exec.callId ?? "unknown",
        toolName,
        ...(exec.abortSignal !== undefined ? { signal: exec.abortSignal } : {}),
      }
  const resolution = await resolveCallPolicy({
    base: deps.sandboxPolicy?.(),
    surface: "fs",
    subject,
    args,
    ...(escalation !== undefined ? { escalation } : {}),
  })
  if (resolution.kind === "refused") {
    const denial = resolution.denial
    return { kind: "refused", failure: { error: denialMessage(denial), code: denial.code, denial } }
  }
  // `undefined` when the host requested no sandbox at all (branch 3 of the
  // ladder): there is no mode to hand down, and nothing is confined anyway.
  return { kind: "proceed", mode: resolution.policy?.mode }
}

/** The model-facing sentence: the reason, plus the recovery route when the
 *  refusal has one. A reader that only looks at `error` still learns what to do
 *  (the structured `denial` rides alongside it for a reader that parses). */
function denialMessage(denial: SandboxDenial): string {
  return denial.escalation === undefined ? denial.reason : `${denial.reason} ${denial.escalation}`
}

export interface FsToolDeps {
  workspace: string
  /** M16: WRITE confinement. The assembly builds this from the session's sandbox
   *  policy; absent means unconfined, which is the pre-M16 behavior a host that
   *  never requested a sandbox gets.
   *
   *  It is a predicate rather than the policy object so this package stays
   *  unaware of the sandbox RESOLVER (no policy, no session, no mode table):
   *  the caller resolves the mode in force and hands down only the verdict.
   *
   *  M62: the refusal is the shared `SandboxDenial` (from @i-harness/sandbox),
   *  not a bare reason string. Rewritten 2026-09-15 (Task B): the previous
   *  version claimed `denialFor`'s only production caller was this guard, that
   *  the shell "still refuses the old way", and that the other surfaces were
   *  "declared but unreached". Every clause had become false. Two questions are
   *  easy to conflate here, so keep them apart:
   *
   *  1. WHO CALLS `denialFor` — the assembly's write guard (surface "fs") and
   *     `packages/terminal/src/tool.ts` (surface "terminal", which names
   *     `danger-full-access` explicitly because a PTY is refused in EVERY
   *     confined mode).
   *  2. WHO EMITS THIS SHAPE — those two, PLUS the shell, which builds a
   *     `SandboxDenial` literal by hand (`packages/shell/src/index.ts`) because
   *     there the problem is that no backend is usable at all rather than that
   *     the mode is narrow, so escalation guidance would be a dead end.
   *     `"search"` is the one surface still unwired, deliberately (spec §3.4).
   *
   *  The claim made HERE is narrower than either: a refusal from THIS surface has
   *  the machine-readable shape. `guardWrite` serializes it into the failure
   *  message (`FS_SANDBOX_DENIED`, kept byte-identical for existing readers),
   *  and the ladder's refusal is returned as a typed `FsToolFailure.denial`
   *  alongside it.
   *
   *  Only writes are gated. Reads are unrestricted on every backend — bwrap binds
   *  the whole root read-only, the Windows backend documents reads as
   *  unrestricted — so refusing a read here would be stricter than the shell
   *  sandbox while `cat` still reached the file: a false claim of isolation
   *  rather than the real absence of it. */
  writeGuard?: (absPath: string, modeOverride?: SandboxMode) =>
    | { ok: true }
    | { ok: false; denial: import("@i-harness/sandbox").SandboxDenial }
  /**
   * M62: the session's sandbox policy, read PER CALL — the SAME thunk the shell
   * and the terminal receive, so the mode the ladder escalates FROM is the mode
   * `writeGuard` later judges under. A second resolver here could escalate from
   * one mode while the operation was judged under another.
   *
   * Absent (or `undefined` from the thunk) means the host requested no sandbox:
   * the ladder then has no mode to escalate from and the call proceeds as it
   * always did (spec §3.3 point 5).
   */
  sandboxPolicy?: () => SandboxExecutionPolicy | undefined
  /**
   * M62: the approval-service ADAPTER, not a prebuilt context — the assembly
   * builds it once (a pure function of the plugin context), and each tool body
   * composes the per-call `EscalationContext` from its own `ToolExec`. Absent
   * means no approval channel: an escalation request is then REFUSED (fail
   * closed), never silently allowed.
   */
  escalationApprover?: EscalationApprover<unknown, string>
  /** M42 rewind (G1): optional pre-image sink at the write points — absent ⇒
   * byte-identical behavior (zero cost). Present ⇒ every write tool captures
   * the BEFORE content it is about to overwrite (write does ONE extra read —
   * only when wired; edit/apply_patch already hold the bytes from their
   * read-modify-write path) and the tool result carries preImageRef/isNewFile
   * (additive — the log is the rewind channel, spec §2). The sink's take
   * returns the restore-blob id the result reports; capture failure must never
   * change tool behavior (untracked, honest). */
  rewind?: RewindCapture
}

// M42: workspace-relative key for rewind capture — null when the target
// escapes the workspace (absolute inputs / `..`) — the recorder is
// workspace-scoped, so such writes proceed UNTRACKED (honest).
function relForRewind(workspace: string, target: string): string | null {
  const rel = relative(workspace, target)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null
  return rel.replaceAll("\\", "/")
}

async function capturePreimage(
  rewind: RewindCapture,
  workspace: string,
  target: string,
): Promise<{ preImageRef?: string; isNewFile?: boolean; beforeBytes?: Uint8Array | null }> {
  const rel = relForRewind(workspace, target)
  if (rel === null) return {}
  let before: Uint8Array | null
  try {
    before = new Uint8Array(await readFile(target))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") before = null
    else return {} // unreadable pre-image → write proceeds untracked (honest)
  }
  const r = rewind.take(rel, before)
  const captured = r.blobId !== null || r.isNewFile
  return captured
    ? { preImageRef: r.blobId ?? undefined, isNewFile: r.isNewFile, beforeBytes: before }
    : {}
}

// M49: the structured diff for a write — before/after are known only when the
// rewind pre-image was read (existing file); decode failures or new files
// yield no `change` (only when before AND after are known).
function decodeUtf8Safely(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

// M62 Task 3: the denial this package returns (`guardWrite` → `SandboxDenial`)
// tells the model, in words, to "retry it with sandbox_permissions set to … and
// a justification". Until the two properties below were declared on each
// write-capable schema, that advice named arguments no schema defined — a model
// could not act on it. They are OPT-IN and stay out of `required` (their absence
// is the normal case); they are DECLARED here rather than validated, because
// wiring a granted escalation to a single call is the escalation-ladder task,
// not this one. Literal per schema rather than one shared object, so no schema's
// declaration can move by editing another's.

export function createFsTools(deps: FsToolDeps): Tool[] {
  const read: Tool<{ path: string }, { content: string } | FsToolFailure> = {
    name: "read",
    description: "read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async ({ path }) => softFail(async () => ({ content: await readFile(resolvePath(deps.workspace, path), "utf-8") })),
  }
  const write: Tool<{ path: string; text: string; sandbox_permissions?: string; justification?: string }, { ok: boolean; preImageRef?: string; isNewFile?: boolean; change?: TextDiff } | FsToolFailure> = {
    name: "write",
    description: "write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" }, sandbox_permissions: { type: "string", enum: [...ESCALATION_TARGETS], description: "request a wider sandbox mode for THIS call when a denial says the operation needs one" }, justification: { type: "string", description: "why the wider mode is required; shown to whoever approves the request" } }, required: ["path", "text"] },
    isReadOnly: false,
    execute: async ({ path, text, sandbox_permissions, justification }, exec: ToolExec) => softFail(async () => {
      // M62: the ladder runs ONCE here, before any guard invocation — never
      // inside `guardWrite`, which apply_patch calls per hunk. The resolved
      // target names the operation in the approval prompt.
      const target = resolvePath(deps.workspace, path)
      const ladder = await resolveWriteCall(deps, exec, "write", { sandbox_permissions, justification }, `write to ${target}`)
      if (ladder.kind === "refused") return ladder.failure
      guardWrite(deps, target, ladder.mode)
      // M42 rewind: writeFileAtomic OVERWRITES without reading — when rewind
      // is wired, do one extra read (ENOENT ⇒ new file); otherwise zero cost.
      const captured = deps.rewind !== undefined
        ? await capturePreimage(deps.rewind, deps.workspace, target)
        : {}
      await writeFile(target, text, "utf-8")
      const { beforeBytes, preImageRef, isNewFile } = captured
      const out: { ok: boolean; preImageRef?: string; isNewFile?: boolean; change?: TextDiff } = { ok: true }
      if (preImageRef !== undefined) out.preImageRef = preImageRef
      if (isNewFile !== undefined) out.isNewFile = isNewFile
      if (beforeBytes !== undefined && beforeBytes !== null) {
        // M49: reuse the pre-image read for the diff (no second unbounded read)
        const beforeText = decodeUtf8Safely(beforeBytes)
        if (beforeText !== undefined) out.change = createTextDiff(path, beforeText, text)
      }
      return out
    }),
  }
  const list_dir: Tool<{ path: string }, { entries: string[] } | FsToolFailure> = {
    name: "list_dir",
    description: "list a directory",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async ({ path }) => softFail(async () => ({ entries: await readdir(resolvePath(deps.workspace, path)) })),
  }
  const edit: Tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean; observedMtimeMs?: number; sandbox_permissions?: string; justification?: string }, { ok: boolean; path: string; replacements: number; change: TextDiff; preImageRef?: string; isNewFile?: boolean } | FsToolFailure> = {
    name: "edit",
    description: "edit a file by literal string replacement (single occurrence unless replace_all)",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
        observedMtimeMs: { type: "number", description: "optional mtime observed from read; mismatch → reject (stale)" },
        sandbox_permissions: { type: "string", enum: [...ESCALATION_TARGETS], description: "request a wider sandbox mode for THIS call when a denial says the operation needs one" },
        justification: { type: "string", description: "why the wider mode is required; shown to whoever approves the request" },
      },
      required: ["path", "old_string", "new_string"],
    },
    isReadOnly: false,
    execute: async ({ path, old_string, new_string, replace_all = false, observedMtimeMs, sandbox_permissions, justification }, exec: ToolExec) => softFail(async () => {
      const target = resolvePath(deps.workspace, path)
      const ladder = await resolveWriteCall(deps, exec, "edit", { sandbox_permissions, justification }, `write to ${target}`)
      if (ladder.kind === "refused") return ladder.failure
      guardWrite(deps, target, ladder.mode)
      if (old_string === "") throw new FsToolError("FS_AMBIGUOUS_EDIT", "ambiguous: old_string must not be empty")
      const { stat, readFile } = await import("node:fs/promises")
      let st
      try {
        st = await stat(target)
      } catch {
        throw new FsToolError("FS_NOT_FOUND", `file not found: ${path}`)
      }
      if (!st.isFile()) throw new FsToolError("FS_NOT_REGULAR_FILE", `not a regular file: ${path}`)
      if (observedMtimeMs !== undefined && Math.floor(st.mtimeMs) !== observedMtimeMs) {
        throw new FsToolError("FS_STALE_VERSION", `file changed since it was read (observed ${observedMtimeMs}, now ${Math.floor(st.mtimeMs)}) — re-read then retry`)
      }
      if (old_string === new_string) throw new FsToolError("FS_AMBIGUOUS_EDIT", "ambiguous: old_string must differ from new_string (no-op)")
      const raw = await readFile(target)
      const text = assertTextData(raw) // throws FS_NOT_REGULAR_FILE on binary/UTF-8
      const style = detectLineEndings(text)
      const normalized = normalizeLineEndings(text)
      const result = applyLiteralEdit(normalized, normalizeLineEndings(old_string), normalizeLineEndings(new_string), replace_all)
      if ("error" in result) {
        if (result.error === "not_found") throw new FsToolError("FS_EDIT_NOT_FOUND", `old_string not found in ${path}`)
        throw new FsToolError("FS_AMBIGUOUS_EDIT", `ambiguous: matched ${result.count} times in ${path}; provide more specific old_string or set replace_all`)
      }
      const finalText = restoreLineEndings(result.text, style)
      // TOCTOU re-check：read 後、rename 前 re-stat，比對 {mtimeMs,size} 快照（M21 §4.2）
      let stAfter
      try {
        stAfter = await stat(target)
      } catch {
        throw new FsToolError("FS_NOT_FOUND", `file disappeared during edit: ${path}`)
      }
      assertSnapshotFresh({ mtimeMs: st.mtimeMs, size: st.size }, { mtimeMs: stAfter.mtimeMs, size: stAfter.size })
      // M42 rewind: the loaded pre-image (raw, before mutation) captured here —
      // right after the TOCTOU check, right before the write.
      let preImageRef: string | undefined
      if (deps.rewind !== undefined) {
        const rel = relForRewind(deps.workspace, target)
        if (rel !== null) {
          const r = deps.rewind.take(rel, raw)
          if (r.blobId !== null) preImageRef = r.blobId
        }
      }
      await writeFileAtomic(target, finalText)
      return {
        ok: true,
        path,
        replacements: result.replacements,
        // M49: the loaded pre-image (normalized) and the post-edit text are
        // both known — the change is always present (checked, bounded).
        change: createTextDiff(path, normalized, result.text),
        ...(preImageRef !== undefined ? { preImageRef } : {}),
        ...(deps.rewind !== undefined ? { isNewFile: false } : {}),
      }
    }),
  }
  const apply_patch: Tool<{ patch_content: string; sandbox_permissions?: string; justification?: string }, { ok: boolean; applied: { path: string; action: string; change?: TextDiff }[]; errors: { path: string; message: string }[]; change?: TextDiff; changes?: TextDiff[]; rawPatch?: string } | FsToolFailure> = {
    name: "apply_patch",
    description: "apply a multi-file structured patch (*** Begin/End Patch + Add/Delete/Update + @@ context)",
    inputSchema: { type: "object", properties: { patch_content: { type: "string" }, sandbox_permissions: { type: "string", enum: [...ESCALATION_TARGETS], description: "request a wider sandbox mode for THIS call when a denial says the operation needs one" }, justification: { type: "string", description: "why the wider mode is required; shown to whoever approves the request" } }, required: ["patch_content"] },
    isReadOnly: false,
    execute: async ({ patch_content, sandbox_permissions, justification }, exec: ToolExec) => softFail(async () => {
      // CRLF 正規化：patch 內容若帶 \r，parsePatch 會把 \r 當行內容 → replace 誤報
      // FS_EDIT_NOT_FOUND、純 add 寫入字面 \r。先統一成 LF 再解析。
      const hunks = parsePatch(normalizeLineEndings(patch_content))
      // M62: the ladder runs ONCE for this call, before the first hunk is
      // guarded. Awaiting it inside the guard would ask the human once per hunk
      // — a five-hunk patch would raise five prompts for one tool call, and each
      // grant is `"allowed-once"`: one CALL, not one hunk. The subject names the
      // operation when the patch has one path, and the number of files when it
      // does not (a multi-file patch has no single path for Layer-2-style
      // classification; naming the count is honest, naming one file would not be).
      const subject = hunks.length === 1 && hunks[0] !== undefined
        ? `write to ${hunks[0].path}`
        : `apply a patch touching ${hunks.length} files`
      const ladder = await resolveWriteCall(deps, exec, "apply_patch", { sandbox_permissions, justification }, subject)
      if (ladder.kind === "refused") return ladder.failure
      // patch.ts 不 import index.ts（循環）——resolve 由這裡傳入；rewind sink 透傳
      const { applied, errors } = await applyPatch((path) => resolvePath(deps.workspace, path), hunks, deps.rewind, (target) => guardWrite(deps, target, ladder.mode))
      // M49: aggregate per-file changes when the parser exposed before/after
      // (update hunks); anything else keeps the original patch text as rawPatch.
      const result: { ok: boolean; applied: { path: string; action: string; change?: TextDiff }[]; errors: { path: string; message: string }[]; change?: TextDiff; changes?: TextDiff[]; rawPatch?: string } = {
        ok: errors.length === 0,
        applied,
        errors,
      }
      const withChange = applied.filter((entry) => entry.change !== undefined)
      if (applied.length === 1 && withChange.length === 1) result.change = withChange[0]!.change
      else if (applied.length > 1 && withChange.length === applied.length) result.changes = withChange.map((entry) => entry.change!)
      if (withChange.length < applied.length) result.rawPatch = patch_content
      return result
    }),
  }
  return [read, edit, write, apply_patch, list_dir]
}
