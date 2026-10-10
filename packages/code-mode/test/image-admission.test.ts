import { expect, it } from 'vitest'
import { createCodeModeRuntime } from '../src/runtime.ts'
import { PNG } from '../../image-validation/test/fixtures.ts'

const bad = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

it('rejects the malformed PNG before persistence or a code_wait observation', async () => {
  const outputs: unknown[] = []
  const runtime = createCodeModeRuntime({ tools: () => [], invoke: async () => null, onEvent: event => { if (event.type === 'output') outputs.push(event.item) } })
  try {
    let result = await runtime.exec({ code: `await new Promise(r=>setTimeout(r,50)); image('data:image/png;base64,${bad}');`, yield_time_ms: 0 })
    while (result.status === 'running') result = await runtime.wait({ cell_id: result.cellId, yield_time_ms: 1000 })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/invalid image|checksum/i)
    expect(result.items.some(item => item.type === 'image')).toBe(false)
    expect(outputs).toEqual([])
  } finally { await runtime.dispose() }
})

it('admits valid image and surrounding text in order before successful store completion', async () => {
  const order: string[] = []
  const runtime = createCodeModeRuntime({tools:()=>[],invoke:async()=>null,
    onEvent: event => { if(event.type==='output') order.push(event.item.type==='text'?event.item.text:event.item.type) },
    commitStore: () => { order.push('commit') },
  })
  try {
    const first = await runtime.exec({code:`text('before'); image('data:image/png;base64,${PNG}'); text('after');store('x',1);`,yield_time_ms:5000})
    expect(first.status).toBe('completed')
    expect(order).toEqual(['before','image','after','commit'])
    expect(first.items).toEqual([{type:'text',text:'before'},{type:'image',image:{mediaType:'image/png',dataBase64:PNG}},{type:'text',text:'after'}])
  } finally { await runtime.dispose() }
})

it('cancels pending image admission without late persistence or store commit', async () => {
  const events: string[] = []
  let emitted!: () => void
  const started = new Promise<void>(resolve => { emitted = resolve })
  const runtime = createCodeModeRuntime({tools:()=>[],invoke:async()=>null,
    onEvent: event => { if(event.type==='output') {events.push(event.item.type);if(event.item.type==='text') emitted()} },
    commitStore: () => { events.push('commit') },
  })
  try {
    const first = await runtime.exec({code:`text('ready'); image('data:image/png;base64,${PNG}');store('x',1);`,yield_time_ms:0})
    await started
    await runtime.terminate(first.cellId,'human stop')
    const last = await runtime.wait({cell_id:first.cellId})
    expect(last.status).toBe('terminated')
    expect(last.items.every(item=>item.type!=='image')).toBe(true)
    expect(events).toEqual(['text'])
  } finally { await runtime.dispose() }
})
