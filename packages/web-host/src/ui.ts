// M61: the read-only web page served at `/`.
//
// WHY: `i-harness web` was a pure JSON/WS API — `/` answered 404, so the
// session rows the API serves had no face at all. This is the smallest useful
// one: a session list and a transcript, one self-contained HTML document (no
// framework, no build step, no static asset pipeline), reading the SAME
// endpoints any other client would:
//
//   GET /api/sessions                       → the rows
//   GET /api/sessions/:id/events?limit&beforeSeq → the transcript (paged
//                                                 BACKWARD: "load older")
//
// It is READ-ONLY on purpose: sending prompts, approvals and questions go
// through the mux, which a chat UI needs — a later slice, and the reason this
// page stays a viewer.

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
  :root { --bg:#141414; --panel:#1c1c1c; --line:#2c2c2c; --text:#d8d8d8; --dim:#767676; --accent:#7dcfdf; --user:#c8a2ff; --tool:#8fd47a; }
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:flex; flex-direction:column; background:var(--bg); color:var(--text);
         font:13px/1.55 "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace; }
  header { padding:8px 12px; border-bottom:1px solid var(--line); color:var(--dim); display:flex; gap:12px; }
  header b { color:var(--text); font-weight:600; }
  main { flex:1; display:flex; min-height:0; }
  aside { width:320px; border-right:1px solid var(--line); overflow:auto; background:var(--panel); }
  aside h2 { margin:0; padding:8px 12px; font-size:12px; color:var(--dim); font-weight:600; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--panel); }
  .row { padding:7px 12px; border-bottom:1px solid var(--line); cursor:pointer; }
  .row:hover { background:#222; }
  .row.on { background:#262626; box-shadow: inset 2px 0 0 var(--accent); }
  .row .id { color:var(--text); }
  .row .meta { color:var(--dim); font-size:12px; }
  section { flex:1; overflow:auto; padding:16px 20px; }
  .turn { color:var(--dim); margin:14px 0 6px; }
  .user { color:var(--user); white-space:pre-wrap; margin:2px 0; }
  .assistant { white-space:pre-wrap; margin:6px 0; }
  .tool { color:var(--tool); white-space:pre-wrap; margin:2px 0; }
  .result { color:var(--dim); white-space:pre-wrap; margin:0 0 6px; }
  .thinking { color:var(--dim); font-style:italic; margin:2px 0; }
  .hint, .empty { color:var(--dim); }
  button { background:#242424; color:var(--text); border:1px solid var(--line); border-radius:4px; padding:4px 10px; font:inherit; cursor:pointer; margin:8px 0; }
  button:hover { background:#2c2c2c; }
  a { color:var(--accent); }
</style>
</head>
<body>
<header><b>I-harness</b><span>v${escapeHtml(version)}</span><span id="root"></span></header>
<main>
  <aside><h2>Sessions</h2><div id="sessions"></div></aside>
  <section id="view"><p class="hint">Select a session.</p></section>
</main>
<script>
const view = document.getElementById("view");
const list = document.getElementById("sessions");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const oneLine = (v) => { try { return (typeof v === "string" ? v : JSON.stringify(v) ?? "").replace(/\\s+/g, " ").trim(); } catch { return String(v); } };
const age = (ms) => { if (!ms) return ""; const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now"; const m = Math.floor(s/60); if (m < 60) return m + "m";
  const h = Math.floor(m/60); return h < 24 ? h + "h" : Math.floor(h/24) + "d"; };

async function loadSessions() {
  const res = await fetch("/api/sessions");
  if (!res.ok) { list.innerHTML = '<p class="empty">sessions unavailable (' + res.status + ")</p>"; return; }
  const { sessions = [] } = await res.json();
  if (sessions.length === 0) { list.innerHTML = '<p class="empty">no sessions in this store</p>'; return; }
  // Newest first (the API keeps its own order; the page sorts for reading).
  const rows = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  list.innerHTML = rows.map((s) => {
    const badges = [s.running ? "running" : "", s.blank ? "empty" : ""].filter(Boolean).join(" · ");
    return '<div class="row" data-id="' + esc(s.id) + '"><div class="id">' + esc(s.title || s.id) + "</div>"
      + '<div class="meta">' + esc([s.updatedAt ? age(s.updatedAt) : "", badges].filter(Boolean).join(" · ") || s.id) + "</div></div>";
  }).join("");
  for (const row of list.querySelectorAll(".row")) row.onclick = () => open(row.dataset.id, row);
}

function line(ev) {
  switch (ev.type) {
    case "turn/start": return '<div class="turn">─── turn</div>';
    case "user/message": return ev.internal === true || (ev.source && ev.source.kind === "plugin")
      ? "" : '<div class="user">❯ ' + esc(ev.text || "") + "</div>";
    case "assistant/message": return '<div class="assistant">' + esc(ev.text || "") + "</div>";
    case "reasoning": return '<div class="thinking">✦ ' + esc(oneLine(ev.text || "").slice(0, 200)) + "</div>";
    case "tool/call": return '<div class="tool">◆ ' + esc(ev.name) + " " + esc(oneLine(ev.args).slice(0, 200)) + "</div>";
    case "tool/result": return '<div class="result">→ ' + esc(oneLine(ev.output).slice(0, 300)) + "</div>";
    default: return "";
  }
}

async function open(id, row) {
  for (const r of list.querySelectorAll(".row")) r.classList.remove("on");
  if (row) row.classList.add("on");
  view.innerHTML = '<p class="hint">loading…</p>';
  const state = { id, oldest: undefined, done: false };
  view.innerHTML = '<div id="older"></div><div id="body"></div>';
  const body = view.querySelector("#body");
  async function page() {
    const q = state.oldest === undefined ? "?limit=200" : "?limit=200&beforeSeq=" + state.oldest;
    const res = await fetch("/api/sessions/" + encodeURIComponent(id) + "/events" + q);
    if (!res.ok) { body.insertAdjacentHTML("afterbegin", '<p class="empty">events unavailable (' + res.status + ")</p>"); return; }
    const data = await res.json();
    body.insertAdjacentHTML("afterbegin", (data.events || []).map(line).join(""));
    state.oldest = data.nextBeforeSeq;
    state.done = !data.hasMore;
    view.querySelector("#older").innerHTML = state.done ? "" : '<button id="more">load older</button>';
    const more = view.querySelector("#more");
    if (more) more.onclick = () => { more.remove(); page(); };
  }
  await page();
}

loadSessions();
</script>
</body>
</html>
`
}
