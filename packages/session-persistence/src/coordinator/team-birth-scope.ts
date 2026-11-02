import {types} from 'node:util'
import {captureHeldOwnershipClaim,type Ownership} from './ownership.ts'
import {teamBirthBindingKey} from './team-birth-binding.ts'
import {associateTeamBirthWriteScope} from './task-write-lifetime.ts'

declare const teamBirthScope:unique symbol
export interface HeldTeamBirthScope {readonly [teamBirthScope]:never;readonly parentSessionId:string;readonly memberId:string;readonly key:string;assertActive():void}
const scopes=new WeakSet<object>()
export function isHeldTeamBirthScope(value:unknown):value is HeldTeamBirthScope{return typeof value==='object'&&value!==null&&scopes.has(value)}
/** Internal Team owner only, over the actual original parent pin and admission. */
export function issueHeldTeamBirthScope(owner:Ownership,parentSessionId:string,memberId:string,claim:Awaited<ReturnType<Ownership['pinOwnership']>>,admission:{assertActive():void;captureIssued():()=>void;assertOriginal():void}):HeldTeamBirthScope{
 const held=captureHeldOwnershipClaim(owner,parentSessionId,claim);if(!admission||types.isProxy(admission))throw TypeError('Original Team binding admission required')
 const fields=Object.getOwnPropertyDescriptors(admission);for(const name of ['assertActive','captureIssued','assertOriginal'] as const){const field=fields[name];if(!field||!('value'in field)||typeof field.value!=='function'||types.isProxy(field.value))throw TypeError('Original Team binding admission required')}
 const check=()=>{for(const name of ['assertActive','captureIssued','assertOriginal'] as const)if(Object.getOwnPropertyDescriptor(admission,name)?.value!==fields[name]!.value)throw TypeError('Original Team binding admission changed');held.assertHeld();Reflect.apply(fields.assertActive!.value!,admission,[])}
 check();const scope=Object.freeze({parentSessionId,memberId,key:teamBirthBindingKey(parentSessionId,memberId),assertActive(){if(this!==scope)throw TypeError('Original Team binding scope required');check()}}) as HeldTeamBirthScope
 scopes.add(scope);associateTeamBirthWriteScope(scope,{captureIssued(){check();return Reflect.apply(fields.captureIssued!.value!,admission,[])},assertOriginal(){Reflect.apply(fields.assertOriginal!.value!,admission,[])}});return scope
}
