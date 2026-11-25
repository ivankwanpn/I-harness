// Run with Node from .node-version: node --import tsx scripts/bench/desktop-latency.mjs
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { timingScope } from "../../packages/desktop-gateway/src/timing-trace.ts"
import { createJsonlBackend } from "../../packages/session-persistence-jsonl/src/index.ts"
import { createReadOnlySessionCoordinator, createSessionCoordinator } from "../../packages/session-persistence/src/index.ts"
import { installRendererSoakObserver, renderedAssistantBodies, rendererState, sampleDesktopProcesses, sumProcessRoles } from "./desktop-soak.mjs"

const { values } = parseArgs({ options: {
  exe: { type: "string" }, rounds: { type: "string", default: "3" }, "require-trace": { type: "boolean" },
  "live-config": { type: "string" }, "live-tool": { type: "boolean" },
  "soak-minutes": { type: "string" },
  "soak-cycles": { type: "string" },
  "soak-sample-seconds": { type: "string", default: "60" },
  "require-visible-replies": { type: "boolean" },
  recovery: { type: "boolean" },
} })
const live = values["live-config"]
const soakMinutes = values["soak-minutes"] === undefined ? undefined : Number(values["soak-minutes"])
const soakCycles = values["soak-cycles"] === undefined ? undefined : Number(values["soak-cycles"])
const soak = soakMinutes !== undefined || soakCycles !== undefined
assert(soakMinutes === undefined || Number.isSafeInteger(soakMinutes) && soakMinutes >= 1 && soakMinutes <= 480, "Soak duration must be 1–480 minutes")
assert(soakCycles === undefined || Number.isSafeInteger(soakCycles) && soakCycles >= 1 && soakCycles <= 600, "Soak workload must be 1–600 parallel cycles")
assert(!soak || !live && (soakMinutes === undefined || soakCycles === undefined), "Choose one local soak mode")
const soakSampleSeconds = Number(values["soak-sample-seconds"])
assert(Number.isSafeInteger(soakSampleSeconds) && soakSampleSeconds >= 1 && soakSampleSeconds <= 600, "Soak sample interval must be 1–600 seconds")
assert(!values.recovery || !soak && !live, "Recovery uses an independent local fixture")
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
    mark.ended = clock()
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
      const timeout = soak ? 45_000 : 10_000
      const reply = await Promise.race([request.promise, delay(timeout, undefined, { ref: false })])
      if (!reply) throw Error("Renderer RPC did not reply within " + timeout + " ms")
      if (reply.error || reply.result.exceptionDetails) throw Error(reply.error?.message ?? reply.result.result?.description ?? "Renderer RPC failed")
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

async function startRendererSampler(evaluate) {
  await evaluate(`(${installRendererSoakObserver})(${rendererState})`)
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
  const { pressed: marked } = await submit(evaluate, drop)
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
    const state = ${rendererState}
    window.ihLatencySamples ??= Object.create(null)
    const sample = { pressed: performance.timeOrigin + performance.now(), submitState: state() }
    window.ihLatencySamples[tag] = sample
    const next = () => {
      const at = performance.timeOrigin + performance.now()
      if (!document.hidden) {
        const text = (${renderedAssistantBodies})(document)
        if (sample.firstText === undefined && text.some(line => ${Boolean(live)} ? !!line : line.includes("Started " + tag))) {
          sample.firstText = at
          sample.firstTextState = state()
        }
        if (text.some(line => line === "Finished " + tag)) {
          sample.finished = at
          sample.finalTextState = state()
        }
      }
      if (!sample.finished && at - sample.pressed < 60000) requestAnimationFrame(next)
    }
    target.click()
    requestAnimationFrame(next)
    return sample
  })()`)
}
async function waitForReply(evaluate, workspace, session, tag, submitted) {
  let checkedAt = 0
  return until(async () => {
    const key = JSON.stringify(tag)
    const sample = await evaluate(`window.ihLatencySamples[${key}]`)
    if (sample?.finished) return sample
    // When the window is hidden there may be no animation frames. The
    // provider's response only tells us when to check committed history.
    // A record of that check is independent of the animation-frame series.
    const ended = responseMarks.get(tag)?.[1]?.ended
    const now = clock()
    if (soak && !values["require-visible-replies"] && ended !== undefined && now - ended >= 500 && now >= checkedAt + 2000) {
      checkedAt = now
      const state = await evaluate(`(${rendererState})()`)
      if (state.visibility !== "hidden" && now - ended < 3000) return undefined
      const completed = await evaluate(`window.ihDesktop.request({kind:"session/history",workspaceId:${JSON.stringify(workspace.id)},
        sessionId:${JSON.stringify(session)},afterSeq:0,beforeSeq:Number.MAX_SAFE_INTEGER,limit:40})
        .then(history=>history.events.some(event=>event.type==="assistant/message"&&event.text.trim()==="Finished "+${key}))`)
      if (completed) return { ...submitted, ...sample, finished: clock(), paintMissing: true, durableReplyState: state }
    }
    return undefined
  }, tag + " finished")
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
    if (!live && !soak && trial.scenario !== "parallel-background") assert(trial.firstText, "Expected to observe the first content while selected")
    const offset = at => at === undefined ? undefined : round(at - trial.pressed)
    const loopback = responseMarks.get(trial.tag)
    if (!live) assert.equal(loopback?.length, 2, "The fixture must exercise one tool, then a second provider request")
    return { scenario: trial.scenario, tag: trial.tag,
      workspaceToListMs: round(trial.activation.listedAfterMs), workspaceToComposerMs: round(trial.activation.readyAfterMs),
      gatewayReceivedMs: offset(phase("gateway-received")), gatewayAdmittedMs: offset(phase("gateway-admitted")),
      turnStartMs: offset(phase("turn-start")), requestProjectedMs: offset(phase("request-projected")), requestAssessedMs: offset(phase("request-assessed")),
      providerIssuedMs: offset(issued?.at), providerEventMs: offset(phase("provider-first-event", issued?.attempt)),
      providerTextMs: offset(phase("provider-first-text", issued?.attempt)), firstToolMs: offset(phase("tool-start")),
      submitState: trial.submitState, firstTextState: trial.firstTextState, firstTextInFrameMs: offset(trial.firstText),
      ...(trial.paintMissing ? { finalPaintMissing: true, durableReplyObservedMs: offset(trial.finished), durableReplyState: trial.durableReplyState }
        : { finalTextInFrameMs: offset(trial.finished), finalTextState: trial.finalTextState }),
      ...(loopback ? { fixtureReceivedMs: offset(loopback[0].received), fixtureFirstTextMs: offset(loopback[0].firstText),
        fixtureNextRequestMs: offset(loopback[1].received), inputBytes: loopback[0].inputBytes } : {}) }
  })
}

async function verifySoakReplies(trials) {
  const histories = []
  for (const workspace of workspaces) {
    const directory = join(profile, "sessions", workspace.id)
    const reader = createReadOnlySessionCoordinator(createJsonlBackend(directory))
    try {
      for (const sessionId of ["empty", "long"]) {
        const requested = trials.filter(trial => trial.workspace.id === workspace.id && trial.session === sessionId)
        if (!requested.length) continue
        const expected = new Map(requested.map(trial => ["Finished " + trial.tag, 0]))
        const { session } = await reader.snapshot(sessionId)
        for (const event of session.events) {
          if (event.type !== "assistant/message") continue
          const text = event.text.trim()
          if (expected.has(text)) expected.set(text, expected.get(text) + 1)
        }
        assert([...expected.values()].every(count => count === 1), "Expected exactly one committed reply per trial in " + workspace.id + "/" + sessionId)
        const journal = await stat(join(directory, sessionId + ".jsonl"))
        histories.push({ workspace: workspace.id, sessionId, replies: expected.size, journalBytes: journal.size })
      }
    } finally { await reader.close() }
  }
  return histories
}

async function runLatency(evaluate) {
  const trials = []
  const soakSamples = []
  const started = performance.now()
  const deadline = soakMinutes === undefined ? undefined : started + soakMinutes * 60_000
  let nextSample = started
  const heartbeatFile = join(root, "soak-heartbeat.jsonl")
  async function sampleSoak(parallelCycles) {
    let renderer = await evaluate("window.ihSoakSample?.() ?? null")
    if (!renderer) {
      await startRendererSampler(evaluate)
      renderer = { ...await evaluate("window.ihSoakSample()"), reset: true }
    }
    const elapsedMs = Math.round(performance.now() - started)
    const [processes, journalBytes] = await Promise.all([
      sampleDesktopProcesses(child.pid),
      Promise.all(workspaces.map(async workspace => {
        const journal = await stat(join(profile, "sessions", workspace.id, "long.jsonl"))
        return { workspace: workspace.id, bytes: journal.size }
      })),
    ])
    const sample = { elapsedMs, parallelCycles, renderer, processes, roles: sumProcessRoles(processes), journalBytes }
    soakSamples.push(sample)
    await appendFile(heartbeatFile, JSON.stringify(sample) + "\n")
    console.log(JSON.stringify(sample))
    nextSample = performance.now() + soakSampleSeconds * 1000
  }
  if (soak) {
    await startRendererSampler(evaluate)
    const identity = { startedAt: new Date().toISOString(), minutes: soakMinutes, targetCycles: soakCycles, sampleSeconds: soakSampleSeconds, pid: child.pid }
    await appendFile(heartbeatFile, JSON.stringify(identity) + "\n")
    console.log(JSON.stringify({ root, heartbeatFile, ...identity }))
    await sampleSoak(0)
  }
  async function run(workspace, session, scenario, round) {
    const tag = `fixture-latency-${scenario}-${round}`
    const activation = await select(evaluate, workspace, session)
    const submitted = await submit(evaluate, tag)
    trials.push({ workspace, session, scenario, tag, activation,
      ...await waitForReply(evaluate, workspace, session, tag, submitted) })
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
  let parallelCycles = 0
  for (let index = 0; !live && (index < (soakCycles ?? rounds) || deadline !== undefined && performance.now() < deadline); index++) {
    const a = "fixture-latency-parallela-" + index
    const b = "fixture-latency-parallelb-" + index
    const startA = await select(evaluate, workspaces[0], "long")
    const submittedA = await submit(evaluate, a)
    await until(() => responseMarks.get(a)?.length === 1, "first concurrent request")
    const startB = await select(evaluate, workspaces[1], "long")
    const submittedB = await submit(evaluate, b)
    const sampleB = await waitForReply(evaluate, workspaces[1], "long", b, submittedB)
    await select(evaluate, workspaces[0], "long")
    const sampleA = await waitForReply(evaluate, workspaces[0], "long", a, submittedA)
    trials.push({ workspace: workspaces[0], session: "long", scenario: "parallel-background", tag: a, activation: startA, ...sampleA })
    trials.push({ workspace: workspaces[1], session: "long", scenario: "parallel-foreground", tag: b, activation: startB, ...sampleB })
    parallelCycles++
    if (soak) {
      await evaluate(`(() => {
        delete window.ihLatencySamples[${JSON.stringify(a)}]
        delete window.ihLatencySamples[${JSON.stringify(b)}]
      })()`)
      if (performance.now() >= nextSample && (deadline === undefined || performance.now() < deadline)) await sampleSoak(parallelCycles)
      const rest = deadline === undefined ? 0 : Math.min(20_000, deadline - performance.now())
      if (rest > 0) await delay(rest)
    }
  }
  const workloadElapsedMs = Math.round(performance.now() - started)
  if (soak) {
    if (soakMinutes !== undefined) assert(workloadElapsedMs >= soakMinutes * 60_000, "Soak must reach the requested duration")
    if (soakCycles !== undefined) assert.equal(parallelCycles, soakCycles, "Soak must complete the requested workload")
    await sampleSoak(parallelCycles)
    if (process.platform === "win32") {
      assert(soakSamples.some(sample => sample.roles?.["desktop-host"] && sample.roles?.renderer),
        "Soak did not capture a shared Desktop host and renderer resource sample")
    }
  }
  await close()
  if (soak) assert.equal(child.exitCode, 0, "Desktop must exit normally after the soak")
  const persisted = soak ? await verifySoakReplies(trials) : undefined
  const records = await readFile(trace, "utf8").then(text => text.trimEnd().split("\n").map(line => JSON.parse(line)), error => {
    if (error.code !== "ENOENT") throw error
    return []
  })
  const report = { root, executable: electron, fixture: live ? "explicit live provider profile" : "local Responses with a read tool", rounds: live ? 1 : rounds,
    ...(soak ? { soakMinutes, soakCycles, soakSampleSeconds, workloadElapsedMs, parallelCycles, soakSamples, persisted, desktopExited: true } : {}),
    rendererMeasurement: "First animation frame with the expected DOM text in a visible document. State separates focused, unfocused, and hidden windows, and foreground timer statistics exclude connection or visibility transitions. Background A may be restored from history.",
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
