import {expect,it} from 'vitest'
import {captureGenerationBudget} from '@i-harness/core-agent'

it.each([{purpose:'main',timeout:3_600_000},{purpose:'manual',timeout:3_600_000},{purpose:'title',timeout:30_000},{purpose:'approval',timeout:90_000},{purpose:'media',timeout:90_000}] as const)('original $purpose default window is captured without inventing attempts',({purpose,timeout})=>{
 expect(captureGenerationBudget(purpose,{},1000)).toEqual({startedAt:1000,expiresAt:1000+timeout,timeoutMs:timeout})
})
it.each([0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('original invalid timeout refuses (%s)',timeoutMs=>{
 expect(()=>captureGenerationBudget('main',{timeoutMs},1000)).toThrow(expect.objectContaining({code:'GENERATION_CLOCK_INVALID'}))
})
it.each([0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('original invalid attempt constraint refuses (%s)',maxAttempts=>{
 expect(()=>captureGenerationBudget('main',{maxAttempts},1000)).toThrow('Invalid generation attempt limit')
})
it('original timeout validation precedes the attempt constraint and rejects unsafe expiry',()=>{
 expect(()=>captureGenerationBudget('main',{timeoutMs:0,maxAttempts:0},1000)).toThrow(expect.objectContaining({code:'GENERATION_CLOCK_INVALID'}))
 expect(()=>captureGenerationBudget('main',{timeoutMs:2},Number.MAX_SAFE_INTEGER)).toThrow(expect.objectContaining({code:'GENERATION_CLOCK_INVALID'}))
 expect(captureGenerationBudget('main',{timeoutMs:10,maxAttempts:2},1000)).toEqual({startedAt:1000,expiresAt:1010,timeoutMs:10,maxAttempts:2})
})
