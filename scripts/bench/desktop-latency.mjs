// Run with Node from .node-version: node --import tsx scripts/bench/desktop-latency.mjs
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs, promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { timingScope } from "../../packages/desktop-gateway/src/timing-trace.ts"
import { createJsonlBackend } from "../../packages/session-persistence-jsonl/src/index.ts"
import { createSessionCoordinator } from "../../packages/session-persistence/src/index.ts"

const { values } = parseArgs({ options: {
  exe: { type: "string" }, rounds: { type: "string", default: "3" }, "require-trace": { type: "boolean" },
  "live-config": { type: "string" }, "live-tool": { type: "boolean" },
  "soak-minutes": { type: "string" },
  recovery: { type: "boolean" },
} })
const live = values["live-config"]
const soakMinutes = Number(values["soak-minutes"] ?? 0)
assert(Number.isSafeInteger(soakMinutes) && soakMinutes >= 0 && soakMinutes <= 480 && !(soakMinutes && live), "Soak requires 1–480 minutes with the local fixture")
assert(!values.recovery || !soakMinutes && !live, "Recovery uses an independent local fixture")
const rounds = Number(values.rounds)
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 20, "rounds must be between 1 and 20")
const desktop = fileURLToPath(new URL("../../packages/desktop/", import.meta.url))
const packaged = values.exe && resolve(values.exe)
const electron = packaged || createRequire(join(desktop, "package.json"))("electron")
const root = await mkdtemp(join(tmpdir(), "ih-desktop-latency-"))
const probeRoot = await realpath(root)
const profile = join(root, "profile"), config = join(root, "config"), trace = join(root, "trace.jsonl")
const workspaces = ["a", "b"].map(id => ({ id, path: join(root, id), label: "Latency " + id.toUpperCase() }))
const write = (file, data) => writeFile(file, JSON.stringify(data))
const clock = () => performance.timeOrigin + performance.now()
const responseMarks = new Map()
const dual = new Map()
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/responses")
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const payload = Buffer.concat(chunks)
    const body = JSON.parse(payload.toString("utf8"))
    const tag = JSON.stringify(body.input).match(/fixture-latency-[a-z]+-\d+/g)?.at(-1)
    assert(tag, "Provider request lacks a fixture identity")
    const marks = responseMarks.get(tag) ?? []
    responseMarks.set(tag, marks)
    const mark = { received: clock(), inputBytes: payload.length }
    marks.push(mark)
    if (tag.includes("-drop-") || tag.includes("-cancel-")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.write("data: " + JSON.stringify({ type: "response.output_text.delta", delta: "Started " + tag }) + "\n\n")
      if (tag.includes("-drop-")) { await delay(100); response.destroy(); return }
      await once(response, "close")
      return
    }
    if (marks.length === 1 && tag.includes("-parallel")) {
      const token = tag.match(/\d+$/)[0]
      const barrier = dual.get(token) ?? { release: Promise.withResolvers(), count: 0 }
      dual.set(token, barrier)
      if (++barrier.count === 2) barrier.release.resolve()
      await Promise.race([barrier.release.promise, delay(15000, "expired", { ref: false }).then(() => { throw Error("Parallel fixture did not overlap") })])
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    const send = event => response.write("data: " + JSON.stringify(event) + "\n\n")
    if (marks.length === 1) {
      await delay(15)
      mark.responseEvent = clock()
      send({ type: "response.reasoning_summary_text.delta", item_id: "fixture-brief", summary_index: 0, delta: "Fixture reasoning" })
      await delay(15)
      mark.firstText = clock()
      send({ type: "response.output_text.delta", delta: "Started " + tag })
      await delay(80)
      send({ type: "response.output_item.added", output_index: 1,
        item: { id: "fn_" + tag, call_id: "call_" + tag, type: "function_call", name: "read", arguments: "" } })
      send({ type: "response.function_call_arguments.done", item_id: "fn_" + tag, output_index: 1, arguments: '{"path":"bench-source.txt"}' })
      send({ type: "response.output_item.done", output_index: 1,
        item: { id: "fn_" + tag, call_id: "call_" + tag, type: "function_call", name: "read", arguments: '{"path":"bench-source.txt"}' } })
    } else {
      assert.equal(marks.length, 2)
      assert(JSON.stringify(body.input).includes("fixture tool content"), "Expected the read tool result in the next provider request")
      send({ type: "response.output_text.delta", delta: "Finished " + tag })
    }
    send({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 6 } } })
    response.end()
  } catch {
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})
if (!live) {
  provider.listen(0, "127.0.0.1")
  await once(provider, "listening")
}

async function prepare() {
  await Promise.all([profile, config, ...workspaces.map(workspace => workspace.path)].map(path => mkdir(path)))
  const now = new Date().toISOString()
  await Promise.all([
    write(join(profile, "workspaces.json"), workspaces),
    write(join(profile, "projects.json"), { version: 1, projects: workspaces.map(workspace => ({
      id: "project-" + workspace.id, name: workspace.label, workspaceIds: [workspace.id], primaryWorkspaceId: workspace.id,
      createdAt: now, updatedAt: now,
    })) }),
    live ? cp(resolve(live), config, { recursive: true }) : write(join(config, "settings.json"), {
      autoTitle: false, approvalMode: "dangerous", sandboxMode: "read-only", sessionStore: "jsonl", compaction: { auto: false },
      codeMode: { mode: "off" }, llm: {
        defaultModel: { provider: "fixture", model: "fixture-responses" },
        providers: { fixture: { baseURL: "http://127.0.0.1:" + provider.address().port, protocol: "openai-responses",
          apiKeyEnv: "IH_BENCH_FIXTURE_KEY", models: [{ id: "fixture-responses", contextWindow: 128000 }] } },
      },
    }),
  ])
  for (const workspace of workspaces) {
    await writeFile(join(workspace.path, "bench-source.txt"), "fixture tool content")
    const directory = join(profile, "sessions", workspace.id)
    await mkdir(directory, { recursive: true })
    const writer = createSessionCoordinator(createJsonlBackend(directory), { lock: { enabled: true, lockRoot: directory } })
    try {
      for (const [id, title, turns] of [["empty", "Empty fixture " + workspace.id, 0], ["long", "Long fixture " + workspace.id, 700]]) {
        await writer.create({ sessionId: id, title })
        for (let index = 0; index < turns; index += 50) {
          const events = Array.from({ length: 50 }, (_, offset) => [
            { type: "turn/start" }, { type: "user/message", text: "Historical request " + (index + offset) },
            { type: "assistant/message", text: "Historical answer " + (index + offset) }, { type: "turn/end" },
          ]).flat()
          await writer.append(id, events)
        }
        await writer.putDocument("desktop-session-project-" + createHash("sha256").update(id).digest("hex"), { version: 1, projectId: "project-" + workspace.id })
      }
    } finally { await writer.close() }
  }
}

let child
let closed
let page
let debuggerPort
let stderr = ""
async function until(read, label, timeout = 45000) {
  const expires = performance.now() + timeout
  do {
    const value = await read()
    if (value) return value
    if (child?.exitCode != null) throw Error("Desktop exited during " + label + (live ? "" : ": " + stderr))
    await delay(25)
  } while (performance.now() < expires)
  throw Error("Timed out: " + label)
}
async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((open, reject) => {
    socket.addEventListener("open", open, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })
  return socket
}
const debug = path => fetch("http://127.0.0.1:" + debuggerPort + path, { signal: AbortSignal.timeout(5000) }).then(result => result.json())
async function launch() {
  let resolvePort
  const portFound = new Promise(resolve => { resolvePort = resolve })
  const env = { ...process.env, IH_CONFIG_DIR: config, IH_DESKTOP_TIMING_TRACE: trace, IH_BENCH_FIXTURE_KEY: "loopback-only" }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  child = spawn(electron, [...(packaged ? [] : [desktop]), "--user-data-dir=" + profile, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
    { cwd: desktop, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] })
  child.stderr.on("data", bytes => {
    stderr = (stderr + bytes).slice(-4000)
    const port = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1]
    if (port) resolvePort(Number(port))
  })
  closed = new Promise((done, fail) => { child.once("exit", done); child.once("error", fail) })
  debuggerPort = await Promise.race([portFound, closed.then(() => { throw Error(live ? "Desktop exited during launch" : stderr) }), delay(30000, 0, { ref: false })])
  assert(debuggerPort, "Electron did not start a loopback debugger")
  const target = await until(() => debug("/json/list").then(tabs => tabs.find(tab => tab.type === "page" && tab.url.startsWith("file:"))).catch(() => undefined), "Desktop renderer")
  page = await connect(target.webSocketDebuggerUrl)
  const callbacks = new Map()
  let serial = 0
  page.addEventListener("message", event => {
    const message = JSON.parse(event.data)
    const done = callbacks.get(message.id)
    if (done) done(message)
  })
  return async expression => {
    const id = ++serial
    const request = Promise.withResolvers()
    callbacks.set(id, request.resolve)
    page.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }))
    try {
      const reply = await Promise.race([request.promise, delay(10000, undefined, { ref: false })])
      if (!reply || reply.error || reply.result.exceptionDetails) throw Error(reply?.error?.message ?? reply?.result?.result?.description ?? "Renderer RPC failed")
      return reply.result.result.value
    } finally { callbacks.delete(id) }
  }
}
async function close() {
  if (!child || child.exitCode != null || child.signalCode != null) return
  if (!debuggerPort) { child.kill(); await closed.catch(() => {}); return }
  try {
    const browser = await connect((await debug("/json/version")).webSocketDebuggerUrl)
    browser.send(JSON.stringify({ id: 1, method: "Browser.close" }))
    assert.equal(await Promise.race([closed, delay(16000, "timeout", { ref: false })]), 0)
    browser.close()
  } catch (error) { child.kill(); await closed.catch(() => {}); throw error }
  finally { page?.close() }
}

async function processSample(pid) {
  if (process.platform !== "win32") return []
  const command = `
    $found = @(Get-CimInstance Win32_Process)
    $ids = @(${pid})
    for ($level=0; $level -lt 5; $level++) {
      $ids += @($found | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object ProcessId)
    }
    @(Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object {
      @{pid=$_.Id;name=$_.ProcessName;cpuSeconds=$_.CPU;workingSet=$_.WorkingSet64;privateBytes=$_.PrivateMemorySize64}
    }) | ConvertTo-Json -Compress -AsArray
  `
  const { stdout } = await promisify(execFile)("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 20000 })
  return stdout.trim() ? JSON.parse(stdout) : []
}

async function startRendererSampler(evaluate) {
  await evaluate(`(() => {
    const interval = 50
    let last = performance.now()
    const empty = () => ({ callbacks: 0, maxGapMs: 0, gapsOver100Ms: 0 })
    let sample = empty()
    const timer = setInterval(() => {
      const now = performance.now(), gap = now-last
      sample.callbacks++
      sample.maxGapMs = Math.max(gap, sample.maxGapMs)
      if (gap > 100) sample.gapsOver100Ms++
      last = now
    }, interval)
    window.ihSoakSample = () => {
      const taken = { ...sample, backgrounded: document.hidden, heapBytes: performance.memory?.usedJSHeapSize }
      sample = empty()
      return taken
    }
    window.addEventListener("pagehide", () => clearInterval(timer), { once: true })
  })()`)
}

async function verifyRecovery(evaluate) {
  const workspace = workspaces[0], session = "empty"
  await select(evaluate, workspace, session)
  await evaluate('window.ihDesktop.request({kind:"desktop/global-retry/configure",maxRetries:0})')
  const admission = async text => {
    const result = await evaluate(`window.ihDesktop.request({kind:"session/history",workspaceId:"a",sessionId:"empty",
      afterSeq:0,beforeSeq:Number.MAX_SAFE_INTEGER,limit:50}).then(result=>result.events
        .filter(event=>event.type==="agent/input/admitted"&&event.text===${JSON.stringify(text)}).length)`)
    assert.equal(result, 1, "One durable input for " + text)
  }
  const drop = "fixture-latency-drop-0"
  const marked = await submit(evaluate, drop)
  await until(() => evaluate(`window.ihDesktop.request({kind:"desktop/diagnostics/list",workspaceId:"a",sessionId:"empty"})
    .then(result=>result.entries.some(entry=>entry.kind==="session/error"&&entry.timestamp>=${Math.floor(marked)}))`), "transport failure is visible")
  await admission(drop)
  const cancel = "fixture-latency-cancel-0"
  await submit(evaluate, cancel)
  await until(() => responseMarks.get(cancel)?.length === 1, "held provider stream")
  await until(() => evaluate(`!!document.querySelector('.composer-send[data-state="running"]')`), "visible stop control")
  await evaluate(`document.querySelector('.composer-send[data-state="running"]').click()`)
  await until(() => evaluate(`!document.querySelector('.composer-send[data-state="running"]')`), "stopped execution")
  await admission(cancel)
  const retry = "fixture-latency-warm-0"
  await submit(evaluate, retry)
  await until(() => evaluate(`window.ihLatencySamples[${JSON.stringify(retry)}]?.finished`), "subsequent reply")
  await admission(retry)
  return { transportFailureVisible: true, stoppedFromComposer: true, subsequentReply: true, admissions: 3 }
}
const projectRow = label => `[...document.querySelectorAll(".project-sidebar-project-select")].find(el => el.textContent.trim() === ${JSON.stringify(label)})`
const sessionRow = title => `[...document.querySelectorAll(".project-sidebar-sessions .row-button")].find(el => el.querySelector(".row-label")?.textContent === ${JSON.stringify(title)})`
const sendButton = 'button.composer-send[data-can-send="1"]'
async function select(evaluate, workspace, session) {
  const selectedProject = projectRow(workspace.label)
  await until(() => evaluate(`Boolean(${selectedProject})`), "visible project")
  const start = await evaluate(`(() => { const start = performance.timeOrigin + performance.now(); (${selectedProject}).click(); return start })()`)
  await until(() => evaluate(`(${selectedProject})?.getAttribute("aria-current") === "true"`), "selected project")
  const row = sessionRow((session === "empty" ? "Empty fixture " : "Long fixture ") + workspace.id)
  await until(() => evaluate(`Boolean(${row})`), "catalog row")
  const listed = await evaluate("performance.timeOrigin + performance.now()")
  await evaluate(`(${row}).click()`)
  try {
    await until(() => evaluate(`(${row})?.getAttribute("aria-current") === "true" && !!document.querySelector(${JSON.stringify(sendButton)}) && !!document.querySelector(".connection-online")`), "ready composer", live ? 25000 : 45000)
  } catch (error) {
    if (!live) throw error
    const gate = await evaluate(`(async () => {
      const scope = { workspaceId:${JSON.stringify(workspace.id)}, sessionId:${JSON.stringify(session)} }
      const results = await Promise.allSettled([
        window.ihDesktop.request({kind:"session/model/state", ...scope}),
        window.ihDesktop.request({kind:"workspace/sandbox/state", workspaceId:scope.workspaceId}),
      ])
      const model = results[0].value
      const reason = typeof model?.reason === "string" ? model.reason : ""
      return { modelStatus: model?.status ?? results[0].status,
        modelReason: /credential|secret|token|api\W*key/i.test(reason) ? "credentials" : /no model|unconfigured|not configured/i.test(reason) ? "configuration" : "other",
        sandboxWired: results[1].value?.wired === true, online: !!document.querySelector(".connection-online") }
    })()`)
    throw new Error("Live composer unavailable " + JSON.stringify(gate))
  }
  return { listedAfterMs: listed - start, readyAfterMs: (await evaluate("performance.timeOrigin + performance.now()")) - start }
}
async function submit(evaluate, tag, prompt = tag) {
  await evaluate(`(() => {
    const input = document.querySelector(".composer-input")
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(prompt)})
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })()`)
  await until(() => evaluate(`!document.querySelector(${JSON.stringify(sendButton)})?.disabled && document.querySelector(${JSON.stringify(sendButton)})?.dataset.payload === "1"`), "editable draft settled")
  return evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(sendButton)})
    const tag = ${JSON.stringify(tag)}
    window.ihLatencySamples ??= Object.create(null)
    const sample = { pressed: performance.timeOrigin + performance.now() }
    window.ihLatencySamples[tag] = sample
    const next = () => {
      const text = [...document.querySelectorAll(".timeline-assistant")].filter(el => el.getClientRects().length > 0).map(el => el.innerText)
      const at = performance.timeOrigin + performance.now()
      if (text.some(line => ${Boolean(live)} ? !!line.trim() : line.includes("Started " + tag))) sample.firstText ??= at
      if (text.some(line => line.includes("Finished " + tag))) sample.finished ??= at
      if (!sample.finished && at - sample.pressed < 60000) requestAnimationFrame(next)
    }
    target.click()
    requestAnimationFrame(next)
    return sample.pressed
  })()`)
}
async function waitForParallelReply(evaluate, workspace, tag) {
  let checkedAt = 0
  return until(async () => {
    const key = JSON.stringify(tag)
    const sample = await evaluate(`window.ihLatencySamples[${key}]`)
    if (sample?.finished) return sample
    // When the OS throttles a background window it may not deliver a paint
    // sample. Use a separate durable observation during soak and keep the
    // missing paint visible in the report.
    if (soakMinutes && sample && Date.now() - sample.pressed > 10_000 && Date.now() >= checkedAt + 5000) {
      checkedAt = Date.now()
      const completed = await evaluate(`window.ihDesktop.request({kind:"session/history",workspaceId:${JSON.stringify(workspace.id)},
        sessionId:"long",afterSeq:0,beforeSeq:Number.MAX_SAFE_INTEGER,limit:40})
        .then(history=>history.events.some(event=>event.type==="assistant/message"&&event.text.includes("Finished "+${key})))`)
      if (completed) return { ...sample, finished: clock(), paintMissing: true }
    }
    return undefined
  }, "parallel " + workspace.id + " finished")
}
function summarize(trials, traces) {
  const round = value => value === undefined ? undefined : Number(value.toFixed(1))
  return trials.map(trial => {
    const marks = traces.filter(line => line.scope === timingScope(trial.workspace.path, trial.session) && line.at >= trial.pressed && line.at <= trial.finished)
    const issued = marks.find(mark => mark.phase === "provider-issued")
    const phase = (name, attempt) => marks.find(mark => mark.phase === name && (!attempt || mark.attempt === attempt))?.at
    if (values["require-trace"] || live) {
      const phases = ["gateway-received", "gateway-admitted", "provider-issued", "provider-first-event", "provider-first-text"]
      if (!live || values["live-tool"]) phases.push("tool-start")
      for (const name of phases)
      assert(marks.some(mark => mark.phase === name), `Missing ${name} for ${trial.tag}`)
    }
    if (!live && !soakMinutes && trial.scenario !== "parallel-background") assert(trial.firstText, "Expected to observe the first content while selected")
    const offset = at => at === undefined ? undefined : round(at - trial.pressed)
    const loopback = responseMarks.get(trial.tag)
    if (!live) assert.equal(loopback?.length, 2, "The fixture must exercise one tool, then a second provider request")
    return { scenario: trial.scenario, tag: trial.tag,
      workspaceToListMs: round(trial.activation.listedAfterMs), workspaceToComposerMs: round(trial.activation.readyAfterMs),
      gatewayReceivedMs: offset(phase("gateway-received")), gatewayAdmittedMs: offset(phase("gateway-admitted")),
      turnStartMs: offset(phase("turn-start")), requestProjectedMs: offset(phase("request-projected")), requestAssessedMs: offset(phase("request-assessed")),
      providerIssuedMs: offset(issued?.at), providerEventMs: offset(phase("provider-first-event", issued?.attempt)),
      providerTextMs: offset(phase("provider-first-text", issued?.attempt)), firstToolMs: offset(phase("tool-start")),
      firstTextInFrameMs: offset(trial.firstText),
      ...(trial.paintMissing ? { finalPaintMissing: true, durableReplyObservedMs: offset(trial.finished) } : { finalTextInFrameMs: offset(trial.finished) }),
      ...(loopback ? { fixtureReceivedMs: offset(loopback[0].received), fixtureFirstTextMs: offset(loopback[0].firstText),
        fixtureNextRequestMs: offset(loopback[1].received), inputBytes: loopback[0].inputBytes } : {}) }
  })
}

async function runLatency(evaluate) {
  const trials = []
  const soakSamples = []
  const started = performance.now()
  const deadline = started + soakMinutes * 60_000
  let nextSample = started
  const heartbeatFile = join(root, "soak-heartbeat.jsonl")
  if (soakMinutes) {
    await startRendererSampler(evaluate)
    await appendFile(heartbeatFile, JSON.stringify({ startedAt: new Date().toISOString(), minutes: soakMinutes, pid: child.pid }) + "\n")
    console.log(JSON.stringify({ root, heartbeatFile, pid: child.pid, minutes: soakMinutes }))
  }
  async function run(workspace, session, scenario, round) {
    const tag = `fixture-latency-${scenario}-${round}`
    const activation = await select(evaluate, workspace, session)
    await submit(evaluate, tag)
    trials.push({ workspace, session, scenario, tag, activation,
      ...await until(() => evaluate(`window.ihLatencySamples[${JSON.stringify(tag)}]?.finished && window.ihLatencySamples[${JSON.stringify(tag)}]`), tag) })
  }
  if (live) {
    const tag = "fixture-latency-live-0"
    const workspace = workspaces[0], session = "empty"
    const activation = await select(evaluate, workspace, session)
    const retries = await evaluate('window.ihDesktop.request({kind:"desktop/global-retry/configure", maxRetries:0})')
    assert.equal(retries.maxRetries, 0, "The explicit live probe requires automatic retries off")
    const prompt = values["live-tool"] ? "Use the read tool exactly once on bench-source.txt. Then reply with the single line Finished " + tag
      : "Reply with the single line Finished " + tag + ". Use no tools."
    await submit(evaluate, tag, prompt)
    const sample = await until(async () => {
      const state = await evaluate(`window.ihLatencySamples[${JSON.stringify(tag)}]`)
      if (state?.finished) return state
      const rejected = await evaluate(`window.ihDesktop.request({kind:"desktop/diagnostics/list",workspaceId:"a",sessionId:"empty"}).then(result =>
        result.entries.some(entry => entry.timestamp >= ${Math.floor(state?.pressed ?? Date.now())} && ["session/error", "session/cancelled", "gateway/disconnected"].includes(entry.kind)))`)
      if (rejected) throw Error("The single live request did not complete. Inspect the sanitized native timing trace.")
      return undefined
    }, tag)
    trials.push({ workspace, session, scenario: values["live-tool"] ? "live-read" : "live-text", tag, activation, ...sample })
  } else {
    await run(workspaces[0], "empty", "cold", 0)
    for (let index = 0; index < rounds; index++) await run(workspaces[0], "empty", "warm", index)
  }
  for (let index = 0; !live && (index < rounds || soakMinutes && performance.now() < deadline); index++) {
    const a = "fixture-latency-parallela-" + index
    const b = "fixture-latency-parallelb-" + index
    const startA = await select(evaluate, workspaces[0], "long")
    await submit(evaluate, a)
    await until(() => responseMarks.get(a)?.length === 1, "first concurrent request")
    const startB = await select(evaluate, workspaces[1], "long")
    await submit(evaluate, b)
    const sampleB = await waitForParallelReply(evaluate, workspaces[1], b)
    await select(evaluate, workspaces[0], "long")
    const sampleA = await waitForParallelReply(evaluate, workspaces[0], a)
    trials.push({ workspace: workspaces[0], session: "long", scenario: "parallel-background", tag: a, activation: startA, ...sampleA })
    trials.push({ workspace: workspaces[1], session: "long", scenario: "parallel-foreground", tag: b, activation: startB, ...sampleB })
    if (soakMinutes) {
      await evaluate(`(() => {
        delete window.ihLatencySamples[${JSON.stringify(a)}]
        delete window.ihLatencySamples[${JSON.stringify(b)}]
      })()`)
      if (performance.now() >= nextSample || performance.now() >= deadline) {
        let renderer = await evaluate("window.ihSoakSample?.() ?? null")
        if (!renderer) {
          await startRendererSampler(evaluate)
          renderer = { ...await evaluate("window.ihSoakSample()"), reset: true }
        }
        const sample = {
          elapsedMs: Math.round(performance.now() - started), parallelCycles: index + 1,
          renderer, processes: await processSample(child.pid),
        }
        soakSamples.push(sample)
        await appendFile(heartbeatFile, JSON.stringify(sample) + "\n")
        console.log(JSON.stringify(sample))
        nextSample = performance.now() + 60_000
      }
      const rest = Math.min(20_000, deadline - performance.now())
      if (rest > 0) await delay(rest)
    }
  }
  if (soakMinutes) assert(performance.now() >= deadline, "Soak must reach the requested duration")
  await close()
  const records = await readFile(trace, "utf8").then(text => text.trimEnd().split("\n").map(line => JSON.parse(line)), error => {
    if (error.code !== "ENOENT") throw error
    return []
  })
  const report = { root, executable: electron, fixture: live ? "explicit live provider profile" : "local Responses with a read tool", rounds: live ? 1 : rounds,
    ...(soakMinutes ? { soakMinutes, soakSamples } : {}),
    rendererMeasurement: "First animation frame with the expected visible DOM text. Background A may be restored from history.",
    trials: summarize(trials, records) }
  return report
}

try {
  await prepare()
  const evaluate = await launch()
  if (values.recovery) {
    const recovery = await verifyRecovery(evaluate)
    await close()
    const report = { root, executable: electron, recovery }
    await write(join(root, "recovery.json"), report)
    console.log(JSON.stringify(report))
  } else {
    const report = await runLatency(evaluate)
    await write(join(root, "receipt.json"), report)
    console.log(JSON.stringify(report, null, 2))
  }
} finally {
  try { await close() } finally {
    if (provider.listening) {
      provider.closeAllConnections()
      await new Promise(done => provider.close(done))
    }
    if (live) {
      const copiedConfig = await realpath(config).catch(error => { if (error.code !== "ENOENT") throw error })
      if (copiedConfig) {
        assert.equal(dirname(copiedConfig), probeRoot, "Probe config must be directly owned by its fixture")
        await rm(copiedConfig, { recursive: true, force: true })
      }
    }
  }
}
