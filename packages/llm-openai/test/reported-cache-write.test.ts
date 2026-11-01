import {expect,it} from 'vitest'
import {mapUsage} from '../src/stream/usage.ts'
it.each([
 [{input_tokens:8,output_tokens:3,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}},{inputTokens:8,outputTokens:3,cacheReadTokens:0,cacheCreationTokens:0,inputTokenSemantics:'includes-cache'}],
 [{input_tokens:8,output_tokens:3,input_tokens_details:{cached_tokens:2,cache_write_tokens:1}},{inputTokens:8,outputTokens:3,cacheReadTokens:2,cacheCreationTokens:1,inputTokenSemantics:'includes-cache'}],
 [{input_tokens:8,input_tokens_details:{cached_tokens:0}},{inputTokens:8,cacheReadTokens:0,inputTokenSemantics:'includes-cache'}],
 [{input_tokens:8,input_tokens_details:{cache_write_tokens:3,cache_write_tokens_details:{ttl_30m_tokens:1,ttl_12h_tokens:2}}},{inputTokens:8,cacheCreationTokens:3,inputTokenSemantics:'includes-cache'}],
 [{input_tokens:8,input_tokens_details:{cache_write_tokens_details:{ttl_30m_tokens:1}}},{inputTokens:8,inputTokenSemantics:'includes-cache'}],
])('Responses maps only genuine aggregate cache accounting (%j)',(raw,expected)=>expect(mapUsage(raw)).toEqual(expected))
it.each([
 {cache_write_tokens:3,cache_write_tokens_details:{ttl_30m_tokens:1,ttl_12h_tokens:1}},
 {cache_write_tokens:1,cache_write_tokens_details:{ttl_30m_tokens:2}},
 {cache_write_tokens:1,cache_write_tokens_details:{ttl_30m_tokens:-1}},
 {cache_write_tokens:1,cache_write_tokens_details:'malformed'},
 {cache_write_tokens:'malformed'},
 {cached_tokens:7,cache_write_tokens:2},
 {cached_tokens:9},
 {cache_write_tokens:9},
])('Responses flags explicit malformed/contradictory accounting without fabricating a numeric sentinel (%j)',details=>{
 const usage=mapUsage({input_tokens:8,output_tokens:3,input_tokens_details:details})
 expect(usage).toMatchObject({measurementValidity:'invalid',inputTokens:8,outputTokens:3});expect(Object.values(usage!)).not.toContain(Number.NaN)
})
