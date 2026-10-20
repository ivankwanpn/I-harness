// Parses maintained source text only; does not import product modules.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
const repo = 'D:/I-harness-main'
const require = createRequire(path.join(repo, 'package.json'))
const ts = require('typescript')
const roots = [
  'packages/subagent/src/task', 'packages/subagent/src/task-protocol.ts', 'packages/subagent/src/jobs.ts',
  'packages/context-output/src', 'packages/desktop-gateway/src/subagents',
  'packages/desktop-gateway/src/session-subagents.ts', 'packages/desktop-gateway/src/session-visibility.ts',
]
const files = []
function collect(p) {
  const full = path.join(repo, p)
  if (fs.statSync(full).isDirectory()) for (const e of fs.readdirSync(full)) collect(path.join(p, e))
  else if (p.endsWith('.ts')) files.push(p.replaceAll('\\', '/'))
}
roots.forEach(collect)
const rows = files.sort().map(p => {
  const bytes = fs.readFileSync(path.join(repo, p)), text = bytes.toString('utf8')
  const source = ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true)
  const functions = []
  function visit(node) {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
      const start = node.getStart(source), end = node.getEnd()
      const first = source.getLineAndCharacterOfPosition(start).line + 1
      const last = source.getLineAndCharacterOfPosition(end).line + 1
      const name = node.name?.getText(source) ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(source) : ts.isPropertyAssignment(node.parent) ? node.parent.name.getText(source) : '<anonymous>')
      functions.push({ name, first, last, physicalLines: last - first + 1, characters: end - start })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { path: p, physicalLines: text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0),
    bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    largest: functions.sort((a, b) => b.physicalLines - a.physicalLines || b.characters - a.characters).slice(0, 3),
    hardCandidates: functions.filter(x => x.physicalLines >= 250 || x.characters >= 18000) }
})
const output = new URL('./census-after.json', import.meta.url)
fs.writeFileSync(output, JSON.stringify({ method: 'TypeScript AST; inclusive physical start/end; comments/blank physical file lines; no product imports', rows }, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ files: rows.length, hardCandidates: rows.filter(r => r.hardCandidates.length).map(r => ({ path: r.path, functions: r.hardCandidates })) }))
