import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
const [fixture, repo] = process.argv.slice(2)
if (!fixture || !repo) throw new Error("fixture and repo required")
process.env.TEMP=fixture; process.env.TMP=fixture; process.env.IH_CONFIG_DIR=join(fixture,"config")
const node = "C:/Program Files/nodejs/node.exe"
const desktop = join(repo,"packages/desktop/release-sandbox-task5/I-harness Desktop")
const records: unknown[]=[]
const record = (value: unknown) => { records.push(value); writeFileSync(join(fixture,"workload-results.json"),JSON.stringify(records,null,2)) }
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function wait(fn:()=>boolean) { const end=Date.now()+20000; while(!fn() && Date.now()<end) await sleep(10); assert.ok(fn(),"bounded workload observation") }
for (const profile of ["source","packaged-desktop"]) {
  const base=profile==="source"?join(repo,"packages/session-executor"):join(desktop,"resources/gateway/node_modules/@i-harness/session-executor")
  const req=createRequire(join(base,"package.json"))
  const load=(name:string)=>import(pathToFileURL((profile==="source"?createRequire(join(repo,"packages",name.split("/")[1]!,"package.json")):req).resolve(name)).href)
  const {createExecService}=await load("@i-harness/exec")
  const {createLocalExecutionBackends}=await load("@i-harness/sandbox-local")
  const {compileExecutionPolicy,assertExecutionAuthority}=await load("@i-harness/sandbox-policy")
  const {createTerminalService}=await load("@i-harness/terminal")
  const workspace=join(fixture,profile);mkdirSync(workspace,{recursive:true})
  const privateTempRoot=join(fixture,profile+"-private-temp");mkdirSync(privateTempRoot,{recursive:true})
  const backends=createLocalExecutionBackends({windowsSelection:"legacy",legacyPrivateTempRoot:privateTempRoot})
  const authority={kind:"unbound",revision:"gui-probe",workspaceRoot:workspace}
  const exec=createExecService({execution:{defaultOwner:{sessionId:"standalone-exec"},
    resolvePolicy:(owner:any,requested:any)=>compileExecutionPolicy({owner,mode:requested?.mode??"danger-full-access",authority}),
    validateAuthority:(policy:any)=>assertExecutionAuthority(policy,compileExecutionPolicy({owner:policy.owner,mode:policy.mode,authority})),
    selectBackend:(policy:any,transport:any)=>backends.select(policy,transport),dispose:()=>backends.dispose()}})
  try {
    const cmd=join(process.env.SystemRoot!,"System32/cmd.exe")
    const pwsh=join(process.env.SystemRoot!,"System32/WindowsPowerShell/v1.0/powershell.exe")
    for (const [name,argv] of [
      ["node",[node,"-e","console.log('NODE_OK')"]],
      ["nested-cmd",[cmd,"/d","/s","/c",'cmd /d /c echo CMD_OK']],
      ["powershell",[pwsh,"-NoProfile","-NonInteractive","-Command","Write-Output PWSH_OK"]],
    ] as [string,string[]][]) {
      const r=await exec.run({argv,cwd:workspace}); assert.equal(r.exitCode,0); assert.match(r.stdout,/_OK/);record({profile,name,exit:r.exitCode})
    }
    const chunks:Buffer[]=[]
    const r=await exec.run({argv:[node,"-e","process.stdin.on('data',b=>process.stdout.write(b))"],inputBytes:new Uint8Array([0,1,2,127,128,255]),cwd:workspace},{stream:{maxBytes:1024,onStdout:(b:Buffer)=>{chunks.push(b)}}})
    assert.equal(r.exitCode,0);assert.deepEqual([...Buffer.concat(chunks)],[0,1,2,127,128,255]);record({profile,name:"binary-stream",exit:r.exitCode})
    const count=join(workspace,"spawn-count")
    const script=`require('fs').appendFileSync(${JSON.stringify(count)},'one');console.log('PROMOTION_READY');setTimeout(()=>console.log('PROMOTION_DONE'),700)`
    const promoted=await exec.run({argv:[node,"-e",script],cwd:workspace},{backgroundAfterMs:20});assert.equal(promoted.promoted,true)
    await wait(()=>exec.getOutput(promoted.jobId).status!=="running");const view=exec.getOutput(promoted.jobId)
    assert.equal(readFileSync(count,"utf8"),"one");assert.match(view.stdout,/PROMOTION_READY/);assert.match(view.stdout,/PROMOTION_DONE/);assert.equal(view.settlement.kind,"settled");record({profile,name:"promotion-one-spawn",settlement:view.settlement})
    const bg=await exec.runBackground({argv:[node,"-e","console.log('BG_READY');setInterval(()=>{},1000)"],cwd:workspace});await wait(()=>exec.getOutput(bg.jobId).stdout.includes("BG_READY"));await exec.killJob(bg.jobId);record({profile,name:"background-cancel",settlement:exec.getOutput(bg.jobId).settlement})
    const readonly={mode:"read-only",workspaceRoot:workspace}
    const denied=join(workspace,"denied")
    const rr=await exec.run({argv:[node,"-e",`try{require('fs').writeFileSync(${JSON.stringify(denied)},'bad');process.exit(4)}catch{console.log('DENIED_OK')}`],cwd:workspace,sandbox:readonly});assert.equal(rr.exitCode,0);assert.equal(existsSync(denied),false);record({profile,name:"legacy-readonly",exit:rr.exitCode})
    const written=join(workspace,"written")
    const ww=await exec.run({argv:[node,"-e",`require('fs').writeFileSync(${JSON.stringify(written)},'WORKSPACE_OK')`],cwd:workspace,sandbox:{mode:"workspace-write",workspaceRoot:workspace}});assert.equal(ww.exitCode,0);assert.equal(readFileSync(written,"utf8"),"WORKSPACE_OK");record({profile,name:"legacy-workspace-write",exit:ww.exitCode})
    const {resolveShell}=await load("@i-harness/shell"); const selected=resolveShell();record({profile,name:"automatic-shell",selected:selected.name,executable:selected.argv[0]})
    record({profile,name:"legacy-bash",success:false,priorEvidence:"sandbox-redesign-headless-acceptance-b",detail:"MSYS signal pipe creation failed with Win32 error 5; no repeated confined Bash launch"})
    const bash=await exec.run({argv:["C:/Program Files/Git/bin/bash.exe","--noprofile","--norc","-c","printf BASH_NATIVE_OK"],cwd:workspace});assert.equal(bash.exitCode,0);assert.match(bash.stdout,/BASH_NATIVE_OK/);record({profile,name:"unrestricted-bash",success:true})
    const terminal=createTerminalService(exec)
    try {
      const opened=await terminal.open({command:cmd,args:["/d"],cwd:workspace});await terminal.send(opened.id,"echo PTY_OK\r");await wait(()=>terminal.read(opened.id).data.includes("PTY_OK"));await terminal.close(opened.id);record({profile,name:"pty-open-close",settlement:terminal.list().find((x:any)=>x.id===opened.id)?.settlement??"view removed after close"})
      const helper=profile==="source"?join(repo,"packages/sandbox-windows-psec/artifacts/win32-x64/i-harness-windows-helper.exe"):join(desktop,"resources/gateway/node_modules/@i-harness/sandbox-windows-psec/artifacts/win32-x64/i-harness-windows-helper.exe")
      const marker=join(workspace,"cancelled-descendant")
      const t=await terminal.open({command:helper,args:["--self-child","spawn-descendant","3000",marker],cwd:workspace});assert.equal((await terminal.waitExited(t.id)).exitCode,17);const settled=await terminal.close(t.id);assert.equal(existsSync(marker),false);record({profile,name:"pty-generic-descendant-cancel",settlement:settled})
    } finally {await terminal.dispose()}
    const {createFsSearchTools}=await load("@i-harness/fs-search")
    const scoped={run:(command:any,options:any)=>exec.run({...command,sandbox:readonly},options)}
    const grep=createFsSearchTools({exec:scoped,workspace}).find((t:any)=>t.name==="grep")
    const found=await grep.execute({pattern:"WORKSPACE_OK",path:written},{sessionId:"standalone-exec",abortSignal:new AbortController().signal})
    assert.match(JSON.stringify(found),/WORKSPACE_OK/);record({profile,name:"legacy-search",success:true})
    const {HarnessClient}=await load("@i-harness/sdk")
    if(profile==="source") {
      const cli=await exec.run({argv:[process.execPath,join(repo,".tmp/sandbox-redesign-task5-cli/ih.mjs"),"__dist-selfcheck"],cwd:workspace})
      assert.equal(cli.exitCode,0,cli.stderr);assert.match(cli.stdout,/dist-selfcheck: PASS/);record({profile:"packaged-cli",name:"actual-cli-selfcheck",success:true})
    }
    const gateway=profile==="source"?join(repo,"packages/desktop-gateway"):join(desktop,"resources/gateway/cli")
    const loader=profile==="source"?createRequire(join(repo,"package.json")).resolve("tsx"):join(desktop,"resources/gateway/node_modules/tsx/dist/loader.mjs")
    const client=HarnessClient.spawn({command:process.execPath,args:["--import",pathToFileURL(loader).href,join(gateway,"src/cli.ts"),"--session-dir",join(workspace,"sessions")],cwd:workspace,env:{ELECTRON_RUN_AS_NODE:"1",IH_CONFIG_DIR:join(workspace,"config")}})
    try {const info=await client.initialize();const t=await client.request("desktop/terminal/open",{shell:"cmd"});await client.request("desktop/terminal/write",{id:t.id,data:"echo GATEWAY_OK\r"});let output="";for(let i=0;i<100&&!output.includes("GATEWAY_OK");i++){output=(await client.request("desktop/terminal/read",{id:t.id})).data;await sleep(20)}assert.match(output,/GATEWAY_OK/);const closed=await client.request("desktop/terminal/close",{id:t.id});assert.equal(closed.settlement.kind,"settled");record({profile,name:"actual-gateway-entrypoint-sdk-terminal",protocol:info.protocolVersion,settlement:closed.settlement})}finally{await client.close()}
    const {spawnLspConnection}=await load("@i-harness/lsp")
    const stub=join(workspace,"lsp.cjs");writeFileSync(stub,`let b=Buffer.alloc(0);process.stdin.on('data',d=>{b=Buffer.concat([b,d]);let i=b.indexOf('\\r\\n\\r\\n');if(i<0)return;let n=Number(/Content-Length: (\\d+)/.exec(b.subarray(0,i).toString())[1]);if(b.length<i+4+n)return;let m=JSON.parse(b.subarray(i+4,i+4+n));b=b.subarray(i+4+n);let s=JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ok:true}});process.stdout.write('Content-Length: '+Buffer.byteLength(s)+'\\r\\n\\r\\n'+s)});`)
    const lsp=spawnLspConnection({command:node,args:[stub],cwd:workspace,maxMessageBytes:4096,maxStderrBytes:4096,killGraceMs:1000});assert.deepEqual(await lsp.request("initialize",{}),{ok:true});lsp.kill();await lsp.closed;record({profile,name:"lsp-local-stub",success:true})
  }finally{await exec.dispose();record({profile,name:"exec-disposed",success:true})}
}
record({name:"finished",success:true})
