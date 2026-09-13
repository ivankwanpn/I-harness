import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SCRATCH = 'D:/I-harness-main/docs/audit/data/_dsh_scratch'
const OUT = 'D:/I-harness-main/docs/audit/data/2026-09-11-d3-dsh.json'
const ALL = readFileSync(join(SCRATCH, '_all_modules.txt'), 'utf8')
  .split(/\r?\n/).map(s => s.trim()).filter(Boolean)

const DOMAIN_ORDER = ['loop', 'session', 'context', 'tools', 'subagent', 'safety', 'model', 'extension', 'service', 'retrieval', 'ops', 'interface']

/** domain -> list of {file, path} */
const SOURCES = {
  loop: [{ file: '_mine-loop.json' }],
  session: [{ file: 'session.json' }],
  context: [{ file: '_mine-context.json' }],
  tools: [{ file: 'tools.json' }],
  subagent: [{ file: 'subagent.json' }],
  safety: [{ file: 'safety-model.json', path: ['domains', 'safety'] }],
  model: [{ file: 'safety-model.json', path: ['domains', 'model'] }],
  extension: [{ file: 'ext-retrieval.json', path: ['domains', 'extension'] }],
  retrieval: [{ file: 'ext-retrieval.json', path: ['domains', 'retrieval'] }],
  service: [{ file: 'service-interface-ops.json', path: ['domains', 'service'] }],
  interface: [{ file: 'service-interface-ops.json', path: ['domains', 'interface'] }],
  ops: [{ file: 'service-interface-ops.json', path: ['domains', 'ops'] }],
}

const cache = new Map()
function load(file) {
  if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(join(SCRATCH, file), 'utf8')))
  return cache.get(file)
}
function at(obj, path) {
  let cur = obj
  for (const k of path ?? []) cur = cur[k]
  return cur
}

const domains = {}
const coverage = new Map() // module -> { mechanisms: Set, reasons: [] }
const problems = []

for (const d of DOMAIN_ORDER) {
  const mechs = []
  for (const s of SOURCES[d]) {
    const node = at(load(s.file), s.path)
    if (node === undefined) { problems.push(`missing node for ${d} in ${s.file}`); continue }
    for (const m of node.mechanisms) mechs.push(m)
    for (const [k, v] of Object.entries(node.moduleCoverage ?? {})) {
      const entry = coverage.get(k) ?? { mechs: [], reasons: [] }
      const text = Array.isArray(v) ? v.join(' | ') : String(v)
      const isReason = /^(no |none\b)/i.test(text) || /contributes no|no [a-z-]+-domain mechanism|no backend mechanism|no production/i.test(text)
      if (isReason) entry.reasons.push(`${d}: ${text}`)
      else entry.mechs.push(`${d}: ${text}`)
      coverage.set(k, entry)
    }
  }
  domains[d] = mechs
}

const moduleCoverage = {}
for (const mod of ALL) {
  const e = coverage.get(mod)
  if (!e) { moduleCoverage[mod] = 'UNCOVERED'; problems.push(`UNCOVERED module: ${mod}`); continue }
  moduleCoverage[mod] = e.mechs.length > 0
    ? [...new Set(e.mechs)].join(' | ')
    : (e.reasons[0] ?? 'UNCOVERED')
}
for (const k of coverage.keys()) if (!ALL.includes(k)) problems.push(`EXTRA coverage key not in checklist: ${k}`)

const meta = JSON.parse(readFileSync(join(SCRATCH, '_mine-meta.json'), 'utf8'))

// Expand grouped corrections into one entry per module.
const hintCorrections = []
const seenHint = new Set()
for (const g of meta.hintGroups) {
  for (const mod of g.modules) {
    if (seenHint.has(mod)) { problems.push(`duplicate hintCorrection for ${mod}`); continue }
    seenHint.add(mod)
    if (!ALL.includes(mod)) problems.push(`hintCorrection for unknown module ${mod}`)
    hintCorrections.push({
      module: mod,
      hintDomain: g.hintDomain,
      correctedDomain: g.correctedDomain,
      reason: g.reason,
    })
  }
}
hintCorrections.sort((a, b) => a.module.localeCompare(b.module))

const out = {
  source: 'dsh',
  sourcePath: 'D:/agent-complete/deepseek-harness-dsh-v0.1.5-rc.2',
  moduleCount: 267,
  domains,
  moduleCoverage,
  hintCorrections,
  domainsAbsent: meta.domainsAbsent,
  pluginKernel: meta.pluginKernel,
  notes: meta.notes,
}

writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8')

const counts = Object.fromEntries(DOMAIN_ORDER.map(d => [d, domains[d].length]))
console.log('mechanism counts:', JSON.stringify(counts))
console.log('total mechanisms:', Object.values(counts).reduce((a, b) => a + b, 0))
console.log('coverage keys:', Object.keys(moduleCoverage).length, 'checklist:', ALL.length)
console.log('problems:', problems.length)
for (const p of problems) console.log('  ' + p)
