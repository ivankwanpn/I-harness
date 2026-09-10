// M61 L3: the web prompt UI served at `/`.
//
// WHY: M61 shipped a READ-ONLY viewer ("the API's own face") and deferred the
// one thing that makes it a UI — being able to TALK to the agent. Everything it
// needed already existed and was already composed by `apps/cli/src/web.ts`:
//
//   POST /api/sessions                       → create a session (fresh composer)
//   GET  /api/sessions                       → the rows (picker)
//   GET  /api/sessions/:id/events?afterSeq=N → the transcript cursor
//   WS   /api/mux  {endpoint:"command"}      → run ONE turn for a session
//   WS   /api/mux  {endpoint:"session"}      → that session's live event stream
//   WS   /api/mux  {endpoint:"approval"}     → every approval request (global)
//   WS   /api/mux  {endpoint:"question"}     → every question (global)
//   WS   /api/mux  {type:"approval"|"answer"}→ the decisions (keyed by id)
//
// So this page owns NO protocol of its own: it is another client of the same
// wire the TUI and the SDK use. Three streams per selected session
// (`command` + `session`) plus the two global decision channels.
//
// Deliberate scope: one self-contained document — no framework, no build step,
// no static assets. The streaming text rides the mux `chunk` stream (coalesced
// ~25 ms frames) instead of the durable event log, so the transcript fills in as
// the model types; the durable log stays the source of truth on reload.

/** Escape text for HTML (the transcript is arbitrary model/tool output). */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

/** The document. `version` is shown in the header (the same string
 * /api/health reports). */
export function renderSessionsPage(version = "0.1.0"): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>I-harness</title>
<style>
  :root { --bg:#141414; --panel:#1c1c1c; --line:#2c2c2c; --text:#d8d8d8; --dim:#767676; --accent:#7dcfdf; --user:#c8a2ff; --tool:#8fd47a; --warn:#e0b060; }
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:flex; flex-direction:column; background:var(--bg); color:var(--text);
         font:13px/1.55 "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace; }
  header { padding:8px 12px; border-bottom:1px solid var(--line); color:var(--dim); display:flex; gap:12px; align-items:center; }
  header b { color:var(--text); font-weight:600; }
  header .grow { flex:1; }
  main { flex:1; display:flex; min-height:0; }
  aside { width:300px; border-right:1px solid var(--line); overflow:auto; background:var(--panel); display:flex; flex-direction:column; }
  aside h2 { margin:0; padding:8px 12px; font-size:12px; color:var(--dim); font-weight:600; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--panel); }
  .row { padding:7px 12px; border-bottom:1px solid var(--line); cursor:pointer; }
  .row:hover { background:#222; }
  .row.on { background:#262626; box-shadow: inset 2px 0 0 var(--accent); }
  .row .id { color:var(--text); }
  .row .meta { color:var(--dim); font-size:12px; }
  .pane { flex:1; display:flex; flex-direction:column; min-width:0; }
  section { flex:1; overflow:auto; padding:16px 20px; }
  .turn { color:var(--dim); margin:14px 0 6px; }
  .user { color:var(--user); white-space:pre-wrap; margin:2px 0; }
  .assistant { white-space:pre-wrap; margin:6px 0; }
  .assistant.stream { color:#b9b9b9; }
  .tool { color:var(--tool); white-space:pre-wrap; margin:2px 0; }
  .result { color:var(--dim); white-space:pre-wrap; margin:0 0 6px; }
  .thinking { color:var(--dim); font-style:italic; margin:2px 0; }
  .hint, .empty { color:var(--dim); }
  .err { color:var(--warn); white-space:pre-wrap; margin:6px 0; }
  button { background:#242424; color:var(--text); border:1px solid var(--line); border-radius:4px; padding:4px 10px; font:inherit; cursor:pointer; margin:8px 0; }
  button:hover { background:#2c2c2c; }
  button:disabled { opacity:.5; cursor:default; }
  a { color:var(--accent); }
  /* Composer: the face of the mux command endpoint. */
  .composer { border-top:1px solid var(--line); padding:8px 12px; background:var(--panel); }
  .composer textarea { width:100%; resize:none; background:#141414; color:var(--text); border:1px solid var(--line);
                       border-radius:4px; padding:7px 9px; font:inherit; min-height:34px; max-height:180px; }
  .composer textarea:focus { outline:none; border-color:var(--accent); }
  .composer .bar { display:flex; gap:8px; align-items:center; color:var(--dim); font-size:12px; margin-top:5px; }
  .composer .bar .grow { flex:1; }
  .composer button { margin:0; }
  /* Approval / question banners — the two global decision channels. */
  #asks { padding:0 12px; }
  .ask { border:1px solid var(--warn); border-radius:4px; padding:8px 10px; margin:8px 0; background:#1f1a12; }
  .ask .q { color:var(--warn); white-space:pre-wrap; }
  .ask .why { color:var(--dim); white-space:pre-wrap; font-size:12px; margin-top:3px; }
  .ask .opts { margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; }
  .ask button { margin:0; }
</style>
</head>
<body>
<header><b>I-harness</b><span>v${escapeHtml(version)}</span><span class="grow"></span><span id="root"></span></header>
<main>
  <aside>
    <h2>Sessions</h2>
    <div id="sessions"></div>
    <div style="padding:0 12px"><button id="new">+ new session</button></div>
  </aside>
  <div class="pane">
    <section id="view"><p class="hint">Select a session, or start a new one.</p></section>
    <div id="asks"></div>
    <div class="composer">
      <textarea id="prompt" rows="1" placeholder="Send a prompt…  (Enter to send, Shift+Enter for a newline)" disabled></textarea>
      <div class="bar">
        <span id="status" class="grow">no session</span>
        <button id="send" disabled>Send</button>
      </div>
    </div>
  </div>
</main>
<script>
const view = document.getElementById("view");
const list = document.getElementById("sessions");
const asks = document.getElementById("asks");
const promptEl = document.getElementById("prompt");
const sendEl = document.getElementById("send");
const statusEl = document.getElementById("status");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const oneLine = (v, cap) => { try { const t = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  const f = t.replace(/\\s+/g, " ").trim(); return f.length > (cap || 200) ? f.slice(0, cap || 200) + "…" : f; } catch { return String(v); } };
const age = (ms) => { if (!ms) return ""; const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now"; const m = Math.floor(s/60); if (m < 60) return m + "m";
  const h = Math.floor(m/60); return h < 24 ? h + "h" : Math.floor(h/24) + "d"; };

// ── transcript ──────────────────────────────────────────────────────────────
// Rows are the page's own view model (same vocabulary as the TUI/read-only
// page). One entry per scrolled-back line; the DOM is rebuilt on change because
// a transcript is append-mostly and small (the events HTTP page caps it).
let rows = [];
let streaming = false;

function rowHtml(row) {
  const cls = row.kind === "assistant-stream" ? "assistant stream" : row.kind;
  return '<div class="' + cls + '">' + esc(row.text) + "</div>";
}

function rowOf(ev) {
  switch (ev.type) {
    case "turn/start": return { kind: "turn", text: "─── turn" };
    case "user/message": return (ev.internal === true || (ev.source && ev.source.kind === "plugin"))
      ? undefined : { kind: "user", text: "❯ " + (ev.text || "") };
    case "assistant/message": return { kind: "assistant", text: ev.text || "" };
    case "reasoning": return { kind: "reasoning", text: "✦ " + oneLine(ev.text || "") };
    case "tool/call": return { kind: "tool", text: "◆ " + (ev.name || "") + " " + oneLine(ev.args) };
    case "tool/result": return { kind: "result", text: "→ " + oneLine(ev.output, 300) };
    default: return undefined;
  }
}

function paint() {
  view.innerHTML = rows.map(rowHtml).join("") || '<p class="hint">No messages yet — send a prompt below.</p>';
  view.scrollTop = view.scrollHeight;
}

/** One durable event → the transcript. assistant/message closes an open
 * streaming row: the chunk stream already painted the same text. */
function applyEvent(ev) {
  if (ev.type === "assistant/message" || ev.type === "turn/end") streaming = false;
  const row = rowOf(ev);
  if (row) rows.push(row);
}

/** A coalesced assistant text frame (mux chunk stream, ~25 ms windows). */
function applyChunk(text) {
  if (!text) return;
  const last = rows[rows.length - 1];
  if (streaming && last && last.kind === "assistant-stream") last.text += text;
  else { rows.push({ kind: "assistant-stream", text: text }); streaming = true; }
}

// ── mux (one socket: streams + decision channels) ───────────────────────────
let socket;
let socketReady = false;
const pending = [];         // frames queued while the socket connects
const streamShown = {};     // streamId -> "transcript" | "status"
let commandStream;          // the in-flight turn's streamId (undefined = idle)
let approvalStream;         // the global approval channel's streamId
let questionStream;         // the global question channel's streamId
let seq = 0;                // next streamId
let current;                // the selected session's id
let busy = false;

function send(frame) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(frame));
  else pending.push(frame);
}

function openEndpoint(endpoint, payload, shown) {
  const streamId = "st" + (++seq);
  streamShown[streamId] = shown;
  send({ type: "open", streamId: streamId, endpoint: endpoint, payload: payload });
  return streamId;
}

function connect() {
  if (typeof WebSocket === "undefined") return
  socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/mux");
  socket.onopen = () => {
    socketReady = true;
    // The two channels are GLOBAL and must exist before any agent run: an
    // approval emitted with no open stream is dropped, and the waterfall's
    // fail-closed timeout decides it (it can never be approved late).
    approvalStream = openEndpoint("approval", {}, "approval");
    questionStream = openEndpoint("question", {}, "question");
    while (pending.length) socket.send(JSON.stringify(pending.shift()));
    if (current) select(current);
  };
  socket.onclose = () => { socketReady = false; setStatus("disconnected — reload to reconnect"); };
  socket.onmessage = (raw) => {
    let msg; try { msg = JSON.parse(raw.data); } catch { return; }
    const shown = streamShown[msg.streamId];
    if (msg.type === "ready") {
      if (msg.streamId === commandStream) setBusy(true);
      return;
    }
    if (msg.type === "end") {
      if (msg.streamId === commandStream) { commandStream = undefined; setBusy(false); setStatus("ready"); }
      return;
    }
    if (msg.type === "error") {
      if (msg.streamId === commandStream) { commandStream = undefined; setBusy(false); }
      rows.push({ kind: "err", text: "stream error: " + String(msg.error) });
      paint();
      setStatus("error");
      return;
    }
    if (msg.type !== "item") return;
    const value = msg.value;
    if (shown === "transcript") applyEvent(value);
    else if (shown === "chunk") applyChunk(String(value));
    else if (shown === "reasoning") applyChunk("✦ " + String(value));
    else if (shown === "command") {
      if (value && value.status === "error") { rows.push({ kind: "err", text: "turn failed: " + String(value.error) }); paint(); }
      if (value && value.status === "ok") {
        // The turn is durable now — re-read the log so the transcript is the
        // LOG's version (chunk frames are coalesced, the log is exact).
        if (current) void reload(current);
      }
    } else if (shown === "approval") showApproval(msg.streamId, value);
    else if (shown === "question") showQuestion(msg.streamId, value);
    if (shown === "transcript" || shown === "chunk" || shown === "reasoning") paint();
  };
}

function setStatus(text) { statusEl.textContent = text; }
function setBusy(on) {
  busy = on;
  sendEl.textContent = on ? "Stop" : "Send";
  sendEl.disabled = !current;
  promptEl.disabled = !current;
}

// ── approvals + questions (the two global decision channels) ────────────────
function askCard(kind, id, question, why, options, answer) {
  const card = document.createElement("div");
  card.className = "ask";
  card.setAttribute("data-ask", id);
  let html = '<div class="q">' + esc(question) + "</div>";
  if (why) html += '<div class="why">' + esc(why) + "</div>";
  card.innerHTML = html;
  const bar = document.createElement("div");
  bar.className = "opts";
  const add = (label, value) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { answer(value); card.remove(); };
    bar.appendChild(b);
  };
  if (kind === "approval") { add("Approve", true); add("Reject", false); }
  else {
    const opts = Array.isArray(options) && options.length ? options : undefined;
    if (opts) for (const o of opts) add(o, o);
    else {
      const input = document.createElement("input");
      input.setAttribute("data-answer", id);
      input.placeholder = "answer…";
      bar.appendChild(input);
      add("Answer", null);
    }
  }
  card.appendChild(bar);
  asks.appendChild(card);
}

function showApproval(streamId, req) {
  askCard("approval", req.approvalId, (req.name || "tool") + " — " + (req.reason || "approval requested"),
    req.command || req.pathSummary || "", undefined,
    (approved) => { send({ type: "approval", streamId: streamId, value: { approvalId: req.approvalId, approved: approved } }); });
}

function showQuestion(streamId, req) {
  askCard("question", req.questionId, req.text || "", req.kind || "", req.options,
    (answer) => {
      let value = answer;
      if (value === null) {
        const input = asks.querySelector('[data-answer="' + req.questionId + '"]');
        value = input ? input.value : "";
      }
      send({ type: "answer", streamId: streamId, value: { questionId: req.questionId, answer: String(value) } });
    });
}

// ── sessions ────────────────────────────────────────────────────────────────
async function loadSessions() {
  const res = await fetch("/api/sessions");
  if (!res.ok) { list.innerHTML = '<p class="empty">sessions unavailable (' + res.status + ")</p>"; return; }
  const { sessions = [] } = await res.json();
  if (sessions.length === 0) { list.innerHTML = '<p class="empty">no sessions in this store</p>'; return; }
  const sorted = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  list.innerHTML = sorted.map((s) => {
    const badges = [s.running ? "running" : "", s.blank ? "empty" : ""].filter(Boolean).join(" · ");
    return '<div class="row" data-id="' + esc(s.id) + '"><div class="id">' + esc(s.title || s.id) + "</div>"
      + '<div class="meta">' + esc([s.updatedAt ? age(s.updatedAt) : "", badges].filter(Boolean).join(" · ") || s.id) + "</div></div>";
  }).join("");
  for (const row of list.querySelectorAll(".row")) row.onclick = () => select(row.dataset.id, row);
}

let liveSession; // the open session stream for the selected session

async function reload(id) {
  rows = []; streaming = false;
  const res = await fetch("/api/sessions/" + encodeURIComponent(id) + "/events?limit=200");
  if (!res.ok) { view.innerHTML = '<p class="empty">events unavailable (' + res.status + ")</p>"; return; }
  const data = await res.json();
  rows = (data.events || []).map(rowOf).filter(Boolean);
  streaming = false;
  paint();
  const last = (data.events || [])[data.events.length - 1];
  seq = Math.max(seq, typeof last?.seq === "number" ? last.seq : 0);
}

async function select(id, row) {
  current = id;
  for (const r of list.querySelectorAll(".row")) r.classList.toggle("on", r.dataset.id === id);
  if (row) row.classList.add("on");
  asks.innerHTML = "";
  setBusy(false);
  setStatus("loading…");
  await reload(id);
  if (liveSession) send({ type: "cancel", streamId: liveSession });
  liveSession = openEndpoint("session", { sessionId: id }, "transcript");
  // Streaming text rides the chunk/reasoning streams; both terminate on the
  // authoritative assistant/message, so they are re-opened per turn below.
  openEndpoint("chunk", { sessionId: id }, "chunk");
  openEndpoint("reasoning", { sessionId: id }, "reasoning");
  setStatus("ready");
  promptEl.focus();
}

async function newSession() {
  const res = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!res.ok) { setStatus("could not create a session (" + res.status + ")"); return; }
  const { id } = await res.json();
  await loadSessions();
  await select(id);
  for (const r of list.querySelectorAll(".row")) r.classList.toggle("on", r.dataset.id === id);
}

// ── composer ────────────────────────────────────────────────────────────────
function submit() {
  if (!current) return;
  if (busy) { if (commandStream) send({ type: "cancel", streamId: commandStream }); return; }
  const text = promptEl.value.trim();
  if (text === "") return;
  promptEl.value = "";
  promptEl.style.height = "auto";
  rows.push({ kind: "user", text: "❯ " + text });
  paint();
  commandStream = openEndpoint("command", { sessionId: current, prompt: text }, "command");
  setStatus("running…");
}

sendEl.onclick = submit;
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
});
promptEl.addEventListener("input", () => {
  promptEl.style.height = "auto";
  promptEl.style.height = Math.min(promptEl.scrollHeight, 180) + "px";
});
document.getElementById("new").onclick = () => { void newSession(); };

connect();
void loadSessions();
</script>
</body>
</html>
`
}
