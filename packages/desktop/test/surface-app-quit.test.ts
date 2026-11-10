import {expect,it,vi} from 'vitest'
const fixture=vi.hoisted(()=>({events:new Map<string,Function>(),windows:[] as any[],handler:undefined as any,manager:undefined as any,record:vi.fn(),quit:vi.fn(),providers:vi.fn(async()=>{})}))
vi.mock('electron',()=>({app:{setPath(){},getPath(){return process.env.IH_CONFIG_DIR!},commandLine:{hasSwitch:()=>false},whenReady:()=>Promise.resolve(),on(name:string,fn:Function){fixture.events.set(name,fn)},once(){},quit:fixture.quit,isPackaged:false,getVersion:()=> 'fixture'},BrowserWindow:{getAllWindows:()=>fixture.windows.filter(w=>!w.destroyed)},ipcMain:{handle(_name:string,fn:any){fixture.handler=fn},removeHandler(){fixture.handler=undefined}},dialog:{},shell:{},clipboard:{}}))
vi.mock('../src/main/sdk-runtime.ts',()=>({createWorkspaceRuntimeManager:()=>fixture.manager,launchBundledGateway(){throw Error('No real process launch')}}))
vi.mock('../src/main/window.ts',()=>({createDesktopWindow(){const events=new Map<string,Function>(),w={events,destroyed:false,on(name:string,fn:Function){events.set(name,fn)},isDestroyed(){return this.destroyed},isMinimized:()=>false,restore(){},show(){},focus(){},webContents:{send(){}}};fixture.windows.push(w);return w}}))
vi.mock('../src/main/workspaces.ts',()=>({createWorkspaceCatalog:()=>({get:(id:string)=>id==='w'?{id:'w',path:process.env.IH_CONFIG_DIR!,label:'fixture'}:undefined})}))
vi.mock('../src/main/projects.ts',()=>({createProjectCatalog:()=>({})}))
vi.mock('../src/main/local-preferences.ts',()=>({createLocalPreferences:()=>({get:()=>({locale:'en'})})}))
vi.mock('../src/main/native-window.ts',()=>({attachNativeWindow:()=>({onWindowStateChanged:()=>()=>{}})}))
vi.mock('../src/main/browser-surface.ts',()=>({createBrowserSurface:()=>({})}))
vi.mock('../src/main/tray.ts',()=>({createDesktopTray:()=>undefined}))
vi.mock('../src/main/global-provider-settings.ts',()=>({createGlobalProviderSettings:()=>({close:fixture.providers})}))
vi.mock('../src/main/runtime-diagnostics.ts',()=>({createRuntimeDiagnostics:()=>({recordRequestFailure:fixture.record,observe(){},onEntry:()=>()=>{},onActivity:()=>()=>{},flush:async()=>{}})}))
vi.mock('../src/main/usage-warnings.ts',()=>({createUsageWarnings:()=>({observe(){},read(){},flush:async()=>{}})}))
vi.mock('../src/main/notification-history.ts',()=>({createNotificationHistory:()=>({flush:async()=>{}})}))
vi.mock('../src/main/attachment-draft-store.ts',()=>({AttachmentDraftStore:class{async flush(){}}}))
it('actual before-quit entry retains current debt, restores a zero-window failure, then quits once final original owners settle',async()=>{
 const exited=Promise.withResolvers<void>(),fault=Object.freeze({original:'surface cleanup failed'});let current:any,failManager=true
 const request=vi.fn(async(method:string,p:any)=>{if(method==='desktop/surface/subscribe')return {subscriptionId:'token',requestKey:p.requestKey,scope:{surface:'execution',sessionId:'s'},stamp:{epoch:'epoch',revision:0}};throw fault})
 const runtime={client:{request},info:{capabilities:{'desktop-surface-events':['1']}},whenClosed:()=>exited.promise};current=runtime
 fixture.manager={get:async()=>runtime,peek:()=>current,onEvent:()=>()=>{},close:vi.fn(async()=>{if(failManager)throw fault;current=undefined})}
 const error=vi.spyOn(console,'error').mockImplementation(()=>{})
 try{
  await import('../src/main/index.ts');await new Promise(resolve=>setImmediate(resolve));const window=fixture.windows[0]
  await fixture.handler({sender:window.webContents},{kind:'desktop/surface/subscribe',workspaceId:'w',surface:'execution',sessionId:'s'})
  window.destroyed=true;window.events.get('closed')();await vi.waitFor(()=>expect(fixture.record).toHaveBeenCalled())
  const first={preventDefault:vi.fn()};fixture.events.get('before-quit')!(first)
  await vi.waitFor(()=>expect(fixture.manager.close).toHaveBeenCalledTimes(1));await vi.waitFor(()=>expect(fixture.windows).toHaveLength(2));expect(fixture.quit).not.toHaveBeenCalled();expect(first.preventDefault).toHaveBeenCalledOnce()
  failManager=false;fixture.events.get('before-quit')!({preventDefault:vi.fn()});await vi.waitFor(()=>expect(fixture.manager.close).toHaveBeenCalledTimes(2));await new Promise(resolve=>setImmediate(resolve));expect(fixture.quit).not.toHaveBeenCalled()
  exited.resolve();await vi.waitFor(()=>expect(fixture.quit).toHaveBeenCalledOnce());expect(request.mock.calls.filter(([method])=>method==='desktop/surface/subscribe')).toHaveLength(1);expect(fixture.record).toHaveBeenCalled()
 }finally{failManager=false;current=undefined;exited.resolve();const {closeDesktopSurfaceWindows}=await import('../src/main/ipc.ts');await closeDesktopSurfaceWindows();error.mockRestore()}
},60000)
