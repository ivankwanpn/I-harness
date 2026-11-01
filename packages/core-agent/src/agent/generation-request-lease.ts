import {createGenerationControl,isGenerationControl,type GenerationControl} from '@i-harness/llm-seam'
import {savingFailure} from './saving-failure.ts'
import {stalePreparedInput} from './admission.ts'

/** Delegate the same original native reservation. Readonly lease refresh is
 * before/after awaited bookkeeping; the original issue remains synchronous. */
export function generationRequestLease(original:GenerationControl,refresh:()=>Promise<boolean>):GenerationControl{
 if(!isGenerationControl(original))throw TypeError('Original generation control required')
 const current=async()=>{if(!await refresh())throw stalePreparedInput()}
 return createGenerationControl({signal:original.signal,
  async reserve(candidate){await current();const reservation=await original.reserve(candidate);try{await current();return reservation}catch(primary){try{await reservation.settle('unsent')}catch(cleanup){throw savingFailure(primary,[cleanup],'Original unsent reservation cleanup failed')}throw primary}},
  async invokeLocal(identity){await current();const invocation=await original.invokeLocal(identity);try{await current();return invocation}catch(primary){try{await invocation.settle('unsent')}catch(cleanup){throw savingFailure(primary,[cleanup],'Original unsent invocation cleanup failed')}throw primary}},
 })
}
