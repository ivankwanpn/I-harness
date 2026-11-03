import {expect,it} from 'vitest'
import * as generation from '../src/agent/tool-generation.ts'
it('rejects caller-shaped approval generations before granting managed reviewer context',()=>{
 const capture=(generation as any).captureManagedApprovalReviewerContext;expect(capture).toBeTypeOf('function');expect(()=>capture({},{})).toThrow()
})
