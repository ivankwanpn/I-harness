import { createInterface } from 'node:readline'

const flags = new Set(process.argv.slice(2))
let initialized = false

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function reject(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

// Fill stderr before reading any protocol input. A client that does not drain
// this stream cannot complete initialization.
if (flags.has('--large-stderr')) {
  await new Promise((resolve, reject) => {
    process.stderr.write('x'.repeat(2 * 1024 * 1024), error => error ? reject(error) : resolve())
  })
}

const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const frame = JSON.parse(line)
  if (frame.method === 'initialize') {
    initialized = true
    reply(frame.id, { name: 'fixture', version: '1', protocolVersion: 1, capabilities: {} })
    return
  }
  if (frame.method === 'shutdown') {
    if (frame.id !== undefined && flags.has('--legacy-shutdown')) {
      reject(frame.id, -32601, 'Use the shutdown notification')
      return
    }
    if (frame.id === undefined) process.stderr.write('LEGACY_SHUTDOWN_NOTIFICATION\n')
    else reply(frame.id, { ok: true })
    lines.close()
    process.stdin.destroy()
    return
  }
  if (!initialized) {
    reject(frame.id, -32600, 'Initialize first')
    return
  }
  if (frame.method === 'hang') return
  if (frame.method === 'session/prompt') {
    if (!flags.has('--expected-argv')) {
      reject(frame.id, -32602, 'Expected explicit fixture arguments')
      return
    }
    reply(frame.id, { ok: true })
    return
  }
  reject(frame.id, -32601, 'Unknown fixture method')
})
