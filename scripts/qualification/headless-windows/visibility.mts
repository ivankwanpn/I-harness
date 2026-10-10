import assert from "node:assert/strict"
import {createRequire} from "node:module"
import {pathToFileURL} from "node:url"
import {mkdirSync,writeFileSync} from "node:fs"
import {join} from "node:path"
const [fixture,repo]=process.argv.slice(2)
const load=(name:string)=>import(pathToFileURL(createRequire(join(repo!,"packages",name.split("/")[1]!,"package.json")).resolve(name)).href)
const {createExecService}=await load("@i-harness/exec")
const {createLocalExecutionBackends}=await load("@i-harness/sandbox-local")
const {compileExecutionPolicy,assertExecutionAuthority}=await load("@i-harness/sandbox-policy")
process.env.TEMP=fixture;process.env.TMP=fixture
const workspace=join(fixture!,"workspace"),scratch=join(fixture!,"private-temp");mkdirSync(workspace);mkdirSync(scratch)
const kof=createRequire(join(repo!,"packages/sandbox-windows-acl/package.json")).resolve("koffi")
const script=join(workspace,"console.cjs")
writeFileSync(script,`const k=require(${JSON.stringify(kof)});const lib=k.load('kernel32.dll');const get=lib.func('uintptr_t __stdcall GetConsoleWindow()');console.log('HANDLE_JSON:'+JSON.stringify({pid:process.pid,hwnd:String(get())}));setTimeout(()=>process.exit(0),2000)`)
const backends=createLocalExecutionBackends({windowsSelection:"legacy",legacyPrivateTempRoot:scratch})
const authority={kind:"unbound",revision:"visibility",workspaceRoot:workspace}
const exec=createExecService({execution:{defaultOwner:{sessionId:"visibility"},resolvePolicy:(owner:any,p:any)=>compileExecutionPolicy({owner,mode:p?.mode??"danger-full-access",authority}),validateAuthority:(p:any)=>assertExecutionAuthority(p,compileExecutionPolicy({owner:p.owner,mode:p.mode,authority})),selectBackend:(p:any,t:any)=>backends.select(p,t),dispose:()=>backends.dispose()}})
const records:any[]=[]
try {
  for(const [label,command,transport,mode] of [
    ["legacy-pipe-node","C:/Program Files/nodejs/node.exe","pipe","read-only"],
  ]) {
    const launched=await exec.launchTransport({argv:[command,script],cwd:workspace,transport,lifetime:transport==="pty"?"retain-tree":"complete-tree",argumentEncoding:"crt",...(transport==="pty"?{pty:{cols:80,rows:24}}:{}),sandbox:{mode,workspaceRoot:workspace}})
    let output="";const drain=(async()=>{for await(const frame of launched.handle.io.output)output+=Buffer.from(frame.data).toString()})()
    const root=await launched.handle.rootExited;const settlement=await launched.handle.settled;await drain
    const match=/HANDLE_JSON:(\{[^}]+\})/.exec(output);assert.ok(match,output);assert.equal(root.exitCode,0)
    records.push({label,transport,ownerPid:launched.handle.pid,...JSON.parse(match[1]!),receipt:launched.handle.receipt,root,settlement})
    writeFileSync(join(fixture!,"console-handles.json"),JSON.stringify(records,null,2))
  }
}finally{await exec.dispose()}
