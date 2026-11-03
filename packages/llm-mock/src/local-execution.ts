import { prepareModelRequest, preparedControls, preparedExecutionSource, snapshotModelData, type ModelClient, type PreparedModelRequest } from '@i-harness/llm-seam'

const clients = new WeakSet<ModelClient>(), identities = new WeakMap<object, ModelClient>(), preparedClients = new WeakMap<PreparedModelRequest, ModelClient>()
export function isMockClient(client: ModelClient): boolean { return clients.has(client) }
export function mockPreparedClient(prepared: PreparedModelRequest): ModelClient | undefined { return preparedClients.get(preparedExecutionSource(prepared)) }
export function mockExecutionClient(identity: object): ModelClient | undefined { return identities.get(identity) }

/** Private factory entry. Arbitrary clients cannot register a local identity. */
export function ownLocalMock(raw: ModelClient): ModelClient {
  const identity = Object.freeze({})
  const prepare: NonNullable<ModelClient['prepare']> = async request => {
      const captured = snapshotModelData(request), base = await prepareModelRequest(raw, { ...captured, generation: undefined })
      function decorate(prepared: PreparedModelRequest): PreparedModelRequest {
        const owned = Object.freeze({
          ...prepared, localExecutionIdentity: identity,
          withOutputCap: (cap: number | undefined) => decorate(prepared.withOutputCap(cap)),
          async *stream(control?: import('@i-harness/llm-seam').PreparedStreamControl) {
            const actual = preparedControls(captured, control)
            if (!actual.generation) { yield* prepared.stream(actual); return }
            const invocation = await actual.generation.invokeLocal(identity)
            let issued = false, settled = false
            try {
              actual.signal?.throwIfAborted(); actual.validateBeforeTransport?.()
              invocation.issue(); issued = true
              const { generation: _generation, confirmExecution: _confirm, ...standalone } = actual
              for await (const event of prepared.stream(standalone)) {
                if (event.type === 'end' || event.type === 'error') { await invocation.settle(event.type === 'end' ? 'completed' : 'failed'); settled = true }
                yield event
              }
            } finally { if (!settled) await invocation.settle(issued ? 'failed' : 'unsent') }
          },
        })
        preparedClients.set(owned, client)
        return owned
      }
      return decorate(base)
  }
  const client: ModelClient = { async *stream(request) {
    // Explicit standalone cassette invocation preserves its historical input
    // tolerance and closes over the actual factory implementation.
    if (!request.generation) { yield* raw.stream(request); return }
    yield* (await prepare(request)).stream({ generation: request.generation })
  }, prepare }
  clients.add(client); identities.set(identity, client)
  return client
}
