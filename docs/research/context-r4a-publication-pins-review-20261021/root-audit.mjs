import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const work = path.join(root, '.superpowers/sdd/2026-10-21-context-r4a-publication-pins')
const evidence = path.join(root, '.tmp/context-r4a-publication-pins-20261021-implementation')
const base = '5e4f6038a98a5363babda0c9a15bbbef4dc80f1b'
const head = '32c88704a56c15094d793717a1d0150799db67b1'
const sha = data => createHash('sha256').update(data).digest('hex')
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const read = p => json(path.join(evidence, p))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
const result = { base, head, failures: [], evidence: {}, source: {}, processes: {}, cases: [], gates: {} }
function verifyRow(parent, row) {
  const target = path.resolve(parent, row.path)
  assert(target.startsWith(path.resolve(parent) + path.sep), 'contained evidence/source path')
  const data = fs.readFileSync(target)
  assert.equal(data.length, row.bytes, `length ${row.path}`)
  assert.equal(sha(data), row.sha256, `hash ${row.path}`)
}
function checkInventory(files, parent) {
  for (const [name, row] of Object.entries(files)) {
    if (row.text !== undefined) {
      assert.equal(Buffer.byteLength(row.text), row.bytes)
      assert.equal(sha(row.text), row.sha256)
    }
    if (parent) verifyRow(parent, { path: name, ...row })
  }
}
const cuts = ['body-sync', 'leaves-sync', 'index-sync', 'staged-rename', 'manifest-rename', 'first-pin', 'first-access', 'committed-rename', 'second-pin', 'second-access']
const parent = 'publication-parent', taskDocument = 'task-publication-parent'
const literal = n => Buffer.from('{"resultText":"' + 'x'.repeat(n) + '","error":"fixed original diagnostic"}')
function operation(files) {
  const rows = Object.entries(files).filter(([p]) => p.endsWith('/operation.json'))
  assert.equal(rows.length, 1)
  return JSON.parse(rows[0][1].text)
}
function pins(files, index, op) {
  const p = Object.entries(files).filter(([p]) => p.includes('/pins/')).map(([,r]) => JSON.parse(r.text))
  const a = Object.entries(files).filter(([p]) => p.includes('/access/')).map(([,r]) => JSON.parse(r.text))
  assert.deepEqual(p.map(x => x.documentId).sort(), (index >= 8 ? [parent, taskDocument] : index >= 5 ? [taskDocument] : []).sort())
  for (const pin of p) {
    assert.equal(pin.state, 'pending'); assert.equal(pin.sessionId, parent)
    assert.equal(pin.operationId, op.owner.operationId); assert.equal(pin.revision, op.ref.revision)
  }
  assert.equal(a.length, index >= 6 ? 1 : 0)
  if (a.length) { assert.equal(a[0].pinId, sha(index >= 9 ? parent : taskDocument)); assert.equal(a[0].revision, op.ref.revision) }
}
function pages(receipt, expected) {
  assert.equal(receipt.bytes, expected.length); assert.equal(receipt.sha256, sha(expected))
  let offset = 0
  for (let i = 0; i < receipt.pages.length; i++) {
    const p = receipt.pages[i]
    assert.equal(p.offset, offset); assert(p.bytes > 0 && p.bytes <= 16384)
    offset += p.bytes
    assert.equal(p.nextOffset, i === receipt.pages.length - 1 ? null : offset)
  }
  assert.equal(offset, expected.length)
}
try {
  assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('status', '--porcelain'), '')
  const handback = json(path.join(work, 'task-1-handback.json'))
  assert.equal(handback.base, base); assert.equal(handback.head, head)
  for (const [file, hash] of [[handback.report, handback.reportSha256], [handback.delivery, handback.deliverySha256]]) assert.equal(sha(fs.readFileSync(file)), hash)
  const closure = read('closure-manifest.json')
  assert.equal(sha(fs.readFileSync(path.join(evidence, 'closure-manifest.json'))), handback.closureManifestSha256)
  assert.equal(closure.head, head); assert.equal(closure.files.length, 1418)
  assert.equal(new Set(closure.files.map(x => x.path)).size, closure.files.length)
  let sealedBytes = 0
  for (const row of closure.files) { verifyRow(evidence, row); sealedBytes += row.bytes }
  const actual = []
  function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else { assert(e.isFile()); actual.push(path.relative(evidence, p).replaceAll('\\','/')) } } }
  walk(evidence)
  assert.deepEqual(actual.filter(x => x !== 'closure-manifest.json').sort(), closure.files.map(x=>x.path).sort())
  result.evidence = { files: closure.files.length, bytes: sealedBytes, closureSha256: handback.closureManifestSha256, reportSha256: handback.reportSha256 }
  const before = read('source-before.json'), direct = read('source-qualified.json'), canonical = read('source-before-wide.json'), wide = read('source-qualified-wide.json')
  for (const rows of [before, direct, wide]) for (const row of rows) verifyRow(root, row)
  assert.equal(sha(fs.readFileSync(path.join(evidence, 'source-qualified-wide.json'))), handback.sourceQualifiedSha256)
  const blobs = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: canonical.map(r => `${base}:${r.path}\n`).join(''), maxBuffer: 64 * 1024 * 1024 })
  let at = 0, baselineIdentical = 0, baselineCrlfOnly = 0
  for (const row of canonical) {
    const end = blobs.indexOf(10, at), header = blobs.subarray(at,end).toString()
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(header); assert(match, header)
    const length = Number(match[2]), data = blobs.subarray(end + 1, end + 1 + length)
    if(length===row.bytes && sha(data)===row.sha256) baselineIdentical++
    else {
      assert(!data.includes(0), `only explicit text EOL conversion accepted: ${row.path}`)
      const text = new TextDecoder('utf-8',{fatal:true}).decode(data)
      const crlf = Buffer.from(text.replace(/(?<!\r)\n/g,'\r\n'))
      assert.equal(crlf.length,row.bytes,`BASE archive CRLF bytes ${row.path}`)
      assert.equal(sha(crlf),row.sha256,`BASE archive matches blob plus CRLF only: ${row.path}`)
      baselineCrlfOnly++
    }
    at = end + 1 + length + 1
  }
  assert.equal(at, blobs.length)
  const canonicalNames = new Set(canonical.map(r=>r.path))
  const added = wide.filter(r=>!canonicalNames.has(r.path)).map(r=>r.path).sort()
  const changed = git('diff','--name-only',`${base}..${head}`).split('\n')
  assert.equal(added.length,7); assert.deepEqual(changed.filter(x=>!x.startsWith('docs/')).sort(), added)
  assert(changed.every(x=>x.startsWith('docs/') || x.startsWith('packages/session-executor/test/') || x === 'packages/session-executor/tsconfig.publication-pins.json'))
  const zipAudit = JSON.parse(execFileSync('pwsh',['-NoProfile','-File',path.join(work,'root-zip-audit.ps1')],{cwd:root,encoding:'utf8',maxBuffer:1024*1024}))
  result.source = { initialDirect:before.length, qualifiedDirect:direct.length, baselineGitArchive:canonical.length, baselineIdentical, baselineCrlfOnly, qualifiedWide:wide.length, added, archives:zipAudit, productChanges:0, mismatch:0 }
  const summary = read('qualification-summary.json'), processes = []
  for (const e of fs.readdirSync(evidence,{withFileTypes:true})) {
    if (!e.isDirectory()) continue
    const file = path.join(evidence,e.name,'process.json')
    if (!fs.existsSync(file)) continue
    const p = json(file); assert.equal(p.parent,parent); assert.equal(p.foreign.length,0)
    assert(/^[0-9a-f-]{36}$/.test(p.nonce)); assert(Number.isInteger(p.pid) && p.pid > 0)
    for (const m of p.messages) for (const k of ['nonce','parent','mode','selected']) assert.equal(m[k],p[k])
    if (p.mode==='crash') { assert.equal(p.hardKilled,true); assert.equal(p.disposition.signal,'SIGKILL'); assert.equal(p.messages.filter(m=>m.kind==='cut').length,1) }
    else if (p.disposition.code===0) { assert.equal(p.disposition.signal,null); assert.equal(p.hardKilled,false); assert.deepEqual(p.messages.map(m=>m.kind),['done','closed']) }
    else { assert.equal(p.disposition.code,1); assert(fs.existsSync(path.join(evidence,e.name,'failure.json'))) }
    processes.push({directory:e.name,...p})
  }
  assert.equal(processes.length,90); assert.equal(new Set(processes.map(p=>p.nonce)).size,90)
  assert.deepEqual(processes.filter(p=>p.mode!=='crash'&&p.disposition.code!==0).map(p=>p.directory).sort(),summary.failures.map(p=>p.directory).sort())
  result.processes={launched:90,allClosed:true,uniqueNonce:90,failedSetup:summary.failures.length,crashProcesses:processes.filter(p=>p.mode==='crash').length}
  assert.equal(summary.finalCases.length,28)
  for (const entry of summary.finalCases) {
    const dir=path.join(evidence,entry.directory), p=processes.find(p=>p.directory===entry.directory); assert(p)
    const m=p.messages.find(m=>m.kind===(p.mode==='crash'?'cut':'done'))
    const cut=p.mode==='crash'?m:m.cutEvidence, index=cuts.indexOf(p.selected)
    const storage=path.join(dir,'sessions/native-context/context-output')
    const bodyLength=p.mode==='quota-commit'?1700000:p.mode==='quota-second'?1850000:262144, expected=literal(bodyLength)
    if(cut) {
      assert.deepEqual(cut.transitions.map(x=>x.cut),cuts.slice(0,index+1))
      for(const t of cut.transitions) {
        assert.equal(t.success,true)
        if(t.native==='rename') assert.equal(t.transaction,`${t.path}.${sha(t.text)}.pending`)
      }
      const bytes=Buffer.from(cut.baselineBase64,'base64')
      assert.deepEqual(bytes,fs.readFileSync(path.join(dir,'baseline.bin')))
      assert.deepEqual(JSON.parse(bytes),cut.baseline)
      assert.equal(cut.baseline.formatVersion,2); assert.equal(cut.baseline.tasks.length,1)
      assert.equal(cut.baseline.tasks[0].status,'running'); assert.equal(cut.baseline.tasks[0].outcome,undefined); assert.equal(cut.baseline.tasks[0].result,undefined)
      const op=operation(cut.files); assert.equal(op.owner.operationId,cut.operationId)
      assert.equal(op.owner.sessionId,parent); assert.equal(op.owner.documentId,taskDocument)
      pins(cut.files,index,op); checkInventory(cut.files)
      const raw=Object.entries(cut.files).find(([n])=>n.endsWith('/body'))[1]
      assert.equal(raw.bytes,expected.length); assert.equal(raw.sha256,sha(expected))
      assert.deepEqual(cut.authority,{registrations:1,begins:1,sameScope:true,sameSink:true,codec:'json-utf8-v1'})
    }
    for(const k of ['captures','resultTextReads','errorReads','sourceBindings']) assert.equal(m.count[k],1)
    if(p.mode==='crash') {
      const f=json(path.join(dir,'fresh.json')), phase=index<3?'capturing':index<7?'staged':'committed'
      assert.equal(operation(m.files).phase,phase); assert.equal(f.expectedPhase,phase)
      assert.equal(f.classification.kind,phase==='committed'?'committed':'recovery-required')
      if(phase==='committed') { assert.deepEqual(f.classification.ref,m.operation.ref); pages(f.body,expected) }
      assert.equal(f.producerOwnership,false); assert.deepEqual(f.inventory,m.files); checkInventory(f.inventory,storage)
      assert.deepEqual(f.restored,{tasks:m.baseline.tasks,notifications:m.baseline.notifications})
      assert.deepEqual(fs.readFileSync(path.join(dir,'sessions',taskDocument+'.doc.jsonl')),Buffer.from(m.baselineBase64,'base64'))
    } else {
      checkInventory(m.files,storage)
      assert.equal(m.task.outcome,'completed'); assert.equal(m.task.publication,undefined)
      if(p.mode==='live'||p.mode==='control') {
        assert.equal(m.task.retention,'durable'); assert.equal(m.task.result.envelope.retention.kind,'artifact')
        assert.equal(m.operation.phase,'committed'); assert.equal(m.task.result.revision,m.operation.owner.operationId)
        assert.deepEqual(m.ref,m.operation.ref); pins(m.files,9,m.operation); pages(m.body,expected)
        assert.deepEqual(m.task.result.envelope.execution,{outcome:'succeeded',dispatch:'dispatched'})
        assert.deepEqual(fs.readFileSync(path.join(storage,Object.keys(m.files).find(n=>n.endsWith('/body')))),expected)
      } else if(p.mode==='delete') {
        assert.equal(m.fresh.distinctService,true); assert.equal(m.fresh.producerOwnership,false)
        assert.equal(m.fresh.profileDisposition.kind,'rejected'); assert.equal(m.fresh.sourceDisposition.kind,'rejected')
        assert.deepEqual(m.fresh.receipt.manifest.documents,[taskDocument])
        assert.equal(Object.keys(m.files).filter(n=>n.includes('/pins/')||n.includes('/access/')).length,0)
      } else if(p.mode.startsWith('quota')) {
        assert.equal(m.task.retention,'failed')
        assert.deepEqual(m.task.result.envelope.retention,{kind:'unavailable',reason:'quota',observedEncodedBytes:expected.length})
        const refused=m.quotaCalls.filter(x=>x.error); assert.equal(refused.length,1)
        const q=refused[0]; assert.equal(q.error.code,'ARTIFACT_QUOTA'); assert(q.physical+q.growth>q.quota)
        for(const call of m.quotaCalls) { checkInventory(call.inventory); assert.equal(Object.values(call.inventory).reduce((n,r)=>n+r.bytes,0),call.physical) }
        assert(m.quotaCalls.slice(0,m.quotaCalls.indexOf(q)).every(x=>x.physical+x.growth<=x.quota))
        assert.equal(q.growth,p.mode==='quota-commit'?198688:262144)
        assert.equal(operation(q.inventory).phase,p.mode==='quota-commit'?'capturing':'committed')
        if(m.body) pages(m.body,expected)
      } else if(p.mode==='closure') assert.equal(m.componentOpen,false)
    }
    result.cases.push({directory:entry.directory,mode:p.mode,cut:p.selected,passed:true})
  }
  const commands=read('command-receipts.json').receipts, gates=fs.readFileSync(path.join(evidence,'gates.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(commands.length,15); assert.deepEqual(commands.map(x=>({gate:x.gate,exit:x.exit})),gates)
  for(const c of commands){assert(c.env.IH_CONFIG_DIR.startsWith('D:/I-harness-main/.tmp/'));assert.equal(c.nativeExitCheckedByPowerShell,true)}
  const log=n=>fs.readFileSync(path.join(evidence,n),'utf8').replace(/\x1b\[[0-9;]*m/g,'')
  assert(/28 passed/.test(log('gate-12-focused-seal-source.log')))
  assert(/24 passed/.test(log('gate-14-original-controls-exact.log')))
  assert.equal(commands[14].exit,0)
  result.gates={attempts:15,finalFocused:28,established:24,finalTypes:0,failuresPreserved:gates.filter(x=>x.exit!==0)}
  assert.equal(git('rev-parse','HEAD'),head); assert.equal(git('status','--porcelain'),'')
} catch(error) { result.failures.push({message:error.message,stack:error.stack}) }
fs.writeFileSync(path.join(work,'root-evidence-audit-v2.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({...result,cases:{count:result.cases.length}},null,2))
if(result.failures.length)process.exitCode=1
