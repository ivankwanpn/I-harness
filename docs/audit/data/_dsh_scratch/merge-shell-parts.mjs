// One-shot merge of the audited part files into the single deliverable shape.
// Parts were produced with the `write` tool; this only concatenates them.
import { readFileSync, writeFileSync } from 'node:fs'

const dir = 'D:/I-harness-main/docs/audit/data/_dsh_scratch'
const parts = ['_shell_partA.json', '_shell_partB.json', '_shell_partC.json', '_shell_partD.json', '_shell_partE.json']

const mechanisms = []
const moduleCoverage = {}
const notes = []

for (const name of parts) {
  const raw = readFileSync(`${dir}/${name}`, 'utf8')
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.mechanisms)) throw new Error(`${name}: mechanisms missing`)
  const seen = new Set()
  for (const m of parsed.mechanisms) {
    if (typeof m.name !== 'string' || m.name.length === 0) throw new Error(`${name}: mechanism without name`)
    if (seen.has(m.name)) throw new Error(`${name}: duplicate mechanism ${m.name}`)
    seen.add(m.name)
    if (!Array.isArray(m.evidence) || m.evidence.length === 0) throw new Error(`${m.name}: no evidence`)
    mechanisms.push(m)
  }
  for (const [pkg, info] of Object.entries(parsed.moduleCoverage ?? {})) {
    if (moduleCoverage[pkg] !== undefined) throw new Error(`duplicate moduleCoverage entry ${pkg}`)
    moduleCoverage[pkg] = info
  }
  notes.push(`### ${name} — ${parsed.group}\n${parsed.notes}`)
}

const allNames = new Set(mechanisms.map(m => m.name))
if (allNames.size !== mechanisms.length) throw new Error('duplicate mechanism names across parts')

const out = {
  mechanisms,
  moduleCoverage,
  notes: notes.join('\n\n'),
}

const target = 'D:/I-harness-main/docs/audit/data/_shell_raw.json'
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, { encoding: 'utf8' })

// Verification pass: re-parse and report shape.
const check = JSON.parse(readFileSync(target, 'utf8'))
const withCitations = check.mechanisms.filter(m => m.evidence.every(e => /^packages\/.+:\d+$/.test(e)))
const totalCitations = check.mechanisms.reduce((sum, m) => sum + m.evidence.length, 0)
const totalConstants = check.mechanisms.reduce((sum, m) => sum + (m.constants?.length ?? 0), 0)
process.stdout.write(JSON.stringify({
  mechanisms: check.mechanisms.length,
  moduleCoverage: Object.keys(check.moduleCoverage).length,
  totalCitations,
  mechanismsWithWellFormedCitations: withCitations.length,
  totalConstants,
  unverified: check.mechanisms.filter(m => m.verified !== true).map(m => m.name),
  bytes: Buffer.byteLength(readFileSync(target)),
}, null, 2) + '\n')
