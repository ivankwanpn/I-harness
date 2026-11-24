// Use the pinned Node runtime, an isolated npm install of the DSH tag, and the
// OpenCode Windows archive for its tag. The default uses a loopback fixture.
// Explicit --live forwards one request per reference to DeepSeek Messages.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs } from "node:util"

const { values } = parseArgs({ options: { dsh: { type: "string" }, opencode: { type: "string" }, rounds: { type: "string" }, live: { type: "boolean" } } })
const rounds = Number(values.rounds ?? (values.live ? 1 : 3))
assert((values.dsh || values.opencode) && Number.isInteger(rounds) && rounds >= 1 && rounds <= 10,
  "Supply --dsh <pinned DSH bin.js> and/or --opencode <pinned OpenCode exe>, plus --rounds 1–10")
const apiKey = values.live ? process.env.DEEPSEEK_API_KEY : undefined
if (values.live) assert(values.dsh && values.opencode && rounds === 1 && apiKey?.trim(),
  "Live comparison requires both references, one trial and DEEPSEEK_API_KEY in the environment")

const root = await mkdtemp(join(tmpdir(), "ih-reference-latency-"))
const model = "deepseek-flash"
const baseReply = values.live ? "Finished fixture-latency-live-0" : "Fixture comparator output"
const prompt = values.live ? "Reply with the single line Finished fixture-latency-live-0. Use no tools."
  : "Return a short plain-text confirmation. This local test requires no tools."
const round = number => Number(number.toFixed(1))
let run

async function relay(run, request, res) {
  // The CLI children only receive the fixture key and local address. Holding
  // the real credential here allows us to reject any second upstream attempt.
  run.issued = performance.now()
  const { tools: _tools, tool_choice: _choice, ...textOnly } = request
  const upstream = await fetch("https://api.deepseek.com/anthropic/v1/messages", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(25000),
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": apiKey },
    body: JSON.stringify(textOnly),
  })
  run.providerStatus = upstream.status
  if (!upstream.ok) {
    await upstream.body?.cancel()
    res.writeHead(upstream.status, { "Content-Type": "application/json" })
    res.end('{"type":"error","error":{"type":"api_error","message":"Live benchmark request failed"}}')
    return
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
  const decoder = new TextDecoder()
  let partial = ""
  for await (const chunk of upstream.body) {
    const now = performance.now()
    partial += decoder.decode(chunk, { stream: true })
    let end
    while ((end = partial.indexOf("\n")) !== -1) {
      const line = partial.slice(0, end).trimEnd()
      partial = partial.slice(end + 1)
      if (!line.startsWith("data: ")) continue
      let item
      try { item = JSON.parse(line.slice(6)) } catch { continue }
      if (item.type !== "ping") run.firstFrame ??= now
      if (item.type === "content_block_delta" && item.delta?.type === "text_delta" &&
        typeof item.delta.text === "string" && item.delta.text.trim()) run.firstText ??= now
    }
    res.write(chunk)
  }
  res.end()
}
const server = createServer(async (req, res) => {
  const trial = run
  try {
    if (!trial || (req.headers["x-api-key"] !== trial.fixtureKey && req.headers.authorization !== "Bearer " + trial.fixtureKey)) {
      res.writeHead(403, { "Content-Type": "application/json" })
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"Probe identity mismatch"}}')
      return
    }
    const body = []
    for await (const chunk of req) body.push(chunk)
    const bytes = Buffer.concat(body)
    const request = JSON.parse(bytes.toString("utf8"))
    const pathname = new URL(req.url, "http://127.0.0.1").pathname
    const requestShape = { messagesRoute: pathname === "/anthropic/v1/messages", expectedModel: request.model === model,
      streaming: request.stream === true, includesTask: JSON.stringify(request.messages).includes(prompt),
      repeated: trial.received !== undefined, maxTokens: Number.isInteger(request.max_tokens) ? request.max_tokens : null }
    trial.requestShapes.push(requestShape)
    if (trial !== run) { res.writeHead(409); res.end(); return }
    if (!requestShape.messagesRoute || !requestShape.expectedModel || !requestShape.streaming ||
      !requestShape.includesTask || requestShape.repeated || requestShape.maxTokens !== 2048) {
      trial.invalidRequests++
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"Unexpected fixture request"}}')
      return
    }
    trial.received = performance.now()
    trial.requestBytes = bytes.length
    if (values.live) { await relay(trial, request, res); return }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}\n\n`)
    await delay(15)
    trial.firstFrame = performance.now()
    send("message_start", { message: { id: "msg_fixture", type: "message", role: "assistant", content: [], model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } })
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    await delay(15)
    trial.firstText = performance.now()
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: baseReply } })
    await delay(20)
    send("content_block_stop", { index: 0 })
    send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })
    send("message_stop", {})
    res.end()
  } catch {
    if (trial && values.live) trial.providerTransportFailure = true
    else if (trial) trial.invalidRequests++
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
const baseURL = "http://127.0.0.1:" + server.address().port + "/anthropic"

const isolatedVars = ["Path", "PATHEXT", "SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => isolatedVars.some(key => name.toLowerCase() === key.toLowerCase())))

async function trial(subject, index) {
  const home = join(root, subject + "-" + index), workspace = join(home, "workspace")
  const fixtureKey = randomUUID()
  const env = {
    ...inherited, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "local"), ProgramData: join(home, "programdata"), TEMP: join(home, "tmp"),
    TMP: join(home, "tmp"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"),
  }
  await Promise.all([workspace, env.TEMP, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.ProgramData].map(path => mkdir(path, { recursive: true })))
  let command, args
  if (subject === "dsh") {
    Object.assign(env, { DSH_HOME: join(home, ".dsh"), DSH_AGENTS_HOME: join(home, ".agents"), DSH_TELEMETRY_DISABLED: "1",
      DSH_PERMISSION_MODE: "read-only", DEEPSEEK_API_KEY: fixtureKey, DEEPSEEK_BASE_URL: baseURL })
    await mkdir(env.DSH_HOME)
    await writeFile(join(env.DSH_HOME, "cordis.patch.yml"),
      "- id: llm-deepseek\n  config:\n    maxTokens: 2048\n    baseURL: " + baseURL + "\n- id: session-title-llm\n  disabled: true\n")
    command = process.execPath
    args = [resolve(values.dsh), "--profile", "headless", "--json", prompt]
  } else {
    const config = join(env.XDG_CONFIG_HOME, "opencode")
    await mkdir(config, { recursive: true })
    await writeFile(join(config, "opencode.json"), JSON.stringify({
      autoupdate: false, model: "fixture/" + model,
      providers: { fixture: { package: "@opencode/ai/providers/anthropic-compatible", name: "Fixture",
        settings: { baseURL: baseURL + "/v1", apiKey: "{env:IH_REFERENCE_FIXTURE_KEY}" },
        models: { [model]: { name: model, limit: { context: 128000, output: 2048 } } } } },
    }))
    Object.assign(env, { OPENCODE_TEST_HOME: home, OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
      IH_REFERENCE_FIXTURE_KEY: fixtureKey })
    command = resolve(values.opencode)
    args = ["run", "--format", "json", "--title", "Latency fixture", "--model", "fixture/" + model, prompt]
  }
  run = { invalidRequests: 0, requestShapes: [], fixtureKey }
  const started = performance.now()
  const child = spawn(command, args, { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let tail = "", firstOutput, stdoutBytes = 0, stderrBytes = 0
  child.stdout.setEncoding("utf8").on("data", data => {
    stdoutBytes += Buffer.byteLength(data)
    // Ignore JSON lines which repeat the submitted prompt. The result marker
    // appears in emitted text, not in a user-input or error event.
    const lines = (tail + data).split("\n")
    tail = lines.pop().slice(-16384)
    if (lines.some(line => {
      if (!line.includes(baseReply)) return false
      try {
        const item = JSON.parse(line)
        return item.type === "text" && (item.text ?? item.part?.text)?.includes(baseReply)
      } catch { return false }
    })) firstOutput ??= performance.now()
  })
  child.stderr.on("data", data => { stderrBytes += data.length })
  const exit = once(child, "close")
  let [code] = await Promise.race([exit, delay(55000, ["timeout"], { ref: false })])
  if (code === "timeout") { child.kill(); await exit }
  const after = stamp => stamp === undefined ? null : round(stamp - started)
  const receipt = {
    subject, trial: index, code, model, protocol: "anthropic-messages", requestOffsetMs: after(run.received),
    providerFirstFrameOffsetMs: after(run.firstFrame), providerFirstTextOffsetMs: after(run.firstText),
    stdoutFirstTextOffsetMs: after(firstOutput), totalMs: after(performance.now()), invalidRequests: run.invalidRequests,
    verifiedMarker: firstOutput !== undefined,
    ...(values.live ? { providerIssuedOffsetMs: after(run.issued), forwardedRequests: run.issued === undefined ? 0 : 1,
      providerStatus: run.providerStatus, ...(run.providerTransportFailure ? { providerTransportFailure: true } : {}) }
      : { requestBytes: run.requestBytes, requestShapes: run.requestShapes, stdoutBytes, stderrBytes }),
  }
  await writeFile(join(home, "receipt.json"), JSON.stringify(receipt, null, 2))
  return receipt
}

const records = []
try {
  for (let index = 0; index < rounds; index++) {
    const order = index % 2 ? ["opencode", "dsh"] : ["dsh", "opencode"]
    for (const subject of order.filter(subject => values[subject])) records.push(await trial(subject, index))
  }
} finally {
  server.closeAllConnections()
  await new Promise(done => server.close(done))
}
const measurement = values.live
  ? "Cold process launch to CLI JSON text. One fixed-endpoint Messages request per reference through a one-shot loopback relay with tools omitted. Upstream event times are relay observations and stdout may wait for a completed block. These timings are independent of Desktop paint."
  : "Cold process launch to first matching CLI stdout. Fixture sent the same Messages response for each run."
console.log(JSON.stringify({ root, measurement, records }, null, 2))
if (records.some(record => record.code !== 0 || record.stdoutFirstTextOffsetMs === null || record.invalidRequests)) process.exitCode = 1
