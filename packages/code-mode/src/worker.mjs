import { parentPort, workerData } from 'node:worker_threads'
import { getQuickJS } from 'quickjs-emscripten'
import { createCpuBudget } from './cpu-budget.mjs'

// This file executes in Node. Guest code executes only inside the WASM context.
const { code, cellId, catalog, store, config } = workerData
const TEXT_CAP = 16 * 1024
const ITEM_CAP = 256
const ERROR_CAP = Math.min(4096, config.maxResultBytes)
const tools = new Map()
const timers = new Map()
let runtime, vm, moduleHandle, decode, formatError, diagnosticReserve
let closed = false, pumping = false, scheduled = false
const cpu = createCpuBudget(config.cpuTimeMs)
let outputBytes = 0, textBytes = 0, outputItems = 0, truncated = false
let diagnosticTruncated = false
let pendingYields = 0
let writes = '[]'
const send = value => { if (!closed) parentPort.postMessage(value) }
function errorText(value) {
  let raw
  try { raw = typeof value === 'object' && value ? typeof value.message === 'string' ? value.message : 'Worker error' : String(value) }
  catch { raw = 'Worker error message unavailable' }
  let text = raw.slice(0, ERROR_CAP)
  const encoded = Buffer.from(text)
  if (encoded.length > ERROR_CAP) text = encoded.subarray(0, ERROR_CAP).toString('utf8')
  while (Buffer.byteLength(text) > ERROR_CAP) text = text.slice(0, -1)
  if (text !== raw) truncated = true
  return text
}
function guestError(handle) {
  if (cpu.exceeded()) return 'CPU work limit exceeded'
  diagnosticReserve?.dispose(); diagnosticReserve = undefined
  if (!formatError) { truncated = true; return 'Guest initialization error' }
  const result = vm.callFunction(formatError, vm.undefined, handle)
  if (result.error) {
    result.error.dispose(); truncated = true
    return 'Guest error message unavailable'
  }
  try {
    const diagnostic = vm.getString(result.value)
    if (diagnostic[0] === '1') truncated = true
    return errorText(diagnostic.slice(1))
  } finally { result.value.dispose() }
}
function finish(status, error) {
  if (closed) return
  if (status === 'completed') {
    // Account exactly once before success permits the parent to commit writes.
    // A failed clock cannot be hidden by an already published completed event.
    try { cpu.end(); if (cpu.exceeded()) { status = 'failed'; error = 'CPU work limit exceeded' } }
    catch (failure) { status = 'failed'; error = errorText(failure) }
  }
  parentPort.postMessage({type:'closed',status,error:error === undefined ? undefined : errorText(error),truncated:truncated || diagnosticTruncated,writes:status === 'completed' ? writes : '[]'})
  closed = true
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  parentPort.removeAllListeners('message')
  // Parent hard termination reclaims all handles together, including unresolved promises.
  parentPort.close()
}
function run(fn, charge = true) {
  if (closed) return
  if (charge) cpu.begin()
  send({type:'busy'})
  try { return fn() }
  catch (error) { finish('failed',errorText(error)) }
  finally {
    if (charge) cpu.end()
    // An interrupt can leave a rejected internal promise with no queued job.
    // Closing at the slice boundary also contains that engine outcome.
    if (!closed && cpu.exceeded()) finish('failed','CPU work limit exceeded')
    send({type:'idle'})
  }
}
function pump() {
  if (closed || pumping) return
  pumping = true
  try {
    run(() => {
      if (cpu.exceeded()) { finish('failed','CPU work limit exceeded'); return }
      for (let i=0;i<=64;i++) {
        // Completion is a lifetime boundary; do not run unrelated jobs after it.
        const state = vm.getPromiseState(moduleHandle)
        if (state.type === 'fulfilled') { state.value.dispose(); finish('completed'); return }
        if (state.type === 'rejected') { const error = guestError(state.error); state.error.dispose(); finish('failed',error); return }
        if (!runtime.hasPendingJob()) return
        if (i === 64) { schedule(); return }
        const jobs = runtime.executePendingJobs(1)
        if (jobs.error) { const error = guestError(jobs.error); jobs.error.dispose(); finish('failed',error); return }
      }
    })
  } finally { pumping = false }
}
function schedule() {
  if (closed || scheduled) return
  scheduled = true
  setImmediate(() => { scheduled = false; pump() })
}
function bridge(payloadHandle) {
  if (closed) return vm.undefined
  const payload = vm.getString(payloadHandle)
  // Strings nested in the JSON envelope can expand to six bytes per input byte.
  if (Buffer.byteLength(payload) > Math.max(config.maxResultBytes, config.maxStoreBytes, TEXT_CAP) * 6 + 8192) throw new Error('Guest transfer limit exceeded')
  const request = JSON.parse(payload)
  if (request.type === 'output') {
    const item = request.item
    const encoded = JSON.stringify(item)
    const bytes = Buffer.byteLength(encoded)
    const itemTextBytes = item.type === 'text' ? Buffer.byteLength(item.text) : 0
    if (outputItems >= ITEM_CAP || outputBytes + bytes > config.maxResultBytes) {
      truncated = true; send({type:'truncated',text:item.type==='text'})
    } else {
      outputItems++; outputBytes += bytes; textBytes += itemTextBytes
      send({type:'output',json:encoded})
    }
    return vm.undefined
  }
  if (request.type === 'truncated') {
    truncated = true; send({type:'truncated',text:request.text===true})
    return vm.undefined
  }
  if (request.type === 'call') {
    const deferred = vm.newPromise()
    if (tools.size >= config.maxPendingCalls) {
      const error = vm.newError('Pending tool call limit exceeded')
      deferred.reject(error); error.dispose()
      const result = deferred.handle.dup(); deferred.dispose(); return result
    }
    tools.set(request.id,deferred)
    send({type:'call',id:request.id,name:request.name,json:request.json})
    return deferred.handle
  }
  if (request.type === 'timer') {
    if (timers.size >= config.maxPendingCalls) throw new Error('Pending timer limit exceeded')
    const timer = setTimeout(() => {
      timers.delete(request.id)
      if (closed) return
      run(() => {
        const result = vm.evalCode(`globalThis.__codeModeTimer(${JSON.stringify(request.id)})`)
        if (result.error) { const error = guestError(result.error); result.error.dispose(); finish('failed',error) }
        else result.value.dispose()
      })
      pump()
    },request.delay)
    timers.set(request.id,timer)
    return vm.undefined
  }
  if (request.type === 'clearTimer') { clearTimeout(timers.get(request.id)); timers.delete(request.id); return vm.undefined }
  if (request.type === 'yield') {
    send({type:'yield'})
    if (request.notify) return vm.undefined
    if (pendingYields >= config.maxPendingCalls) throw new Error('Pending yield limit exceeded')
    pendingYields++
    const deferred = vm.newPromise()
    setImmediate(() => { pendingYields--; if (!closed) { run(()=>deferred.resolve()); deferred.dispose(); pump() } })
    return deferred.handle
  }
  if (request.type === 'store') { writes = request.json; return vm.undefined }
  if (request.type === 'exit') { finish('completed'); return vm.undefined }
  throw new Error('Unknown guest operation')
}

try {
  const QuickJS = await getQuickJS()
  runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(config.memoryLimitMb * 1024 * 1024)
  runtime.setMaxStackSize(512 * 1024)
  runtime.setModuleLoader(() => { throw new Error('Module imports are disabled in Code Mode') })
  runtime.setInterruptHandler(() => closed || cpu.exceeded())
  vm = runtime.newContext()
  const callback = vm.newFunction('__codeModeBridge',bridge)
  vm.setProp(vm.global,'__codeModeBridge',callback)
  callback.dispose()
  // Helpers capture the sole callback; no Node object, promise, or handle is passed to guest.
  const bootstrap = `(() => {
    const host = globalThis.__codeModeBridge; delete globalThis.__codeModeBridge;
    const stringify = JSON.stringify.bind(JSON), parse = JSON.parse.bind(JSON);
    const string = String;
    const slice = Function.prototype.call.bind(String.prototype.slice);
    const charCode = Function.prototype.call.bind(String.prototype.charCodeAt);
    const callHost = value => host(stringify(value));
    const catalog = parse(${JSON.stringify(catalog)});
    const values = new Map(parse(${JSON.stringify(store)}));
    const writes = new Map();
    const callbacks = new Map();
    let sequence = 0;
    const bytes = s => { let n=0; for (let i=0;i<s.length;i++) { const c=s.charCodeAt(i); if(c<128)n++; else if(c<2048)n+=2; else if(c>=0xD800&&c<=0xDBFF&&i+1<s.length&&s.charCodeAt(i+1)>=0xDC00&&s.charCodeAt(i+1)<=0xDFFF){n+=4;i++;}else n+=3; } return n; };
    const copy = value => { const s=stringify(value); if(s===undefined)throw Error('Value must be JSON serializable'); return parse(s); };
    const jsonCopy = value => {const encoded=stringify(value,(key,current)=>{if(current===undefined||typeof current==='function'||typeof current==='symbol'||typeof current==='bigint'||typeof current==='number'&&!Number.isFinite(current))throw Error('Store requires JSON values only');return current;});return parse(encoded);};
    const clip = (value, cap) => {let end=0,size=0;while(end<value.length){const c=charCode(value,end);let cost=c<128?1:c<2048?2:3,units=1;if(c>=0xD800&&c<=0xDBFF&&end+1<value.length){const n=charCode(value,end+1);if(n>=0xDC00&&n<=0xDFFF){cost=4;units=2;}}if(size+cost>cap)break;size+=cost;end+=units;}return slice(value,0,end);};
    globalThis.searchTools=(query,limit=8)=>{
      if(typeof query!=='string')throw Error('Tool query must be a string');
      if(bytes(query)>256)throw Error('Tool query limit exceeded');
      if(!Number.isInteger(limit)||limit<0)throw Error('Tool search limit must be a nonnegative integer');
      if(limit===0)return [];
      const terms=query.toLowerCase().trim().split(/\\s+/).filter(Boolean),matches=[];
      for(const tool of catalog){if(tool.name.length>256||tool.alias.length>256)continue;const haystack=(tool.name+' '+tool.alias+' '+tool.description).toLowerCase();if(terms.every(term=>haystack.includes(term))){const row={name:tool.name,alias:tool.alias,description:clip(tool.description,320)};if(bytes(stringify(row))>1024)continue;matches.push(row);if(matches.length>=Math.min(20,limit))break;}}
      return matches;
    };
    globalThis.describeTool=name=>{
      if(typeof name!=='string')throw Error('Tool name must be a string');
      const tool=catalog.find(tool=>tool.name===name||tool.alias===name);
      if(!tool)throw Error('Tool not found: '+clip(name,256));
      const {alias,...definition}=tool,encoded=stringify(definition);
      if(bytes(encoded)>${Math.min(16 * 1024, config.maxResultBytes)})throw Error('Tool definition limit exceeded; complete definition unavailable');
      return parse(encoded);
    };
    const emit = item => {
      const encoded=stringify(item);
      if(bytes(encoded)>${config.maxResultBytes}) {callHost({type:'truncated',text:item.type==='text'});return;}
      callHost({type:'output',item});
    };
    globalThis.tools = Object.create(null);
    for (const tool of catalog) Object.defineProperty(tools,tool.alias,{value:(args={})=>{
      const json=stringify(args); if(json===undefined)throw Error('Arguments must be JSON serializable');
      if(bytes(json)>${config.maxResultBytes})throw Error('Tool argument transfer limit exceeded');
      return callHost({type:'call',id:${JSON.stringify(cellId)}+':'+(++sequence),name:tool.name,json});
    },enumerable:true});
    globalThis.ALL_TOOLS=catalog.map(({alias,...tool})=>copy(tool));
    globalThis.text=value=>{let result;if(typeof value==='string')result=value;else {try {result=stringify(value)}catch{} if(result===undefined)result=String(value);} emit({type:'text',text:result});};
    globalThis.image=value=>{
      let image;
      if(value&&typeof value==='object'&&value.mediaType&&typeof value.dataBase64==='string')image=copy(value);
      else if(value&&typeof value==='object'&&value.type==='image'&&value.mimeType&&typeof value.data==='string')image={mediaType:value.mimeType,dataBase64:value.data};
      else {const url=typeof value==='string'?value:value&&value.image_url;const match=typeof url==='string'&&/^data:(image\\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);if(!match)throw Error('Image must be a base64 data URL or image content'); image={mediaType:match[1],dataBase64:match[2]};}
      if(!['image/png','image/jpeg','image/webp','image/gif'].includes(image.mediaType)||!/^[A-Za-z0-9+/]*={0,2}$/.test(image.dataBase64))throw Error('Invalid image');
      emit({type:'image',image});
    };
    globalThis.audio=value=>{const audioUrl=typeof value==='string'?value:value&&value.type==='audio'?('data:'+value.mimeType+';base64,'+value.data):value&&value.audio_url; if(typeof audioUrl!=='string'||!/^data:audio\\/[^;,]+;base64,[A-Za-z0-9+/]*={0,2}$/.test(audioUrl))throw Error('Audio must be a base64 data URL'); emit({type:'audio',audioUrl});};
    globalThis.store=(key,value)=>{
      if(typeof key!=='string')throw Error('Store key must be a string'); const next=jsonCopy(value), merged=new Map(values);merged.set(key,next);
      if(bytes(stringify([...merged]))>${config.maxStoreBytes})throw Error('Session store limit exceeded');
      values.set(key,next);writes.set(key,next);callHost({type:'store',json:stringify([...writes])});
    };
    globalThis.load=key=>values.has(key)?copy(values.get(key)):undefined;
    globalThis.yield_control=()=>callHost({type:'yield'});
    globalThis.notify=value=>{text(value);callHost({type:'yield',notify:true});};
    globalThis.exit=()=>{callHost({type:'exit'});throw Error('Cell exited');};
    globalThis.setTimeout=(fn,delay=0,...args)=>{if(typeof fn!=='function')throw Error('Timer requires a function');if(!Number.isFinite(delay)||delay<0)throw Error('Invalid timer delay');const id=String(++sequence);callbacks.set(id,()=>fn(...args));try {callHost({type:'timer',id,delay:Math.min(2147483647,Math.floor(delay))})}catch(e){callbacks.delete(id);throw e}return id;};
    globalThis.clearTimeout=id=>{callbacks.delete(String(id));callHost({type:'clearTimer',id:String(id)});};
    Object.defineProperty(globalThis,'__codeModeTimer',{value:id=>{const fn=callbacks.get(id);callbacks.delete(id);if(fn)fn();}});
    return {parse,formatError:error=>{
      let raw;
      try {raw=error&&typeof error==='object'?typeof error.message==='string'?error.message:'Guest threw a non-message value':string(error);}
      catch {raw='Guest error message unavailable';}
      let index=0,size=0;
      while(index<raw.length){const c=charCode(raw,index);let cost=c<128?1:c<2048?2:3,units=1;if(c>=0xD800&&c<=0xDBFF&&index+1<raw.length){const next=charCode(raw,index+1);if(next>=0xDC00&&next<=0xDFFF){cost=4;units=2;}}if(size+cost>${ERROR_CAP})break;size+=cost;index+=units;}
      return (index<raw.length?'1':'0')+slice(raw,0,index);
    }};
  })();`
  run(() => {
    const setup = vm.evalCode(bootstrap)
    if (setup.error) { const error=guestError(setup.error);setup.error.dispose();finish('failed',error);return }
    decode = vm.getProp(setup.value,'parse')
    formatError = vm.getProp(setup.value,'formatError')
    setup.value.dispose()
    diagnosticReserve = vm.newString(' '.repeat(16 * 1024))
  }, false)
  // Only fixed trusted helper construction is excluded. Source evaluation,
  // promise pumping, result settlement and later callbacks stay charged.
  run(() => {
    const result = vm.evalCode(code,'cell.mjs',{type:'module'})
    if (result.error) { const error=guestError(result.error);result.error.dispose();finish('failed',error);return }
    moduleHandle = result.value
  })
  parentPort.on('message',data => {
    if (closed) return
    if (data.type === 'observed') { outputBytes=0;textBytes=0;outputItems=0;truncated=false;return }
    if (data.type !== 'result') return
    if (data.truncated === true) diagnosticTruncated = true
    const deferred = tools.get(data.id)
    if (!deferred) return
    tools.delete(data.id)
    run(() => {
      if (data.error !== undefined) { const error=vm.newError(String(data.error));deferred.reject(error);error.dispose() }
      else {
        const input=vm.newString(data.json)
        const result=vm.callFunction(decode,vm.undefined,input)
        input.dispose()
        if(result.error){deferred.reject(result.error);result.error.dispose()}
        else {deferred.resolve(result.value);result.value.dispose()}
      }
      deferred.dispose()
    })
    pump()
  })
  if (!closed) pump()
} catch (error) { finish('failed',errorText(error)) }
