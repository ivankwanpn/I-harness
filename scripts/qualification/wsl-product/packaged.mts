import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { HarnessClient } from "../../../packages/sdk/src/index.ts"

const [cliDirectory, gatewayDirectory] = process.argv.slice(2)
if (!cliDirectory || !gatewayDirectory) throw new Error("Usage: node --import tsx scripts/qualification/wsl-product/packaged.mts CLI_DIR GATEWAY_DIR")
mkdirSync(resolve(".tmp"), {recursive: true})
const root = mkdtempSync(resolve(".tmp/wsl-product-packaged-"))
const evidence: unknown[] = []

async function fixture(tag: string) {
  const work = join(root, tag), config = join(root, `${tag}-config`), sessions = join(root, `${tag}-sessions`)
  for (const path of [work, config, sessions]) mkdirSync(path)
  const command = `printf PACKAGED_${tag.toUpperCase()}_OK > artifact.txt; uname -s`
  let requests = 0
  const provider = createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") {res.writeHead(404).end(); return}
    let body = ""
    req.on("data", data => {body += data})
    req.on("end", () => {
      requests++
      const input = JSON.parse(body)
      const delta = input.messages?.some((message: {role?: string}) => message.role === "tool") || requests > 1
        ? {content: "PACKAGED_DONE"}
        : {tool_calls: [{index: 0, id: `${tag}-bash`, function: {name: "bash", arguments: JSON.stringify({command})}}]}
      res.writeHead(200, {"content-type": "text/event-stream"})
      res.end(`data: ${JSON.stringify({choices: [{delta}]})}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(done => provider.listen(0, "127.0.0.1", done))
  const address = provider.address()
  if (!address || typeof address === "string") throw new Error("Controlled provider unavailable")
  writeFileSync(join(config, "settings.json"), JSON.stringify({
    sandboxMode: "workspace-write", approvalMode: "dangerous", windowsSandboxBackend: "wsl",
    wslExecution: {distribution: "Ubuntu", networkAccess: false, workspaceDependencies: false}, webSearchMode: "disabled",
    llm: {providers: {fixture: {protocol: "openai-completions", baseURL: `http://127.0.0.1:${address.port}`, apiKeyEnv: "WSL_FIXTURE_KEY", models: [{id: "fixture-model"}]}}, defaultModel: {provider: "fixture", model: "fixture-model"}},
  }))
  writeFileSync(join(config, "credentials.json"), JSON.stringify({refs: {WSL_FIXTURE_KEY: "local-fixture-key"}}))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("IH_") && name !== "ELECTRON_RUN_AS_NODE"))
  return {work, config, sessions, env: {...env, IH_CONFIG_DIR: config}, requests: () => requests,
    async close() {provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()))},
  }
}

const cli = await fixture("cli")
try {
  const child = spawn(process.execPath, [join(resolve(cliDirectory), "ih.mjs"), "run", "Run the controlled Bash fixture", "--yes", "--session-dir", cli.sessions],
    {cwd: cli.work, env: cli.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true})
  let stdout = "", stderr = ""
  child.stdout.on("data", data => {stdout += data}); child.stderr.on("data", data => {stderr += data})
  const timer = setTimeout(() => child.kill(), 120000)
  const exitCode = await new Promise<number | null>((done, reject) => {child.once("error", reject); child.once("close", done)})
  clearTimeout(timer)
  assert.equal(exitCode, 0, stderr)
  assert.equal(readFileSync(join(cli.work, "artifact.txt"), "utf8"), "PACKAGED_CLI_OK")
  assert.ok(cli.requests() >= 2)
  evidence.push({surface: "cli", directory: resolve(cliDirectory), exitCode, stdout, stderr, requests: cli.requests()})
  console.log("PASS packaged CLI persisted WSL settings and actual Bash")
} finally {await cli.close()}

const gateway = await fixture("gateway")
const shippedRoot = resolve(gatewayDirectory)
const child = spawn(process.execPath, ["--import", pathToFileURL(join(shippedRoot, "node_modules/tsx/dist/loader.mjs")).href,
  join(shippedRoot, "cli/src/cli.ts"), "--session-dir", gateway.sessions], {cwd: gateway.work, env: gateway.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true})
let stderr = ""
child.stderr.on("data", data => {stderr += data})
const client = new HarnessClient(child.stdout, child.stdin, {child})
let replyFailure: unknown
const off = client.onNotification(frame => {
  if (frame.method !== "desktop/interaction/request") return
  const params = frame.params as {requestId: string; sessionId: string}
  void client.request("desktop/interaction/reply", {requestId: params.requestId, sessionId: params.sessionId, decision: {kind: "approval", approved: true}}).catch(error => {replyFailure = error})
})
try {
  await client.initialize()
  const settings = await client.request("desktop/agent-settings/state") as {effective: {windowsSandboxBackend: string; webSearchMode: string}}
  assert.equal(settings.effective.windowsSandboxBackend, "wsl"); assert.equal(settings.effective.webSearchMode, "disabled")
  const session = await client.createSession()
  await client.request("session/prompt", {sessionId: session.sessionId, prompt: "Run the controlled Bash fixture"}, 120000)
  assert.equal(replyFailure, undefined)
  assert.equal(readFileSync(join(gateway.work, "artifact.txt"), "utf8"), "PACKAGED_GATEWAY_OK")
  const history = await client.history(session.sessionId)
  const events = history.events as {type: string; name?: string; output?: unknown}[]
  const actual = events.find(event => event.type === "tool/result" && event.name === "bash")
  assert.ok(actual); assert.match(JSON.stringify(actual.output), /Linux/)
  evidence.push({surface: "gateway", directory: shippedRoot, settings, actual, stderr, requests: gateway.requests()})
  console.log("PASS packaged Desktop gateway persisted settings, approval and actual Linux Bash")
} finally {off(); await client.close(); await gateway.close()}
writeFileSync(join(root, "qualification.json"), JSON.stringify({date: new Date().toISOString(), root, evidence}, null, 2) + "\n")
console.log(`Evidence: ${join(root, "qualification.json")}`)
