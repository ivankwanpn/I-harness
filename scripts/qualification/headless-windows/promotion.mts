import assert from "node:assert/strict"
import {createRequire} from "node:module"
import {pathToFileURL} from "node:url"
import {mkdirSync,writeFileSync} from "node:fs"
import {join} from "node:path"
const [fixture,repo]=process.argv.slice(2)
process.env.TEMP=fixture;process.env.TMP=fixture
const results:any[]=[]
for(const profile of ["source","packaged-desktop"]){
  const req=createRequire(join(profile==="source"?join(repo!,"packages/session-executor"):join(repo!,"packages/desktop/release-sandbox-task5/I-harness Desktop/resources/gateway/cli"),"package.json"))
  const {createSessionAssembly}=await import(pathToFileURL(req.resolve("@i-harness/session-executor")).href)
  const workspace=join(fixture!,profile);mkdirSync(workspace)
  const assembly=await createSessionAssembly({sessionId:"legacy-promotion",workspace,modelPolicy:"test-mock",sandbox:"read-only"})
  const exec=assembly.ctx.services.get("exec/service")
  try{
    const command={argv:["C:/Program Files/nodejs/node.exe","-e","console.log('START:'+process.pid);setTimeout(()=>console.log('END:'+process.pid),700)"],cwd:workspace}
    const promoted=await exec.run(command,{backgroundAfterMs:30});assert.equal(promoted.promoted,true)
    const receipt=exec.getOutput(promoted.jobId).receipt;assert.equal(receipt.backendId,"windows-acl-legacy")
    const deadline=Date.now()+15000
    while(exec.getOutput(promoted.jobId).status==="running"&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10))
    const final=exec.getOutput(promoted.jobId);assert.equal(final.exitCode,0)
    assert.equal(final.receipt.executionId,receipt.executionId)
    assert.equal((final.stdout.match(/START:/g)??[]).length,1)
    assert.equal(/START:(\d+)/.exec(final.stdout)?.[1],/END:(\d+)/.exec(final.stdout)?.[1])
    assert.deepEqual(final.settlement,{kind:"settled",root:{exitCode:0},treeEmpty:true,ioSettled:true,resourcesReleased:true})
    await assert.rejects(exec.runBackground(command),/retained-tree|retain|requirements/)
    results.push({profile,promotion:true,backend:receipt.backendId,executionId:receipt.executionId,childPid:/START:(\d+)/.exec(final.stdout)?.[1],settlement:final.settlement,explicitRetainRefused:true})
  }finally{await assembly.dispose()}
}
writeFileSync(join(fixture!,"promotion-results.json"),JSON.stringify(results,null,2))
