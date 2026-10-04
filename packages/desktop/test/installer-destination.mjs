// Native Windows regressions for destination permissions. Every write, ACL
// change and file-only installation is confined to this owned repository root.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {dirname,join,relative,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {buildInstaller,testMarker,testOwner} from '../scripts/build-installer.mjs'
import {createInstallerFixture} from './installer-fixture.mjs'

assert.equal(process.platform,'win32')
const arg=name=>process.argv[process.argv.indexOf(name)+1]
const source=arg('--app-dir'),nsis=arg('--nsis')
assert(source&&nsis,'requires --app-dir and --nsis')
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
const token=randomUUID(),root=join(repo,'.tmp',`desktop-installer-destination-${token}`)
mkdirSync(root,{recursive:true})
writeFileSync(join(root,testMarker),`[Test]\nOwner=${testOwner}\nToken=${token}\n`)
function owned(path){
  const rel=relative(root,resolve(path))
  assert(rel&&!rel.startsWith('..')&&!resolve(path).startsWith('\\\\'))
  assert(readFileSync(join(root,testMarker),'utf8').includes(`Token=${token}`))
}
function run(file,args,extra={}){
  const result=spawnSync(file,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000,...extra})
  if(result.error)throw result.error
  return result
}
const who=run('whoami.exe',['/user','/fo','csv','/nh'])
assert.equal(who.status,0)
const sid=who.stdout.match(/S-1-5-21-\d+-\d+-\d+-\d+/)?.[0]
assert(sid,'requires a normal Windows user SID')
const fixture=createInstallerFixture(source,join(root,'payload'))
const metadata=buildInstaller({appDir:fixture,nsis,outDir:join(root,'setup'),testRoot:root})
const production=buildInstaller({appDir:fixture,nsis,outDir:join(root,'production')})
assert(readFileSync(metadata.output).includes(Buffer.from('level="asInvoker"')),'isolated setup must never request elevation')
assert(readFileSync(production.output).includes(Buffer.from('level="highestAvailable"')),'production setup must request available administrator permission')
const blocked=join(root,'blocked-parent'),target=join(blocked,'I-harness Desktop')
owned(blocked);mkdirSync(blocked)
const evidence={root,installer:metadata.output,checks:['production manifest requests highestAvailable; file-only fixture remains asInvoker']}
let denied=false
try{
  const acl=run('icacls.exe',[blocked,'/deny',`*${sid}:(OI)(CI)(W)`])
  assert.equal(acl.status,0,acl.stderr);denied=true
  const result=run(metadata.output,['/S',`/D=${target}`],{windowsVerbatimArguments:true})
  assert.notEqual(result.status,0,'protected destination must not install')
  assert(!existsSync(join(target,'I-harness Desktop.exe')))
  assert(!existsSync(join(target,'.i-harness-desktop-install.ini')))
  const diagnostic=readFileSync(join(root,'last-failure.txt'),'utf8')
  evidence.blocked={exitCode:result.status,diagnostic}
  writeFileSync(join(root,'evidence.json'),JSON.stringify(evidence,null,2)+'\n')
  assert.match(diagnostic,/installation folder is not writable/i,'destination permissions must be checked before recovery/bootstrap')
  assert.match(diagnostic,/LocalAppData|LOCALAPPDATA/,'diagnostic must identify the working per-user destination')
  evidence.checks.push('unwritable destination rejected before bootstrap with actionable location')
}finally{
  if(denied){owned(blocked);const restored=run('icacls.exe',[blocked,'/remove:d',`*${sid}`]);assert.equal(restored.status,0,restored.stderr)}
}
const writable=join(root,'writable','I-harness Desktop');owned(writable)
const installed=run(metadata.output,['/S',`/D=${writable}`],{windowsVerbatimArguments:true})
assert.equal(installed.status,0,existsSync(join(root,'last-failure.txt'))?readFileSync(join(root,'last-failure.txt'),'utf8'):'install failed')
assert(existsSync(join(writable,'I-harness Desktop.exe')))
evidence.checks.push('fresh writable destination installs normally without elevation')
const replaced=join(root,'replacement-uninstall.exe'),executed=join(root,'replacement-executed.txt')
const replacementScript=join(root,'replacement.nsi')
writeFileSync(replacementScript,`Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${replaced}"\nSection\nFileOpen $0 "${executed}" w\nFileWrite $0 "executed"\nFileClose $0\nSetErrorLevel 0\nSectionEnd\n`)
const replacementCompile=run(nsis,['/NOCONFIG','/V1',replacementScript])
assert.equal(replacementCompile.status,0,replacementCompile.stderr)
copyFileSync(replaced,join(writable,'Uninstall.exe'))
const priorMarker=readFileSync(join(writable,'.i-harness-desktop-install.ini'))
writeFileSync(join(root,'test-controls.ini'),'[Controls]\nSimulateElevatedUpgrade=1\n')
const upgraded=run(metadata.output,['/S',`/D=${writable}`],{windowsVerbatimArguments:true})
assert.notEqual(upgraded.status,0)
assert(!existsSync(executed),'elevated setup must not execute an unauthenticated prior uninstaller')
assert.deepEqual(readFileSync(join(writable,'.i-harness-desktop-install.ini')),priorMarker,'refused elevation must not mutate the old ownership marker')
assert.match(readFileSync(join(root,'last-failure.txt'),'utf8'),/uninstall.*before|before.*uninstall/i)
writeFileSync(join(root,'test-controls.ini'),'[Controls]\n')
evidence.checks.push('elevated setup refuses replaced prior uninstaller before execution or marker mutation')
const unowned=join(root,'unowned','I-harness Desktop');owned(unowned);mkdirSync(unowned,{recursive:true})
writeFileSync(join(unowned,'keep.txt'),'unrelated user file')
assert.notEqual(run(metadata.output,['/S',`/D=${unowned}`],{windowsVerbatimArguments:true}).status,0)
assert.equal(readFileSync(join(unowned,'keep.txt'),'utf8'),'unrelated user file')
assert.deepEqual((await import('node:fs')).readdirSync(unowned),['keep.txt'],'permission preflight must not create probe files in an unowned folder')
evidence.checks.push('permission preflight leaves nonempty unowned folders unchanged')
writeFileSync(join(root,'evidence.json'),JSON.stringify(evidence,null,2)+'\n')
console.log(JSON.stringify(evidence,null,2))
