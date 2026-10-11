import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { createExecService } from "@i-harness/exec"
import { createTerminalService, type TerminalRunSpec, type TerminalView } from "../../src/service.ts"

// Run in the owned launcher process, so the inherited Windows Ctrl+C attribute
// reaches the native helper without changing the test runner's console state.
const execution = createExecService()
const terminal = createTerminalService(execution)
const evidencePath = process.env.IH_CONPTY_INT_FIXTURE_EVIDENCE
const evidence: { controllerPid: number; childPid?: number; ready?: boolean; cleanupComplete: boolean; root?: TerminalView["root"]; settlement?: TerminalView["settlement"] } = {
  controllerPid: process.pid, cleanupComplete: false,
}
const record = () => { if (evidencePath) writeFileSync(evidencePath, JSON.stringify(evidence)) }
let opened: TerminalRunSpec | undefined
const deadline = Number(process.env.IH_CONPTY_INT_FIXTURE_DEADLINE ?? Date.now() + 8_000)
assert(Number.isSafeInteger(deadline) && deadline > 0)
const admission = new AbortController()
let phase = "admission"
const timeoutError = () => new Error(`ConPTY ${phase} exceeded the shared fixture deadline: ${JSON.stringify({
  runtime: process.execPath, version: process.version,
  output: opened && terminal.list().some(row => row.id === opened!.id) ? terminal.read(opened.id) : undefined,
  view: terminal.list(),
})}`)
let timer: ReturnType<typeof setTimeout>
const watchdog = new Promise<never>((_resolve, reject) => {
  timer = setTimeout(() => { admission.abort("timeout"); reject(timeoutError()) }, Math.max(0, deadline - Date.now()))
})
record()
const body = async () => {
  const script = process.env.IH_CONPTY_INT_FIXTURE_MODE === "missing-int"
    ? "process.on('SIGINT',()=>{});setTimeout(()=>console.log('INT_READY'),5000);setInterval(()=>{},1000)"
    : "process.on('SIGINT',()=>{console.log('INT_RECEIVED');process.exit(23)});console.log('INT_READY');setInterval(()=>{},1000)"
  opened = await terminal.open({ command: process.execPath, args: ["-e", script] }, { abortSignal: admission.signal })
  const id = opened.id
  evidence.childPid = opened.pid
  record()
  const until = async (marker: string) => {
    phase = marker
    while (Date.now() < deadline) {
      if (terminal.read(id).data.includes(marker)) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw timeoutError()
  }
  await until("INT_READY")
  evidence.ready = true
  record()
  phase = "INT request"
  await terminal.signal(id, "INT")
  await until("INT_RECEIVED")
  phase = "root exit"
  const root = await terminal.waitExited(id)
  assert.equal(root.exitCode, 23)
  phase = "settlement"
  const closed = await terminal.close(id)
  evidence.root = closed.root
  evidence.settlement = closed.settlement
  assert.equal(closed.settlement?.kind, "settled")
  console.log(JSON.stringify({ root, settlement: closed.settlement }))
}
try {
  // The parent sets this absolute deadline before PowerShell startup. All body
  // phases share it, leaving the existing outer deadline time for native drain.
  await Promise.race([body(), watchdog])
} finally {
  clearTimeout(timer!)
  const failures: unknown[] = []
  try {
    if (opened && terminal.list().some(row => row.id === opened!.id)) {
      const closed = await terminal.close(opened.id)
      evidence.root = closed.root
      evidence.settlement = closed.settlement
    }
  } catch (error) { failures.push(error) }
  for (const dispose of [() => terminal.dispose(), () => execution.dispose()]) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  evidence.cleanupComplete = failures.length === 0
  record()
  if (failures.length) throw new AggregateError(failures, "ConPTY fixture cleanup incomplete")
}
