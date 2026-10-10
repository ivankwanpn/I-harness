import assert from "node:assert/strict"
import {createRequire} from "node:module"
import {pathToFileURL} from "node:url"
import {mkdirSync,writeFileSync,readFileSync,existsSync,statSync} from "node:fs"
import {join} from "node:path"
import {createHash} from "node:crypto"
const [fixture,repo]=process.argv.slice(2)
process.env.TEMP=fixture;process.env.TMP=fixture;process.env.IH_CONFIG_DIR=join(fixture!,"config")
const records:any[]=[]
const record=(r:any)=>{records.push(r);writeFileSync(join(fixture!,"supplemental-results.json"),JSON.stringify(records,null,2))}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const wait=async(fn:()=>boolean)=>{const end=Date.now()+15000;while(!fn()&&Date.now()<end)await sleep(10);assert.ok(fn())}
for(const profile of ["source","packaged-desktop"]){
  const packageRoot=join(repo!,"packages/desktop/release-sandbox-task5/I-harness Desktop/resources/gateway")
  const req=createRequire(join(packageRoot,"cli/package.json"))
  const load=(name:string)=>import(pathToFileURL((profile==="source"?createRequire(join(repo!,"packages",name.split("/")[1]!,"package.json")):req).resolve(name)).href)
  const {createExecService}=await load("@i-harness/exec"),{createSessionAssembly}=await load("@i-harness/session-executor")
  const workspace=join(fixture!,profile);mkdirSync(workspace)
  const exec=createExecService({workspaceRoot:workspace})
  try{
    if(profile==="source") {
      const cli=await exec.run({argv:[process.execPath,join(repo!,".tmp/sandbox-redesign-task5-cli/ih.mjs"),"__dist-selfcheck"],cwd:workspace})
      assert.equal(cli.exitCode,0,cli.stderr);assert.match(cli.stdout,/dist-selfcheck: PASS/);record({profile:"packaged-cli",name:"actual-cli-native-code-mode-entry",success:true})
    }
    const {PluginRegistry}=await load("@i-harness/plugin-registry")
    const gitSource=join(workspace,"git-source");mkdirSync(gitSource)
    writeFileSync(join(gitSource,"marketplace.json"),JSON.stringify({name:"owned-fixture",plugins:[{name:"sample",source:{source:"git",url:pathToFileURL(gitSource).href}}]}))
    mkdirSync(join(gitSource,".claude-plugin"));writeFileSync(join(gitSource,".claude-plugin/plugin.json"),JSON.stringify({name:"sample",version:"1.0.0"}))
    mkdirSync(join(gitSource,"commands"));writeFileSync(join(gitSource,"commands/probe.md"),"Owned inert fixture command")
    for(const args of [["init"],["add","."],["-c","user.name=Owned fixture","-c","user.email=fixture@example.invalid","commit","-m","Owned inert fixture"]]){
      const r=await exec.run({argv:["C:/Program Files/Git/cmd/git.exe",...args],cwd:gitSource});assert.equal(r.exitCode,0,r.stderr)
    }
    const registry=new PluginRegistry({root:join(workspace,"registry")})
    const source=await registry.addSource(pathToFileURL(gitSource).href);assert.equal(source.source.name,"owned-fixture")
    await registry.install("owned-fixture__sample");record({profile,name:"plugin-local-git-marketplace-and-install",success:true})
    const {createAgentShellSettings}=await load("@i-harness/desktop-gateway/src/agent-shell.ts")
    const selected=createAgentShellSettings(join(workspace,"auto-settings.json"))
    const shell=selected.resolve();assert.equal(shell.id,"auto");assert.equal(shell.dialect,"powershell");assert.doesNotMatch(shell.command,/WindowsApps/i)
    const auto=await createSessionAssembly({sessionId:"auto",workspace,modelPolicy:"test-mock",sandbox:"read-only",approveAll:true,agentShell:selected.resolve})
    try{const result=await auto.tools.execute({name:"shell",args:{command:"Write-Output AUTO_NATIVE_OK"}});assert.match(JSON.stringify(result),/AUTO_NATIVE_OK/);assert.equal(result.output.exitCode,0);record({profile,name:"actual-assembled-desktop-auto",shell:{command:shell.command,dialect:shell.dialect},result:result.output})}finally{await auto.dispose()}
    const {createSessionCoordinator}=await load("@i-harness/session-persistence"),{createJsonlBackend}=await load("@i-harness/session-persistence-jsonl"),{createMockClient}=await load("@i-harness/llm-mock")
    const coordinator=createSessionCoordinator(createJsonlBackend(join(workspace,"sessions")));await coordinator.create({sessionId:"main"})
    const receipts:any[]=[];let scoped:any
    const probe={name:"owner_probe",description:"Owned lineage probe",isReadOnly:true,inputSchema:{type:"object"},execute:async()=>{const job=await scoped.runBackground({argv:["C:/Program Files/nodejs/node.exe","-e","setInterval(()=>{},1000)"]});receipts.push(scoped.getOutput(job.jobId).receipt);return job}}
    const assembly=await createSessionAssembly({sessionId:"main",coordinator,workspace,model:createMockClient([{role:"assistant",toolCalls:[{name:"code_exec",args:{code:"text(await tools.owner_probe({}))",yield_time_ms:1000}}]},{role:"assistant",text:"done"}]),approveAll:true,sandbox:"danger-full-access",codeMode:{mode:"mixed"},additionalTools:[probe],pluginAgents:[{name:"owner-worker",description:"fixture",systemPrompt:"Run owned probe",tools:["owner_probe","code_exec","code_wait"]}]})
    scoped=assembly.ctx.services.get("exec/service")
    try{
      await assembly.tools.execute({name:"owner_probe",args:{}});await assembly.tools.execute({name:"spawn_agent",args:{task_name:"identity",agent_type:"owner-worker",message:"probe",fork_turns:"none",background:false}})
      assert.equal(receipts.length,2);assert.equal(receipts[0].owner.sessionId,"main");assert.notEqual(receipts[1].owner.sessionId,"main");assert.equal(receipts[1].owner.parentSessionId,"main");assert.equal((await coordinator.profile(receipts[1].owner.sessionId)).meta.parentSession,"main")
      for(const job of scoped.listJobs())await scoped.killJob(job.id);record({profile,name:"actual-owner-lineage-code-mode",owners:receipts.map(r=>r.owner),settlements:scoped.listJobs().map((j:any)=>j.settlement)})
    }finally{await assembly.dispose();await coordinator.close()}
    const ready=join(workspace,"ready"),late=join(workspace,"late")
    let authority:any={kind:"unbound",revision:"1",workspaceRoot:workspace}
    const owned=await createSessionAssembly({sessionId:"revoke",workspace,modelPolicy:"test-mock",sandbox:"workspace-write",executionAuthority:()=>authority})
    const writer=owned.ctx.services.get("exec/service").run({argv:["C:/Program Files/nodejs/node.exe","-e",`const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'late'),1000);setInterval(()=>{},1000)`]}).catch((e:any)=>({error:e.message}))
    try{await wait(()=>existsSync(ready));authority={kind:"revoked",revision:"2",reason:"owned qualification"};await owned.reconcileExecutionAuthority();await writer;await sleep(1200);assert.equal(existsSync(late),false);record({profile,name:"revocation-ack-after-native-drain",lateWrite:false})}finally{await owned.dispose()}
    const reference=join(fixture!,profile+"-reference");mkdirSync(reference);const file=join(reference,"keep.txt");writeFileSync(file,"REFERENCE_UNCHANGED")
    const fingerprint=()=>{const s=statSync(file);return {sha256:createHash("sha256").update(readFileSync(file)).digest("hex"),mtime:s.mtimeMs,ctime:s.ctimeMs,birthtime:s.birthtimeMs,size:s.size,mode:s.mode}}
    const before=fingerprint();const locked=await createSessionAssembly({sessionId:"reference",workspace,modelPolicy:"test-mock",approveAll:true,sandbox:"danger-full-access",executionAuthority:()=>({kind:"unbound",revision:"reference",workspaceRoot:workspace,references:[reference]})})
    try{
      const read=await locked.tools.execute({name:"read",args:{path:file}});assert.equal(read.output.content,"REFERENCE_UNCHANGED")
      await assert.rejects(locked.tools.execute({name:"write",args:{path:file,text:"FORBIDDEN"}}),/Readonly reference/)
      await assert.rejects(locked.ctx.services.get("exec/service").run({argv:["C:/Program Files/nodejs/node.exe","-e","process.exit(9)"]}),/reference|deny-paths|denial|capabilit|mandatory/i)
      assert.deepEqual(fingerprint(),before);record({profile,name:"mandatory-reference-read-write-denial-and-process-refusal",fingerprint:before})
    }finally{await locked.dispose()}
  }finally{await exec.dispose();record({profile,name:"disposed",success:true})}
}
