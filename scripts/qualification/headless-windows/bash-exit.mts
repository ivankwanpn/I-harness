import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { resolve, join } from "node:path"
import { writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
const repo=resolve(import.meta.dirname,"../../..")
const load=(name:string)=>import(pathToFileURL(createRequire(join(repo,"packages",name.split("/")[1]!,"package.json")).resolve(name)).href)
const {createExecService}=await load("@i-harness/exec")
const {createLocalExecutionBackends}=await load("@i-harness/sandbox-local")
const {compileExecutionPolicy,assertExecutionAuthority}=await load("@i-harness/sandbox-policy")
const fixture=join(repo,".tmp/sandbox-redesign-headless-acceptance-b"),workspace=join(fixture,"source")
process.env.TEMP=fixture;process.env.TMP=fixture;process.env.IH_CONFIG_DIR=join(fixture,"config")
const authority={kind:"unbound",revision:"gui-probe",workspaceRoot:workspace}
const backends=createLocalExecutionBackends({windowsSelection:"legacy",legacyPrivateTempRoot:join(fixture,"source-private-temp")})
const policy=compileExecutionPolicy({owner:{sessionId:"standalone-exec"},mode:"read-only",authority})
const capability=await backends.select(policy,"pipe").probe()
const exec=createExecService({execution:{defaultOwner:policy.owner,resolvePolicy:()=>policy,validateAuthority:(p:any)=>assertExecutionAuthority(p,policy),selectBackend:(p:any,t:any)=>backends.select(p,t),dispose:()=>backends.dispose()}})
const result:any={environmentDigest:createHash("sha256").update(JSON.stringify(Object.entries(process.env).sort())).digest("hex"),capability}
try {
  const launched=await exec.launchTransport({argv:["C:/Program Files/Git/bin/bash.exe","--noprofile","--norc","-c","printf BASH_OK"],cwd:workspace,transport:"pipe",lifetime:"complete-tree",argumentEncoding:"crt",sandbox:{mode:"read-only",workspaceRoot:workspace}})
  const stdout:Buffer[]=[],stderr:Buffer[]=[]
  const drain=(async()=>{for await(const frame of launched.handle.io.output)(frame.channel==="stderr"?stderr:stdout).push(Buffer.from(frame.data))})()
  result.root=await launched.handle.rootExited;result.settlement=await launched.handle.settled;await drain
  result.stdout=Buffer.concat(stdout).toString();result.stderr=Buffer.concat(stderr).toString();result.receipt=launched.handle.receipt
}finally{await exec.dispose();result.disposed=true;writeFileSync(join(fixture,"bash-exit-result.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result))}
