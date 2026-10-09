import {afterEach,expect,it} from 'vitest'
import {createDesktopDiagnostics}from'../src/environment-diagnostics.ts'
import {createSessionService}from'@i-harness/session-executor'
const services:ReturnType<typeof createSessionService>[]=[]
afterEach(async()=>{for(const service of services.splice(0))await service.close()})
it('leaves the Linux executable untested by host diagnostics and directs explicit WSL diagnosis',async()=>{
 const service=createSessionService({workspace:process.cwd(),modelPolicy:'required'});services.push(service)
 const shell={executionTarget:'wsl' as const,selected:'bash' as const,options:[],resolved:{id:'bash' as const,label:'Linux Bash',command:'/bin/bash',dialect:'posix' as const,executionTarget:'wsl' as const}}
 const diagnostics=createDesktopDiagnostics(service,{shell:{state:async()=>shell}})
 expect((await diagnostics.read(undefined,true)).executables[0]).toMatchObject({command:'/bin/bash',status:'untested',error:expect.stringContaining('WSL diagnostics')})
})
