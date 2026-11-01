import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWin32ArtifactPathOwner } from '../../src/win32-artifact-path.ts'
import { win32ArtifactApi } from '../../src/win32-artifact-api.ts'

type Owner = ReturnType<typeof createWin32ArtifactPathOwner>
type Handle = { value?: bigint; state: 'unknown' | 'open' | 'closed' }
type Case = { name: string; status: 'passed' | 'unqualified'; detail: unknown }
const invalid = (p: unknown) => typeof p !== 'bigint' || p <= 0n || p >= 0xffffffffffffffffn
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
/** Opt-in native fixture only. No helper API substitution, child process or build. */
export async function qualifyWindowsArtifactMetadata() {
  check(process.platform === 'win32', 'Windows required')
  const assigned = resolve(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? '')
  check(/^D:\\ihq\\[a-f0-9]{32}\\5$/i.test(assigned), 'Exact fresh runner native root required')
  const assignedReal = realpathSync(assigned), fixture = mkdtempSync(join(assigned, 'artifact-metadata-'))
  const tracePath = join(assigned, 'artifact-metadata-qualification.json')
  const cases: Case[] = [], calls: unknown[] = [], handles: Handle[] = [], owners: Owner[] = []
  const report = { fixture, assigned, node: process.version, arch: process.arch, platform: process.platform, koffi: '', main:undefined as unknown, cases, calls, cleanup: { complete: false, errors: [] as unknown[] } }
  const save = () => writeFileSync(tracePath, JSON.stringify(report, (_key, v) => typeof v === 'bigint' ? `${v}n` : v instanceof Error ? { name: v.name, message: v.message, cause: v.cause } : v, 2))
  save()
  function call<T>(name: string, args: unknown, invoke: () => T, acknowledge?: (result: T) => void): T {
    const row = { name, args, state: 'issued', result: undefined as unknown }; calls.push(row); save()
    try { const result = invoke(); acknowledge?.(result); row.state = 'returned'; row.result = result; save(); return result }
    catch (cause) { row.state = 'threw'; row.result = cause; save(); throw cause }
  }
  const passed = (name: string, detail: unknown) => { cases.push({ name, status: 'passed', detail }); save() }
  const unqualified = (name: string, detail: unknown) => { cases.push({ name, status: 'unqualified', detail }); save() }
  const own = (root: string) => { const owner = createWin32ArtifactPathOwner(root); owners.push(owner); return owner }
  const key = (owner: Owner, path: string) => { const c = owner.capture(path); check(c.kind === 'ready', `Expected ready ${path}`); c.assertCurrent(); return c.key }
  const refuses = (invoke: () => unknown, expected: string) => { let failure: unknown; try { invoke() } catch(e) { failure=e } check(failure instanceof Error&&failure.message.includes(expected), `Expected specific refusal ${expected}; got ${String(failure)}`) }
  let koffi: typeof import('koffi'), api: ReturnType<typeof win32ArtifactApi>
  let setInfo: (h: bigint, cls: number, data: Buffer, bytes: number) => number
  let compare: (a: string, na: number, b: string, nb: number, ignore: number) => number
  let shortName: (path: string, data: Buffer, units: number) => number
  function close(h: Handle) {
    if (h.state === 'closed') return
    check(h.state === 'open' && h.value !== undefined, 'Unknown original fixture handle remains pinned')
    h.state = 'unknown'
    const r = call('CloseHandle', h.value, () => api.closeHandle(h.value!), r => { if(r===0)h.state='open';else if(Number.isInteger(r)&&r>=-0x80000000&&r<=0x7fffffff)h.state='closed' })
    if (r === 0) { h.state = 'open'; const code = api.getLastError(); throw new Error(`CloseHandle known refusal ${code}`) }
    check(Number.isInteger(r) && r >= -0x80000000 && r <= 0x7fffffff, 'Unknown CloseHandle ACK')
    h.state = 'closed'
  }
  function directory<T>(path: string, write: boolean, action: (h: bigint) => T): T {
    const h: Handle = { state: 'unknown' }; handles.push(h)
    const value = call('CreateFileW', { path, access: write ? 0x180 : 0x80, share: 7, disposition: 3, flags: 0x02200000 }, () => api.createFileW(path, write ? 0x180 : 0x80, 7, null, 3, 0x02200000, null), p => { if(p===null||p===0n||p===-1n||p===0xffffffffffffffffn)h.state='closed';else if(!invalid(p)){h.value=p!;h.state='open'} })
    if (value === null || value === 0n || value === -1n || value === 0xffffffffffffffffn) { h.state = 'closed'; const code = api.getLastError(); throw new Error(`CreateFileW ${code}`) }
    check(!invalid(value), 'Unknown fixture open ACK'); h.value = value!; h.state = 'open'
    let result: T, primary: unknown, failed = false
    try { result = action(value!) } catch (e) { failed = true; primary = e }
    try { close(h) } catch (cleanup) { if (failed) throw new AggregateError([primary, cleanup], 'Fixture action/close incomplete', { cause: primary }); throw cleanup }
    if (failed) throw primary
    return result!
  }
  function metadata(path: string) {
    return directory(path, false, h => {
      const query = (cls: number, size: number) => { const data = Buffer.alloc(size); const r = call('GetFileInformationByHandleEx', { h, cls, size }, () => api.getFileInformationByHandleEx(h, cls, data, size)); if (r === 0) throw new Error(`GetFileInformationByHandleEx ${api.getLastError()}`); check(Number.isInteger(r) && r >= -0x80000000 && r <= 0x7fffffff, 'Unknown metadata BOOL'); return data }
      const attributes = query(9, 8).readUInt32LE(), id = query(18, 24), flags = query(23, 4).readUInt32LE()
      check((attributes & 0x10) !== 0 && (attributes & 0x400) === 0, 'Expected original fixture directory')
      check(flags === 0 || flags === 1, 'Unsupported fixture directory policy')
      return { volume: id.subarray(0, 8).toString('hex'), id: id.subarray(8, 24).toString('hex'), flags }
    })
  }
  function policy(path: string, flags: 0 | 1): boolean {
    const actual = metadata(path)
    if (actual.flags === flags) return true
    // All policy writes target newly created EMPTY fixture directories only.
    check(resolve(path).startsWith(resolve(fixture) + sep) || resolve(path) === resolve(fixture), 'Policy target outside fixture')
    check(!lstatSync(path).isSymbolicLink() && readdirSync(path).length === 0, 'Policy target is not an original empty fixture directory')
    const result = directory(path, true, h => { const data = Buffer.alloc(4); data.writeUInt32LE(flags); const r = call('SetFileInformationByHandle', { path, h, cls: 23, size: 4, flags }, () => setInfo(h, 23, data, 4)); if (r === 0) return { ok: false, code: api.getLastError() }; check(Number.isInteger(r) && r >= -0x80000000 && r <= 0x7fffffff, 'Unknown policy BOOL'); return { ok: true, code: 0 } })
    if (!result.ok) { check([5, 50, 87, 1314].includes(result.code), `Unexpected case-policy error ${result.code}`); unqualified(`policy-${flags}`, { path, code: result.code }); return false }
    check(metadata(path).flags === flags, 'Policy setter returned success without observed policy'); return true
  }
  let failure: unknown, failed = false
  try {
    const mainManifestPath='D:/I-harness-main/.superpowers/sdd/2026-10-29-task-documents-next/canonical-windows-qualification-main-before-20261031.json'
    const mainManifestBytes=readFileSync(mainManifestPath),mainManifest=JSON.parse(mainManifestBytes.toString('utf8')) as {head:string;scope:string;files:Array<{path:string;sha256:string}>}
    check(mainManifest.head==='ada86d57e0b9c3bc0a4fd5a31559d7910888b6da','Wrong frozen MAIN manifest')
    for(const file of mainManifest.files){check(file.path.startsWith('D:/I-harness-main/packages/'),'MAIN scope escaped');check(createHash('sha256').update(readFileSync(file.path)).digest('hex')===file.sha256,'Frozen MAIN source changed')}
    report.main={head:mainManifest.head,scope:mainManifest.scope,count:mainManifest.files.length,manifestSha256:createHash('sha256').update(mainManifestBytes).digest('hex')};save()
    const mainEntry='D:/I-harness-main/packages/session-persistence-jsonl/src/index.ts'
    const actualBackend=await import(/* @vite-ignore */pathToFileURL(mainEntry).href)
    check(typeof actualBackend.createJsonlBackend==='function','Original frozen MAIN backend unavailable')
    const backends=new Map<string,ReturnType<typeof actualBackend.createJsonlBackend>>()
    const backend=(root:string)=>{let value=backends.get(root);if(!value){value=actualBackend.createJsonlBackend(root);backends.set(root,value)}return value}
    const put=async(root:string,id:string,data:unknown)=>{await backend(root).putDocument(id,data);check(JSON.stringify(await backend(root).getDocument(id))===JSON.stringify(data),'Original backend put/get mismatch')}
  const req = createRequire(import.meta.url)
  // Loading/binding occurs only after opt-in inside the owned runner fixture.
  koffi = req('koffi')
  report.koffi = String((koffi as unknown as { version: string }).version)
  api = win32ArtifactApi(); const kernel = koffi.load('kernel32.dll')
  setInfo = kernel.func('int __stdcall SetFileInformationByHandle(void *, int, void *, uint32_t)') as (h: bigint, cls: number, data: Buffer, bytes: number) => number
  compare = kernel.func('int __stdcall CompareStringOrdinal(str16, int, str16, int, int)') as (a: string, na: number, b: string, nb: number, ignore: number) => number
  shortName = kernel.func('uint32_t __stdcall GetShortPathNameW(str16, void *, uint32_t)') as (path: string, data: Buffer, units: number) => number
    check(process.arch === 'x64' && koffi.sizeof('void *') === 8, 'Reviewed Windows x64 ABI required')
    check(report.koffi === '3.1.6', `Expected reviewed Koffi3.1.6, got ${report.koffi}`)
    const rootInsensitive = policy(fixture, 0)
    if (!rootInsensitive) unqualified('insensitive-matrix', 'Fixture root cannot be made insensitive')
    else {
      const base = join(fixture, 'Insensitive Long Directory'); mkdirSync(base); check(policy(base, 0), 'Expected fresh insensitive base')
      const owner = own(base), info = metadata(base), lower = join(base,'name.doc.jsonl'), upper = join(base,'NAME.doc.jsonl')
      const original = key(owner, lower); check(original.includes(`${info.volume}:${info.id}:I:`), 'Actual ID/policy not in helper key'); check(original === key(owner, upper), 'Insensitive absent-leaf aliases differ')
      await put(base,'name',{owned:1});check(readdirSync(base).includes('name.doc.jsonl'),'Original publication suffix differs');check(JSON.stringify(await backend(base).getDocument('NAME'))===JSON.stringify({owned:1}),'Original backend case alias read failed');check(readFileSync(upper,'utf8')===readFileSync(lower,'utf8'),'Actual case alias Node read failed'); check(key(owner, lower) === original, 'Existing artifact changed directory resource')
      await put(base,'name',{owned:2});check(key(owner,lower)===original,'Original backend replacement changed resource')
      passed('real-ids-insensitive-absent-and-published', { info, lower, upper, key: original })
      for (const [a, b] of [['é','É'],['σ','Σ'],['a','A'],['漢','漢'],['😀','😀'],['a\u0301','Á']]) {
        const r = call('CompareStringOrdinal', { a, b, aUnits: a!.length, bUnits: b!.length, ignoreCase: 1 }, () => compare(a!, a!.length, b!, b!.length, 1)); if (r === 0) throw new Error(`CompareStringOrdinal ${api.getLastError()}`); check(r === 1 || r === 2 || r === 3, 'Invalid ordinal result')
        const pa = join(base,`unicode-${a}.doc.jsonl`), pb = join(base,`unicode-${b}.doc.jsonl`), ka = key(owner, pa), kb = key(owner, pb); check((ka === kb) === (r === 2), 'Helper/ordinal Unicode equivalence differs')
        await put(base,`unicode-${a}`,{a});check(readdirSync(base).includes(`unicode-${a}.doc.jsonl`),'Original Unicode publication name differs'); if (r === 2) check(readFileSync(pb,'utf8') === readFileSync(pa,'utf8'), 'Unicode equivalent Node publication differs'); else { await put(base,`unicode-${b}`,{b}); check(readFileSync(pa,'utf8') !== readFileSync(pb,'utf8'), 'Distinct Unicode publications merged') }
        passed('unicode-native-ordinal', { a, b, ordinal: r, sameKey: ka === kb, pa, pb })
      }
      const nested = join(base,'nested','internal..doc.jsonl'), pending = owner.capture(nested); check(pending.kind === 'needs-parents', 'Expected provisional nested parent'); pending.assertCurrent(); await put(base,'nested/internal.',{nested:1});check(readdirSync(join(base,'nested')).includes('internal..doc.jsonl'),'Original nested internal-dot publication differs'); check(metadata(join(base,'nested')).flags === 0, 'New actual policy unexpected'); const nestedKey = key(owner,nested); check(JSON.parse(readFileSync(nested,'utf8')).nested===1,'Original nested publication unreadable'); check(key(owner,nested) === nestedKey, 'Publication changed nested key'); passed('original-node-suffix-internal-dot-nested', { nested, nestedKey })
      const host = join(base,'stream-host'); writeFileSync(host,'owned'); const stream = join(base,'stream-host:alternate.doc.jsonl'); let streamPublished=false; try { await put(base,'stream-host:alternate',{stream:1});check(JSON.parse(readFileSync(stream,'utf8')).stream===1,'Owned original ADS readback failed'); streamPublished=true } catch (e) { if (typeof (e as NodeJS.ErrnoException).code==='string') unqualified('original-node-colon-publication',{code:(e as NodeJS.ErrnoException).code}); else throw e }; if(streamPublished){key(owner,stream);passed('original-node-colon-publication',{stream})}
      const shortBuffer = Buffer.alloc(32768*2), count = call('GetShortPathNameW',{base,units:32768},()=>shortName(base,shortBuffer,32768)); if (count === 0) unqualified('8dot3-ancestor',{code:api.getLastError()}); else { check(Number.isInteger(count)&&count>0&&count<32768,'Invalid short-path length'); check(shortBuffer.readUInt16LE(count*2)===0,'Short path lacks NUL'); const short = shortBuffer.toString('utf16le',0,count*2); if (short.toLowerCase()===base.toLowerCase()) unqualified('8dot3-ancestor',{reason:'No distinct short ancestor alias available',short}); else { check(key(owner,join(short,'name.doc.jsonl'))===original,'Short ancestor not canonical'); passed('8dot3-ancestor',{base,short}) } }
      const junction = join(base,'owned-junction'), target = join(fixture,'junction-target'); mkdirSync(target); try { symlinkSync(target,junction,'junction') } catch(e) { const code=(e as NodeJS.ErrnoException).code; check(code==='EPERM'||code==='EACCES'||code==='ENOTSUP','Unexpected junction failure'); unqualified('owned-reparse-junction',{code}) }
      if (existsSync(junction)) { refuses(()=>owner.capture(join(junction,'x.doc.jsonl')),'non-reparse directory'); passed('owned-reparse-junction',{junction,target}) }
      const missingRoot = join(fixture,'MissingRoot'), mrOwner = own(missingRoot), originalTarget = join(fixture,'MISSINGROOT','absent.doc.jsonl'), need = mrOwner.capture(originalTarget); check(need.kind==='needs-root'&&need.preparation.path===missingRoot,'Expected original root-only preparation'); need.assertCurrent(); mkdirSync(need.preparation.path); refuses(()=>need.assertCurrent(),'Original artifact path changed'); key(mrOwner,originalTarget); passed('root-only-preparation-recapture',{missingRoot,originalTarget})
    }
    const sensitive = join(fixture,'Sensitive'); mkdirSync(sensitive)
    if (policy(sensitive,1)) {
      const owner = own(sensitive), info = metadata(sensitive), a = join(sensitive,'Foo.doc.jsonl'), b = join(sensitive,'foo.doc.jsonl'); check(key(owner,a)!==key(owner,b),'Sensitive keys merged'); await put(sensitive,'Foo',{case:'upper'});await put(sensitive,'foo',{case:'lower'});check(JSON.parse(readFileSync(a,'utf8')).case==='upper'&&JSON.parse(readFileSync(b,'utf8')).case==='lower','Sensitive original artifacts merged'); passed('sensitive-artifacts',{info,a,b})
      const left = join(sensitive,'Branch'), right = join(sensitive,'branch'); mkdirSync(left);mkdirSync(right);const lc=join(left,'child'),rc=join(right,'child');mkdirSync(lc);mkdirSync(rc)
      if (policy(lc,0)&&policy(rc,0)) { const l=key(owner,join(lc,'x.doc.jsonl')),r=key(owner,join(rc,'x.doc.jsonl'));check(l!==r,'Mixed sibling anchors merged');check(l===key(owner,join(lc,'X.doc.jsonl')),'Insensitive mixed leaf aliases differ');await put(lc,'x',{side:'left'});await put(rc,'x',{side:'right'});check(JSON.parse(readFileSync(join(lc,'X.doc.jsonl'),'utf8')).side==='left'&&JSON.parse(readFileSync(join(rc,'X.doc.jsonl'),'utf8')).side==='right','Mixed original artifacts merged');passed('mixed-sensitive-ancestor-insensitive-child',{left:metadata(lc),right:metadata(rc)}) } else unqualified('mixed-sensitive-ancestor-insensitive-child','Could not establish both child policies')
      const empty = join(sensitive,'PolicyFlip');mkdirSync(empty);if(policy(empty,0)){const cap=owner.capture(join(empty,'absent.doc.jsonl'));check(cap.kind==='ready','Expected policy-flip ready');if(policy(empty,1)){refuses(()=>cap.assertCurrent(),'Original artifact path changed');passed('same-id-policy-flip',{empty})}else unqualified('same-id-policy-flip','Set policy1 refused')}
    } else { unqualified('sensitive-artifacts','Set policy1 unavailable');unqualified('mixed-sensitive-ancestor-insensitive-child','Sensitive parent unavailable') }
    const current = join(fixture,'CurrentRoot'), held=join(fixture,'CurrentRoot-held');mkdirSync(current);const rootOwner=own(current),cap=rootOwner.capture(join(current,'absent.doc.jsonl')),before=metadata(current);renameSync(current,held);mkdirSync(current);const after=metadata(current);check(before.id!==after.id||before.volume!==after.volume,'Replacement unexpectedly reused identity');refuses(()=>cap.assertCurrent(),'Original artifact root changed');refuses(()=>rootOwner.capture(join(current,'absent.doc.jsonl')),'Original artifact root changed');passed('root-replacement-currentness',{before,after})
  } catch(e) { failed=true;failure=e;calls.push({fixtureFailure:e});save() }
  // Join only original owners/handles. Unknown consume stays pinned; no new owner
  // or handle replacement is introduced to manufacture cleanup success.
  for(const owner of owners)try{owner.settleResources()}catch(e){report.cleanup.errors.push(e)}
  for(const handle of handles)try{close(handle)}catch(e){report.cleanup.errors.push(e)}
  if(!report.cleanup.errors.length) {
    try {
      const actual=realpathSync(fixture);check(!lstatSync(fixture).isSymbolicLink(),'Cleanup root became reparse');check(actual.startsWith(assignedReal+sep)&&actual!==assignedReal,'Recursive cleanup escaped exact assigned root');rmSync(actual,{recursive:true});report.cleanup.complete=true
    }catch(e){report.cleanup.errors.push(e)}
  }
  save()
  if(failed)throw new AggregateError([failure,...report.cleanup.errors],`Windows metadata qualification failed; evidence ${tracePath}`,{cause:failure})
  check(report.cleanup.complete,`Original fixture cleanup incomplete; evidence ${tracePath}`)
  return { tracePath, report }
}
