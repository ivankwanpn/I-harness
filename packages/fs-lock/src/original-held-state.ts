import {types} from 'node:util'
import type {SessionLock} from './index.ts'
type HeldState=Readonly<{read():boolean}>
const originals=new WeakMap<object,{state:HeldState;check():void}>()
/** Original platform constructors only; the issuer is not package-exported. */
export function associateOriginalHeldState(lock:SessionLock):void{
 if(!lock||types.isProxy(lock))throw TypeError('Original held getter required')
 const field=Object.getOwnPropertyDescriptor(lock,'held')
 if(originals.has(lock)||types.isProxy(lock)||!field||typeof field.get!=='function'||types.isProxy(field.get))throw TypeError('Original held getter required')
 const getter=field.get
 const check=()=>{const current=Object.getOwnPropertyDescriptor(lock,'held');if(!current||current.get!==getter||current.set!==undefined)throw TypeError('Changed original held getter')}
 const state:HeldState=Object.freeze({read(){
  if(this!==state)throw TypeError('Original held state receiver required')
  check()
  const value=Reflect.apply(getter,lock,[])
  if(typeof value!=='boolean')throw TypeError('Original held state unavailable')
  return value
 }})
 originals.set(lock,{state,check})
}
/** Absence is unrecognized, distinct from an original getter reporting false. */
export function originalHeldStateFor(lock:SessionLock):HeldState|undefined{
 if(!lock||types.isProxy(lock))return undefined
 const state=originals.get(lock)
 if(state)state.check()
 return state?.state
}
