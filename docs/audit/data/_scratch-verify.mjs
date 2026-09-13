import fs from "node:fs"
import path from "node:path"

const DATA = "D:/I-harness-main/docs/audit/data"
const roots = {
  upstream: "D:/agent-complete/opencode-1.18.30",
  fork: "D:/agent-complete/opencode-fork-private-999.0.15",
}

const jobs = [
  { file: "_scratch-mine-upstream.json", root: roots.upstream, label: "mine-upstream" },
  { file: "_scratch-upstream-peripheral.json", root: roots.upstream, label: "periph-upstream" },
  { file: "_scratch-mine-fork.json", root: roots.fork, label: "mine-fork" },
  { file: "_scratch-fork-peripheral.json", root: roots.fork, label: "periph-fork" },
]

const cache = new Map()
function lines(p) {
  if (!cache.has(p)) cache.set(p, fs.existsSync(p) ? fs.readFileSync(p, "utf8").split(/\r?\n/) : null)
  return cache.get(p)
}

let total = 0
const problems = []
const samples = []

for (const job of jobs) {
  const full = path.join(DATA, job.file)
  if (!fs.existsSync(full)) {
    problems.push(`${job.label}: MISSING FILE ${full}`)
    continue
  }
  const doc = JSON.parse(fs.readFileSync(full, "utf8"))
  const domains = doc.domains ?? {}
  for (const [domain, mechs] of Object.entries(domains)) {
    for (const m of mechs) {
      const evs = m.evidence ?? []
      if (evs.length === 0) problems.push(`${job.label}/${domain}/${m.name}: NO EVIDENCE`)
      const quotes = m.quote ?? []
      evs.forEach((ev, i) => {
        total++
        const mm = /^(.*?):(\d+)(?:-(\d+))?$/.exec(ev)
        if (!mm) {
          problems.push(`${job.label}/${m.name}: BAD FORMAT ${ev}`)
          return
        }
        const rel = mm[1]
        const start = Number(mm[2])
        const end = mm[3] ? Number(mm[3]) : start
        const p = path.join(job.root, rel)
        const ls = lines(p)
        if (!ls) {
          problems.push(`${job.label}/${m.name}: MISSING FILE ${rel}`)
          return
        }
        if (start < 1 || end > ls.length || end < start) {
          problems.push(`${job.label}/${m.name}: OUT OF RANGE ${ev} (file has ${ls.length} lines)`)
          return
        }
        const text = ls[start - 1].trim()
        const q = (quotes[i] ?? "").trim()
        if (q && !text.includes(q.slice(0, Math.min(60, q.length))) && !q.includes(text.slice(0, Math.min(60, text.length)))) {
          problems.push(`${job.label}/${m.name}: QUOTE MISMATCH ${ev}\n    file: ${text.slice(0, 160)}\n    quote: ${q.slice(0, 160)}`)
        }
        if (samples.length < 12) samples.push(`${job.label} | ${ev} | ${text.slice(0, 120)}`)
      })
    }
  }
}

console.log("total evidence entries checked:", total)
console.log("problems:", problems.length)
for (const p of problems.slice(0, 120)) console.log(" -", p)
console.log("\nsamples:")
for (const s of samples) console.log(" *", s)
