/** Private protocol, shared by the fixed worker and injected protocol tests. No native imports. */
export function createDrainWorkerProtocol({ epoch, capacity, send, drain, shutdown }) {
  const results = new Map()
  let highWater = 0n
  let closing = false
  const validId = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
  const validAddress = value => typeof value === 'bigint' && value > 0n && value < 0xffffffffffffffffn
  const refuse = (message, reason) => send({ type: 'protocol-error', epoch, id: message?.id, reason })
  return message => {
    if (!message || typeof message !== 'object' || message.epoch !== epoch) return refuse(message, 'wrong epoch')
    if (message.type === 'shutdown') {
      if (results.size) return refuse(message, 'unacknowledged results')
      closing = true
      send({ type: 'shutdown', epoch })
      shutdown()
      return
    }
    if (closing || !validId(message.id) || !validAddress(message.registration)) return refuse(message, 'invalid request')
    const prior = results.get(message.id)
    if (message.type === 'ack') {
      if (prior && prior.registration !== message.registration) return refuse(message, 'changed registration')
      if (!prior && BigInt(message.id) > highWater) return refuse(message, 'unknown acknowledgment')
      // Duplicate acknowledgment has no native side effect and may rejoin a lost handoff reply.
      if (prior?.reply.type === 'unknown') return refuse(message, 'unknown native outcome cannot be discarded')
      results.delete(message.id)
      send({ type: 'acknowledged', epoch, id: message.id })
      return
    }
    if (message.type !== 'drain') return refuse(message, 'unknown command')
    if (prior) {
      if (prior.registration !== message.registration) return refuse(message, 'changed registration')
      send(prior.reply)
      return
    }
    if (BigInt(message.id) <= highWater) return refuse(message, 'retired request cannot execute again')
    if (results.size >= capacity) return refuse(message, 'retirement capacity exceeded')
    highWater = BigInt(message.id)
    // Record original identity before native issue. A throw never authorizes a second issue.
    const entry = { registration: message.registration, reply: { type: 'unknown', epoch, id: message.id, reason: 'native outcome unknown' } }
    results.set(message.id, entry)
    try {
      const status = drain(message.registration) // Synchronous only, in the worker's own N-API environment.
      if (!Number.isInteger(status) || status < 0 || status > 0xffffffff) throw new Error('invalid native DWORD')
      entry.reply = { type: 'result', epoch, id: message.id, status }
    } catch (error) {
      entry.reply = { type: 'unknown', epoch, id: message.id, reason: error instanceof Error ? error.message : 'native call threw' }
    }
    send(entry.reply)
  }
}
