import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import ts from '../../../node_modules/typescript/lib/typescript.js'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = [
  'packages/session-persistence/src/coordinator/managed-document.ts',
  'packages/session-persistence/src/coordinator/settlement-fact.ts',
  'packages/session-persistence/src/coordinator/source-facts.ts',
  'packages/session-persistence/src/coordinator/received-input-source.ts',
  'packages/session-persistence/src/coordinator/received-input-cancellation.ts',
  'packages/desktop-gateway/src/session-subagents.ts',
  ...['changes', 'scope', 'catalog', 'read', 'control', 'types', 'result-proof', 'catalog-provenance'].map(name => 'packages/desktop-gateway/src/subagents/' + name + '.ts'),
]
const rows = []
for (const path of files) {
  const bytes = await readFile(path), lf = bytes.toString('utf8').replaceAll('\r\n', '\n'), source = ts.createSourceFile(path, lf, ts.ScriptTarget.Latest, true), functions = []
  const visit = node => {
    if (ts.isFunctionDeclaration(node)) functions.push({ name: node.name?.text ?? '(anonymous)', lines: source.getLineAndCharacterOfPosition(node.end).line - source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, characters: node.end - node.getStart(source) })
    ts.forEachChild(node, visit)
  }
  visit(source)
  rows.push({ path, bytes: bytes.length, sha256: hash(bytes), physicalLines: lf.trimEnd().split('\n').length, functions })
}
await writeFile('.superpowers/sdd/2026-10-21-context-r4a-original-range-review/host-close-structure-audit.json', JSON.stringify({ scope: 'Static current-source AST/identity inspection before final handback, no product imports', productFreeze: '678af03dd54659e22dd5f941112c06ec9917e812', rows }, null, 2))
console.log(JSON.stringify(rows.map(row => ({ path: row.path, physicalLines: row.physicalLines, functions: row.functions.filter(fn => fn.name.startsWith('create') || fn.name === 'cancellationRetirementFor') })), null, 2))
