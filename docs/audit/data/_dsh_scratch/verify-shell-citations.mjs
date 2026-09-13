// Citation sanity pass: every cited line must exist, and a deterministic sample
// is echoed so the auditor can eyeball that the quoted mechanism is really there.
import { readFileSync } from 'node:fs'

const root = 'D:/agent-complete/deepseek-harness-dsh-v0.1.5-rc.2/'
const audit = JSON.parse(readFileSync('D:/I-harness-main/docs/audit/data/_shell_raw.json', 'utf8'))

const cache = new Map()
function lines(rel) {
  if (!cache.has(rel)) cache.set(rel, readFileSync(root + rel, 'utf8').split(/\r?\n/))
  return cache.get(rel)
}

const problems = []
const all = []
for (const m of audit.mechanisms) {
  for (const e of m.evidence) {
    const idx = e.lastIndexOf(':')
    const rel = e.slice(0, idx)
    const n = Number(e.slice(idx + 1))
    let file
    try { file = lines(rel) } catch (err) { problems.push(`${m.name}: unreadable ${rel}`); continue }
    if (!Number.isSafeInteger(n) || n < 1 || n > file.length) {
      problems.push(`${m.name}: OUT OF RANGE ${e} (file has ${file.length} lines)`)
      continue
    }
    all.push({ mech: m.name, cite: e, text: (file[n - 1] ?? '').trim() })
  }
}

const names = audit.mechanisms.map(m => m.name)
process.stdout.write(`mechanisms=${names.length}\ncitations=${all.length}\nproblems=${problems.length}\n`)
if (problems.length > 0) process.stdout.write(`${problems.join('\n')}\n`)
process.stdout.write(`\n--- mechanism names ---\n${names.join('\n')}\n`)

// Deterministic sample: every 12th citation.
process.stdout.write(`\n--- sampled citation lines ---\n`)
for (let i = 0; i < all.length; i += 12) {
  const c = all[i]
  process.stdout.write(`[${c.mech}] ${c.cite}\n    ${c.text.slice(0, 150)}\n`)
}
