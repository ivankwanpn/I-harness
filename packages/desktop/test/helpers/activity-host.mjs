import { createInterface } from "node:readline"

const input = createInterface({ input: process.stdin })
const ids = new Set()
let probes = 0, inner = 0, mode = "idle", profileActive = false, held
const send = frame => process.stdout.write(JSON.stringify(frame) + "\n")
input.on("line", line => {
  const frame = JSON.parse(line)
  const id = frame.workspaceId
  switch (frame.type) {
    case "ping": return send({ type: "pong" })
    case "open":
      ids.add(id)
      return send({ type: "opened", workspaceId: id, activityReports: id === "legacy" ? undefined : frame.activityReports })
    case "close":
      if (id === "retiring" && mode === "fail-close-once") {
        mode = "idle"
        return send({ type: "error", operation: "close", workspaceId: id, message: "retry cleanup" })
      }
      ids.delete(id)
      return send({ type: "closed", workspaceId: id })
    case "shutdown": input.close(); process.stdin.destroy(); return
    case "activity": {
      probes++
      const scopes = (frame.workspaceIds ?? [...ids]).map(key => [key, false])
      if (mode === "missing") scopes.pop()
      if (mode === "duplicate") scopes[1] = scopes[0]
      if (mode === "foreign") scopes[0][0] = "not-requested"
      if (mode === "unknown") scopes[0][1] = null
      const reply = { type: "activity", requestId: frame.requestId, scopes, profileActive }
      if (mode === "hold") held = reply
      else send(reply)
      return
    }
    case "data": {
      const request = JSON.parse(frame.line)
      let result = { ok: true }
      if (request.method === "initialize") result = { name: "fixture", protocolVersion: 3, version: "1", capabilities: { "desktop-runtime-activity": ["1"] } }
      if (request.method === "desktop/runtime/activity") { inner++; result = { active: false } }
      if (request.method === "mode") mode = request.params.value
      if (request.method === "login") profileActive = request.params.active
      if (request.method === "stats") result = { probes, inner, held: !!held }
      if (request.method === "release") { send(held); held = undefined; mode = "idle" }
      return send({ type: "data", workspaceId: id, line: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) })
    }
  }
})
