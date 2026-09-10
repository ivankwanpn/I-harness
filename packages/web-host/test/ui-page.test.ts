import { readFileSync } from "node:fs"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import vm from "node:vm"
import WebSocket from "ws"
import { describe, expect, it } from "vitest"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createSessionService } from "@i-harness/session-executor"
import { createWebHost } from "../src/host.ts"

// ── L3: the web prompt UI ───────────────────────────────────────────────────
// The page is ONE self-contained document (no framework, no build step), so
// the only honest way to test it without a browser is to run its REAL script:
// these helpers extract the <script> body out of `renderSessionsPage()` and
// execute it in a `node:vm` context against a minimal DOM + a fake mux socket.
// Nothing is stubbed inside the page — no test hooks, no exported internals.
//
// This is why the page's own `fetch`/`WebSocket` calls are driven for real:
// a regression in the wire shapes (a renamed endpoint, a wrong payload key, a
// missing decision field) fails HERE, not in a browser someone has to open.

const here = dirname(fileURLToPath(import.meta.url))
const uiSource = readFileSync(join(here, "..", "src", "ui.ts"), "utf8")

/** The page's script, extracted from the MODULE SOURCE (not the rendered
 * template) so a templating mistake in ui.ts cannot silently pass: the script
 * must exist as a literal `<script>` block. */
function pageScript(): string {
  const start = uiSource.indexOf("<script>")
  const end = uiSource.indexOf("</script>")
  expect(start, "ui.ts has no <script> block").toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return uiSource.slice(start + "<script>".length, end)
}

/** Minimal element: enough of the DOM for this page (ids, classes, dataset,
 * children, textContent/innerHTML, click targets). */
class El {
  className = ""
  textContent = ""
  value = ""
  disabled = false
  placeholder = ""
  scrollTop = 0
  scrollHeight = 100
  style: Record<string, string> = {}
  children: El[] = []
  onclick: (() => void) | undefined
  private readonly attrs = new Map<string, string>()
  private html = ""

  constructor(readonly tagName = "div", readonly id = "") {}

  get innerHTML(): string { return this.html }
  set innerHTML(v: string) {
    this.html = v
    // Materialize one element per tag in the string, carrying its `class` and
    // `data-*` attributes. The page assigns handlers by iterating the elements
    // it just wrote (`.row` → onclick, ask cards → buttons), so the shim must
    // reproduce exactly the hooks the script queries afterwards.
    this.children = []
    for (const m of v.matchAll(/<(\w+)([^>]*)>/g)) {
      const child = new El(m[1]!.toLowerCase())
      const cls = m[2]!.match(/\sclass="([^"]*)"/)
      if (cls) child.className = cls[1]!
      for (const attr of m[2]!.matchAll(/\s(data-[\w-]+)="([^"]*)"/g)) child.setAttribute(attr[1]!, attr[2]!)
      this.children.push(child)
    }
  }

  setAttribute(k: string, v: string): void { this.attrs.set(k, v) }
  getAttribute(k: string): string | undefined { return this.attrs.get(k) }
  appendChild(child: El): El { this.children.push(child); return child }
  remove(): void { this.removed = true }
  removed = false
  focus(): void {}
  get dataset(): Record<string, string> {
    const id = this.attrs.get("data-id")
    return id === undefined ? {} : { id }
  }
  get classList() {
    const self = this
    return {
      add: (c: string) => { if (!self.className.split(" ").includes(c)) self.className = `${self.className} ${c}`.trim() },
      remove: (c: string) => { self.className = self.className.split(" ").filter((x) => x !== c).join(" ") },
      toggle: (c: string, on?: boolean) => { if (on === true) self.classList.add(c); else if (on === false) self.classList.remove(c) },
      contains: (c: string) => self.className.split(" ").includes(c),
    }
  }

  querySelectorAll(sel: string): El[] {
    const all = (nodes: El[]): El[] => nodes.flatMap((n) => [n, ...all(n.children)])
    if (sel.startsWith(".")) return all(this.children).filter((n) => n.classList.contains(sel.slice(1)))
    const attr = sel.match(/^\[([^=\]]+)="([^"]*)"\]$/)
    if (attr) return all(this.children).filter((n) => n.getAttribute(attr[1]!) === attr[2])
    return all(this.children).filter((n) => n.tagName === sel)
  }
  querySelector(sel: string): El | undefined {
    return this.querySelectorAll(sel)[0]
  }
  addEventListener(): void {}
}

/** One recorded client frame, plus the server frames the page can receive. */
class FakeSocket {
  static last: FakeSocket | undefined
  readyState = 0
  sent: Array<Record<string, unknown>> = []
  onopen: (() => void) | undefined
  onclose: (() => void) | undefined
  onmessage: ((ev: { data: string }) => void) | undefined

  constructor(readonly url: string) { FakeSocket.last = this }
  send(text: string): void { this.sent.push(JSON.parse(text) as Record<string, unknown>) }
  close(): void { this.readyState = 3; this.onclose?.() }
  /** Server frame → the page (the mux's real ServerMessage shapes). */
  item(streamId: string, value: unknown): void {
    this.deliver({ type: "item", streamId, value })
  }
  ready(streamId: string): void {
    this.deliver({ type: "ready", streamId })
  }
  end(streamId: string): void {
    this.deliver({ type: "end", streamId })
  }
  /** Hand a frame to the page, surfacing a handler exception instead of
   * letting it vanish (see bootPage's pageErrors). */
  deliver(frame: Record<string, unknown>): void {
    try {
      this.onmessage?.({ data: JSON.stringify(frame) })
    } catch (error) {
      this.errors.push(String(error))
    }
  }
  errors: string[] = []
  /** Frames the page opened for one endpoint, in order. */
  opens(endpoint: string): Array<Record<string, any>> {
    return this.sent.filter((f) => f.type === "open" && f.endpoint === endpoint)
  }
}

interface PageOptions {
  sessions?: Array<Record<string, unknown>>
  events?: Record<string, Array<Record<string, unknown>>>
}

/** Boot the real page script in a vm and return its DOM + socket. */
async function bootPage(opts: PageOptions = {}) {
  const elements = new Map<string, El>()
  // `prompt` and `send` start DISABLED in the shipped markup — the composer is
  // inert until a session is selected, and the test asserts that.
  for (const id of ["view", "sessions", "asks", "prompt", "send", "status", "root", "new"]) {
    const node = new El(id === "prompt" ? "textarea" : "div", id)
    if (id === "prompt" || id === "send") node.disabled = true
    elements.set(id, node)
  }
  // Every frame the page receives is delivered by the test: an exception
  // thrown inside the page's onmessage would otherwise be SWALLOWED (the vm
  // has no window.onerror), so a broken handler would look like "nothing
  // happened". FakeSocket collects them and the tests assert they are empty.
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    // Real El instances: the page builds the ask cards node-by-node
    // (createElement → className/innerHTML → appendChild), and the test then
    // clicks the buttons the page created.
    createElement: (tag: string) => new El(tag),
  }
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchStub = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const ok = (body: unknown) => ({
      ok: true, status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    if (url === "/api/sessions" && init?.method === "POST") return ok({ id: "new-1" })
    if (url === "/api/sessions") return ok({ sessions: opts.sessions ?? [] })
    const m = url.match(/^\/api\/sessions\/([^/]+)\/events/)
    if (m) return ok({ events: opts.events?.[m[1]!] ?? [], hasMore: false })
    return { ok: false, status: 404, json: async () => ({ error: "not found" }), text: async () => "not found" }
  }

  const sandbox: Record<string, unknown> = {
    document,
    fetch: fetchStub,
    WebSocket: FakeSocket,
    location: { protocol: "http:", host: "127.0.0.1:4310" },
    JSON, Math, Date, String, Number, Array, Object, Boolean, Error, Promise,
    console,
    // Deliberately inert: nothing in the page may depend on timers firing for
    // the transcript to be correct (streaming rides the socket, not a poll).
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  }
  vm.createContext(sandbox)
  vm.runInContext(pageScript(), sandbox, { filename: "ui-page-script.js" })
  await flush()
  const socket = FakeSocket.last!
  socket.readyState = 1
  socket.onopen?.()
  await flush()
  return { elements, socket, calls }
}

/** Let queued microtasks (and the page's awaited fetches) settle. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r))
}

function el(elements: Map<string, El>, id: string): El {
  return elements.get(id)!
}

describe("L3: the web prompt UI (the page's real script, run in a vm)", () => {
  it("opens the two GLOBAL decision channels at connect, before any run", async () => {
    const { socket } = await bootPage()
    // An approval emitted while no stream is open is DROPPED (the waterfall's
    // fail-closed timeout then decides it), so the page must subscribe first —
    // this is why these two opens are not coupled to session selection.
    expect(socket.opens("approval")).toHaveLength(1)
    expect(socket.opens("question")).toHaveLength(1)
    expect(socket.opens("approval")[0]!.streamId).not.toBe(socket.opens("question")[0]!.streamId)
  })

  it("lists sessions newest-first and renders the durable transcript on select", async () => {
    const { elements, socket } = await bootPage({
      sessions: [
        { id: "older", updatedAt: 1000 },
        { id: "newer", title: "the newer one", updatedAt: 5000 },
      ],
      events: {
        newer: [
          { type: "turn/start", seq: 1 },
          { type: "user/message", text: "hi", seq: 2 },
          { type: "tool/call", callId: "c1", name: "bash", args: { command: "pwd" }, seq: 3 },
          { type: "tool/result", callId: "c1", name: "bash", output: { stdout: "/d/playground" }, seq: 4 },
          { type: "assistant/message", text: "hello", seq: 5 },
          // model-only context must never become a transcript row
          { type: "user/message", text: "runtime context", internal: true, seq: 6 },
        ],
      },
    })

    const rows = el(elements, "sessions").querySelectorAll(".row")
    expect(rows.map((r: El) => r.dataset.id)).toEqual(["newer", "older"])

    el(elements, "sessions").children[0]!.onclick!()
    await flush()

    // Selecting opens the session's live stream plus the two streaming channels.
    expect(socket.opens("session").at(-1)!.payload).toEqual({ sessionId: "newer" })
    expect(socket.opens("chunk").at(-1)!.payload).toEqual({ sessionId: "newer" })
    expect(socket.opens("reasoning").at(-1)!.payload).toEqual({ sessionId: "newer" })

    const html = el(elements, "view").innerHTML
    expect(html).toContain("─── turn")
    expect(html).toContain("❯ hi")
    expect(html).toContain("◆ bash")
    expect(html).toContain("/d/playground")
    expect(html).toContain("hello")
    expect(html).not.toContain("runtime context")
    // the composer is armed now that a session is selected
    expect(el(elements, "prompt").disabled).toBe(false)
    expect(el(elements, "send").disabled).toBe(false)
  })

  it("submitting a prompt opens the command stream with {sessionId, prompt}", async () => {
    const { elements, socket } = await bootPage({ sessions: [{ id: "s1", updatedAt: 1 }], events: { s1: [] } })
    el(elements, "sessions").children[0]!.onclick!()
    await flush()

    const prompt = el(elements, "prompt")
    prompt.value = "  say hi  "
    el(elements, "send").onclick!()
    await flush()

    const opens = socket.opens("command")
    expect(opens).toHaveLength(1)
    expect(opens[0]!.payload).toEqual({ sessionId: "s1", prompt: "say hi" }) // trimmed
    expect(prompt.value).toBe("")
    expect(el(elements, "view").innerHTML).toContain("❯ say hi")
    expect(el(elements, "status").textContent).toBe("running…")
  })

  it("streams coalesced chunk frames into one row and re-reads the log when the turn settles", async () => {
    const events: Record<string, Array<Record<string, unknown>>> = { s1: [] }
    const { elements, socket } = await bootPage({ sessions: [{ id: "s1", updatedAt: 1 }], events })
    el(elements, "sessions").children[0]!.onclick!()
    await flush()

    el(elements, "prompt").value = "go"
    el(elements, "send").onclick!()
    await flush()
    const command = socket.opens("command")[0]!
    const chunk = socket.opens("chunk").at(-1)!

    socket.ready(command.streamId as string)
    await flush()
    // The send button doubles as Stop while a turn is in flight.
    expect(el(elements, "send").textContent).toBe("Stop")

    const before = (socket.opens("chunk").length)
    socket.item(chunk.streamId as string, "Hel")
    socket.item(chunk.streamId as string, "lo")
    await flush()
    const html = el(elements, "view").innerHTML
    expect(html).toContain("Hello")
    // one row, not two: the frames coalesce into the open streaming row
    expect(html.match(/assistant stream/g)?.length).toBe(1)
    expect(socket.opens("chunk").length).toBe(before) // no re-open per chunk

    // The turn's outcome arrives on the COMMAND stream, and the page then
    // re-reads the durable log — the log's version replaces the streamed one.
    events.s1 = [
      { type: "turn/start", seq: 1 },
      { type: "user/message", text: "go", seq: 2 },
      { type: "assistant/message", text: "Hello", seq: 3 },
    ]
    socket.item(command.streamId as string, { status: "ok" })
    await flush()
    expect(el(elements, "view").innerHTML).toContain("Hello")

    socket.end(command.streamId as string)
    await flush()
    expect(el(elements, "send").textContent).toBe("Send")
    expect(el(elements, "status").textContent).toBe("ready")
  })

  it("a failed turn paints the error and never claims success", async () => {
    const { elements, socket } = await bootPage({ sessions: [{ id: "s1", updatedAt: 1 }], events: { s1: [] } })
    el(elements, "sessions").children[0]!.onclick!()
    await flush()
    el(elements, "prompt").value = "boom"
    el(elements, "send").onclick!()
    await flush()
    const command = socket.opens("command")[0]!
    socket.item(command.streamId as string, { status: "error", error: "model exploded" })
    await flush()
    expect(el(elements, "view").innerHTML).toContain("turn failed: model exploded")
  })

  it("an approval request renders a card whose decision goes back on the approval stream", async () => {
    const { elements, socket } = await bootPage({ sessions: [{ id: "s1", updatedAt: 1 }], events: { s1: [] } })
    const approvals = socket.opens("approval")[0]!

    socket.item(approvals.streamId as string, {
      approvalId: "ap-1", name: "bash", reason: "runs a command", command: "rm -rf /",
    })
    await flush()
    expect(socket.errors, "the page's own handler threw").toEqual([])

    const card = el(elements, "asks").children[0]!
    // The card is appended as a node (not via innerHTML), so assert on the
    // children the page actually built.
    expect(card.className).toBe("ask")
    expect(card.getAttribute("data-ask")).toBe("ap-1")
    expect(card.innerHTML).toContain("bash")
    expect(card.innerHTML).toContain("rm -rf /")

    const [approve] = card.querySelectorAll("button")
    approve!.onclick!()
    const decision = socket.sent.find((f) => f.type === "approval")
    expect(decision).toMatchObject({
      streamId: approvals.streamId,
      value: { approvalId: "ap-1", approved: true },
    })
    expect(card.removed).toBe(true) // the card never lingers after a decision
  })

  it("a question with options answers with the chosen option; free-form types its answer", async () => {
    const { elements, socket } = await bootPage()
    const stream = socket.opens("question")[0]!.streamId as string

    socket.item(stream, { questionId: "q-1", text: "which one?", options: ["yes", "later"] })
    await flush()
    expect(socket.errors, "the page's own handler threw").toEqual([])
    const card = el(elements, "asks").children[0]!
    const buttons = card.querySelectorAll("button")
    expect(buttons.map((b: El) => b.textContent)).toEqual(["yes", "later"])
    buttons[1]!.onclick!()
    expect(socket.sent.find((f) => f.type === "answer")).toMatchObject({
      streamId: stream, value: { questionId: "q-1", answer: "later" },
    })

    // No options → a free-form input, answered with whatever was typed.
    socket.item(stream, { questionId: "q-2", text: "explain?" })
    await flush()
    const free = el(elements, "asks").children[1]!
    const input = free.querySelector('[data-answer="q-2"]')!
    input.value = "because"
    free.querySelectorAll("button")[0]!.onclick!()
    const answers = socket.sent.filter((f) => f.type === "answer")
    expect(answers.at(-1)).toMatchObject({ streamId: stream, value: { questionId: "q-2", answer: "because" } })
  })

  it("Stop cancels the in-flight command stream instead of sending a second turn", async () => {
    const { elements, socket } = await bootPage({ sessions: [{ id: "s1", updatedAt: 1 }], events: { s1: [] } })
    el(elements, "sessions").children[0]!.onclick!()
    await flush()
    el(elements, "prompt").value = "long one"
    el(elements, "send").onclick!()
    await flush()
    const command = socket.opens("command")[0]!
    socket.ready(command.streamId as string)
    await flush()

    el(elements, "send").onclick!() // now the Stop button
    await flush()
    expect(socket.sent.find((f) => f.type === "cancel")).toMatchObject({ streamId: command.streamId })
    expect(socket.opens("command")).toHaveLength(1) // no second turn
  })

  it("+ new session creates one through the API and selects it", async () => {
    const { elements, socket, calls } = await bootPage({ sessions: [] })
    el(elements, "new").onclick!()
    await flush()
    const create = calls.find((c) => c.url === "/api/sessions" && c.init?.method === "POST")
    expect(create, "the page must create via the public API, not a private path").toBeTruthy()
    expect(socket.opens("session").at(-1)!.payload).toEqual({ sessionId: "new-1" })
    expect(el(elements, "prompt").disabled).toBe(false)
  })

  it("the composer is inert until a session is selected", async () => {
    const { elements } = await bootPage()
    expect(el(elements, "prompt").disabled).toBe(true)
    expect(el(elements, "send").disabled).toBe(true)
    el(elements, "send").onclick!()
    await flush()
    expect(el(elements, "view").innerHTML).not.toContain("❯")
  })
})

// ── L3 end-to-end: the exact sequence the page performs, over a REAL host ────
// The vm tests above pin the page's frames against a fake socket. This one
// closes the loop on the other side: a real host + real service + real
// WebSocket, driven with the frames the page actually sends — so a contract
// change on the server (an endpoint name, a payload key, the settled-turn
// signal) fails here too, not just in the page.
describe("L3: the prompt path against a real host", () => {
  it("create → command → chunks → durable transcript, over a real socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-web-l3-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(root))
    const executor = createSessionService({
      workspace: process.cwd(), approveAll: true, modelPolicy: "test-mock", coordinator,
    })
    const host = createWebHost({ port: 0, executor, coordinator })
    executor.onAssembly((a) => {
      if (a.sessionId !== undefined) host.attachLiveSession({ sessionId: a.sessionId, session: a.session })
    })
    const { port } = await host.listen()
    const base = `http://127.0.0.1:${port}`
    try {
      // What `+ new session` does.
      const created = await (await fetch(`${base}/api/sessions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      })).json() as { id: string }
      expect(created.id).toBeTruthy()

      const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/mux")
      await once(ws, "open")
      const messages: Array<{ type: string; streamId: string; value?: any }> = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))

      // What the page opens on select: the session stream, then chunk.
      ws.send(JSON.stringify({ type: "open", streamId: "sess", endpoint: "session", payload: { sessionId: created.id } }))
      ws.send(JSON.stringify({ type: "open", streamId: "chunks", endpoint: "chunk", payload: { sessionId: created.id } }))
      // What the page opens on send.
      ws.send(JSON.stringify({
        type: "open", streamId: "cmd", endpoint: "command",
        payload: { sessionId: created.id, prompt: "say something" },
      }))

      const until = async (cond: () => boolean): Promise<void> => {
        const start = Date.now()
        while (!cond()) {
          if (Date.now() - start > 5000) throw new Error("condition not met")
          await new Promise((r) => setTimeout(r, 10))
        }
      }
      await until(() => messages.some((m) => m.type === "item" && m.streamId === "cmd" && m.value?.status === "ok"))

      // The turn is durable: the log is the source of truth the page re-reads.
      const page = await (await fetch(`${base}/api/sessions/${created.id}/events?limit=50`)).json() as {
        events: Array<{ type: string; text?: string }>
      }
      const types = page.events.map((e) => e.type)
      expect(types).toContain("turn/start")
      expect(types).toContain("assistant/message")
      expect(types).toContain("turn/end")
      expect(page.events.find((e) => e.type === "assistant/message")?.text).toBeTruthy()
      ws.close()
    } finally {
      await host.close()
      await executor.close()
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
