import { expect, it } from 'vitest'
import { projectImagesForProvider, type LLMMessage } from '../src/index.ts'
import { PNG } from '../../image-validation/test/fixtures.ts'

it('preserves valid bytes and tool adjacency while explicitly quarantining only invalid parts', async () => {
  const messages: LLMMessage[] = [
    { role: 'assistant', content: 'checking', toolCalls: [{ id: 'c', name: 'read_image', args: {} }] },
    { role: 'tool', toolCallId: 'c', content: 'successful text' },
    { role: 'user', content: [{ type: 'image', image: { mediaType: 'image/png', dataBase64: 'YQ==' } }, { type: 'text', text: 'second image' }, { type: 'image', image: { mediaType: 'image/png', dataBase64: PNG } }] },
  ]
  const original = JSON.stringify(messages)
  const projected = await projectImagesForProvider(messages, true)
  expect(projected.slice(0,2)).toEqual(messages.slice(0,2))
  expect(projected[2].content).toEqual([
    { type:'text', text:expect.stringContaining('Image unavailable: Invalid image') },
    { type:'text', text:'second image' },
    { type:'image', image:{ mediaType:'image/png', dataBase64:PNG } },
  ])
  expect(JSON.stringify(messages)).toBe(original)
})
it('text-only replay safely represents a malformed historical image envelope', async () => {
  const messages = [{ role:'user', content:[{type:'image',image:null}] }] as unknown as LLMMessage[]
  expect(JSON.stringify(await projectImagesForProvider(messages,false))).toContain('model is text-only')
})
it('does not disguise caller cancellation as an unavailable image', async () => {
  const controller = new AbortController(); controller.abort(new Error('stop decoding'))
  const messages: LLMMessage[] = [{role:'user',content:[{type:'image',image:{mediaType:'image/png',dataBase64:PNG}}]}]
  await expect(projectImagesForProvider(messages,true,controller.signal)).rejects.toThrow('stop decoding')
})
