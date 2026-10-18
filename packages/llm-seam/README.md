# Prepared execution ownership

Managed generation is supported by the actual built-in HTTP terminals and the
concrete Bedrock SDK terminal. Each immutable prepared candidate is bound privately
to its terminal. The terminal awaits the existing document's reservation, then runs
the current-input/Stop/deadline checks synchronously immediately before one handoff,
and settles that same attempt. Managed HTTP uses `redirect: error`; SDK construction
forces `maxAttempts: 1` and checks after credential/signing work in the installed
handler path. Protocol encoding, authentication and decoding stay in adapters.

The shared HTTP transport performs proxy lookup and dispatcher acquisition only at
execution. Its asynchronous preparation hook returns the synchronous final issue
function, which runs after those waits. Common seam import and model preparation do
not resolve a proxy, authenticate or send a request.

Trusted retry, wait, signal, request mapping and structured observation composition
preserve the actual inner path and final retry descriptor. `observeModelClient`
always invokes the inner stream. Generic `createPreparedPayload`, arbitrary
`withPreparedRequests`/`wrapPreparedRequest` callbacks and injected opaque fetch/send
implementations remain explicit standalone APIs and cannot obtain managed execution
merely by copying fields or mentioning a reservation callback. A copied prepared
object is not a managed capability. Standalone opaque clients retain conservative
invocation semantics without physical durability claims.

The `internal/bedrock-terminal` subpath is a deliberate package-private source
boundary used only by `llm-bedrock/src/sdk-terminal.ts`; it is not exported by the
public facade. It keeps SDK dependencies in their adapter. There is no public
terminal registrar. This supported API/ownership boundary is not a sandbox against
hostile JavaScript importing internal files or replacing global transport.

The built-in local mock owns a private client identity and private prepared-source
identity. Managed local binding requires both, together with explicit test-mock host
policy. Read-only `preparedExecutionSource` traces only existing trusted structured
wrapper composition; it cannot register an arbitrary source. Generic wrappers,
replaced streams and copied mock prepared objects do not inherit the local grant.
Local invocations remain separately bounded facts, never network/HTTP/SDK evidence.

Generation expiry closes permission for new sends in that action. It does not cancel
already accepted tool work or the entire host turn. A fresh next response needs its
own legitimate accepted-and-settled predecessor and current turn fence. Provider
silence clocks begin at actual issue, not while durable reservation is pending.
