import { registerRetainedOutput, retainedOutputReader } from "@i-harness/exec"
import { createTextRetainer, createSpillStore, spillNotice, type SpillStore } from "@i-harness/output-retention"
import type { ShellToolDeps } from "../types.ts"

export function createResultRetention(deps: Pick<ShellToolDeps, "retention">) {
  // Retention is OPT-IN: without `deps.retention` the tools behave exactly as
  // before. The resolved retainer here is only the "configured" flag — the
  // per-run helper builds FRESH retainers because they are one-accumulation
  // stateful objects (never reused across calls).
  const retention = deps.retention
    ? createTextRetainer({ maxBytes: deps.retention.maxBytes ?? 64_000, mode: deps.retention.mode })
    : null
  // spillStore 一次建、跨呼叫重用（寫檔無狀態；root 固定）
  const spillStore: SpillStore | undefined = deps.retention?.spill ? createSpillStore(deps.retention.spill) : undefined

  // Apply retention at the tool-return layer only: exec keeps the full stream.
  // The `truncated` marker is present ONLY when something was omitted.
  // label: per-tool spill 檔前綴（bash → "bash-stdout"、pwsh → "pwsh-stdout"）。
  // M21 A/B bridge：exec 層若啟用 spill，超限輸出已落檔且 `stdout` 只回 tail。
  // 此處的 retainer 只看到 tail（通常 ≤ 預算）→ 自身判 truncated:false；若不
  // 橋接 exec 的截斷狀態，A+B 同開會「静默截斷、無 notice」。因此輸入型別吃進
  // exec 的 stdoutSpillPath/truncated：任一標記視同截斷；有 exec spill 檔時
  // notice 直接指向該檔（完整原文已在），絕不再重複寫一份 shell spill。
  async function retainedRunResult(
    result: {
      stdout: string
      stderr: string
      exitCode: number
      stdoutSpillPath?: string
      truncated?: { stdout: boolean; stderr: boolean }
      sandboxDenial?: { signatures: readonly string[] }
    },
    label: string,
  ) {
    // M62 Task 3: `stderr` is carried here too (it used to be dropped). The
    // declared output shape now names it, and this branch is the one path where
    // the shape and the value disagreed — a stderr the caller can read is part of
    // the contract, not an artifact of whether retention happens to be on.
    const bind = <T extends object>(output:T):T => {
      const reader=retainedOutputReader(result)
      if(reader) registerRetainedOutput(output,reader)
      return output
    }
    if (retention === null) return bind({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, ...(result.sandboxDenial === undefined ? {} : { sandboxDenial: result.sandboxDenial }) })
    const so = createTextRetainer({ maxBytes: deps.retention!.maxBytes ?? 64_000, mode: deps.retention!.mode })
    const se = createTextRetainer({ maxBytes: deps.retention!.maxBytes ?? 64_000, mode: deps.retention!.mode })
    so.push(result.stdout)
    se.push(result.stderr)
    const rs = so.finish()
    const re = se.finish()
    // 截斷判定＝exec 層（spill 落檔或明確標記）與 retainer 層取聯集。
    const execTruncated = result.truncated?.stdout === true || result.stdoutSpillPath !== undefined
    const truncated = execTruncated || result.truncated?.stderr === true || rs.truncated || re.truncated
    let stdout = rs.text
    // Spill 檔優先用 exec 既有的（完整原文）；否則僅在 retainer 自身截斷 stdout
    // 且有設定 store 時寫一份。只在「真省略」時加 notice——僅 stderr 截斷時
    // stdout 原樣（未被省略），spill/notice 反而會把未截斷的 stdout 加上
    // "(Omitted 0 bytes…)"。
    const spillPathForNotice =
      result.stdoutSpillPath ??
      (rs.truncated && spillStore ? await spillStore.saveText(result.stdout, label) : undefined)
    if (spillPathForNotice !== undefined && (rs.truncated || execTruncated)) {
      // exec tail-only 時完整省略位元組數未知（exec 只回 tail）→ 以 0 標記並指向
      // 完整 spill 檔；retainer 自身截斷則回報精確省略數。
      const omittedForNotice = rs.truncated ? rs.omittedBytes : execTruncated ? 0 : 0
      stdout = rs.text + "\n" + spillNotice(omittedForNotice, spillPathForNotice)
    }
    let stderr = re.text
    let stdoutBytes = rs.omittedBytes, stderrBytes = re.omittedBytes
    const marker = "\n…(output omitted)…\n", markerBytes = Buffer.byteLength(marker), budget = deps.retention!.maxBytes ?? 64_000
    const retainWithMarker = (text: string) => {
      // Re-retain with the marker reserved so the tool result still respects
      // the configured byte budget (A-10 keeps the old size invariant).
      const retry = createTextRetainer({ maxBytes: Math.max(0, budget - markerBytes), mode: deps.retention!.mode })
      retry.push(text)
      return retry.finish()
    }
    if (spillPathForNotice === undefined && (rs.truncated || execTruncated)) {
      // A-10: without a spill file there was NO trace of the gap — a model could
      // read a severed stack trace/JSON as complete output. Always leave a
      // visible marker when bytes were omitted.
      const trimmed = retainWithMarker(result.stdout)
      stdout = trimmed.text + marker
      stdoutBytes = trimmed.omittedBytes
    }
    if (re.truncated || result.truncated?.stderr === true) {
      const trimmed = retainWithMarker(result.stderr)
      stderr = trimmed.text + marker
      stderrBytes = trimmed.omittedBytes
    }
    return bind({
      stdout,
      stderr,
      exitCode: result.exitCode,
      ...(truncated ? { truncated: { stdoutBytes, stderrBytes } } : {}),
      ...(result.sandboxDenial === undefined ? {} : { sandboxDenial: result.sandboxDenial }),
    })
  }
  // execute: `return retainedRunResult(result)`——async fn 回 promise 自動展平（既有呼叫面不變）

  return retainedRunResult
}

export type RetainedRunResult = ReturnType<typeof createResultRetention>
