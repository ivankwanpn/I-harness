import { describe, expect, it } from "vitest"
import { FrameDecoder, WorkerProtocol, decodeBase64, MAX_LINE_BYTES, MAX_CHUNK_BYTES } from "../src/protocol.ts"

const nonce = "test-nonce"
const digest = "a".repeat(64)
const frame = (type: string, extra = {}) => ({ v: 1, nonce, type, ...extra })
const line = (type: string, extra = {}) => Buffer.from(JSON.stringify(frame(type, extra)) + "\n")

describe("bounded worker framing", () => {
  it("retains partial lines and parses several complete frames", () => {
    const decoder = new FrameDecoder()
    const input = line("hello", { sha256: digest, workerPid: 5 })
    expect(decoder.feed(input.subarray(0, 10))).toEqual([])
    expect(decoder.feed(Buffer.concat([input.subarray(10), line("settled")]))).toEqual([
      frame("hello", { sha256: digest, workerPid: 5 }), frame("settled"),
    ])
    decoder.end()
  })
  it("refuses oversized unterminated input and truncated final frames", () => {
    expect(() => new FrameDecoder().feed(Buffer.alloc(MAX_LINE_BYTES + 1, 65))).toThrow(/limit/)
    const decoder = new FrameDecoder()
    decoder.feed(Buffer.from("{"))
    expect(() => decoder.end()).toThrow(/truncated/)
  })
  it("counts the newline in the line limit and rejects malformed UTF8", () => {
    expect(() => new FrameDecoder().feed(Buffer.concat([Buffer.alloc(MAX_LINE_BYTES, 32), Buffer.from("\n")]))).toThrow(/limit/)
    expect(() => new FrameDecoder().feed(Buffer.from([34, 255, 34, 10]))).toThrow(/Malformed/)
  })
  it("rejects noncanonical base64 and chunks over 32 KiB", () => {
    for (const invalid of ["%%%", "YQ", "YR==", "YQ==\n", "YQ===="])
      expect(() => decodeBase64(invalid)).toThrow(/base64/)
    expect(() => decodeBase64(Buffer.alloc(MAX_CHUNK_BYTES + 1).toString("base64"))).toThrow(/chunk/)
  })
})

describe("strict worker phases", () => {
  it("validates inventory counters on the prepared receipt", () => {
    const protocol = new WorkerProtocol(nonce, digest)
    protocol.receive(frame("hello", { sha256: digest, workerPid: 1 }))
    protocol.send("prepare")
    expect(protocol.receive(frame("prepared", { policyFingerprint: "fp", inventoryEntries: 9000, inventoryDirectories: 1000 }))).toMatchObject({ inventoryEntries: 9000 })
  })
  it("accepts bounded progress during prepare and commit without granting admission", () => {
    const protocol = new WorkerProtocol(nonce, digest)
    protocol.receive(frame("hello", { sha256: digest, workerPid: 1 }))
    protocol.send("prepare")
    expect(protocol.receive(frame("progress", { stage: "preparing" })).type).toBe("progress")
    expect(protocol.phase).toBe("preparing")
    protocol.receive(frame("prepared", { policyFingerprint: "fp" }))
    protocol.send("commit")
    expect(protocol.receive(frame("progress", { stage: "validating" })).type).toBe("progress")
    expect(protocol.phase).toBe("committing")
    expect(() => protocol.receive(frame("progress", { stage: "secret" }))).toThrow()
    protocol.send("shutdown")
    expect(protocol.receive(frame("settled")).type).toBe("settled")
  })
  it("refuses a foreign nonce, version, digest and impossible phase", () => {
    expect(() => new WorkerProtocol(nonce, digest).receive({ ...frame("hello"), nonce: "foreign" })).toThrow()
    expect(() => new WorkerProtocol(nonce, digest).receive({ ...frame("hello"), v: 2 })).toThrow()
    expect(() => new WorkerProtocol(nonce, digest).receive(frame("hello", { sha256: "b".repeat(64), workerPid: 1 }))).toThrow()
    expect(() => new WorkerProtocol(nonce, digest).receive(frame("settled"))).toThrow(/phase/)
  })
  it("encoded binary command text cannot forge a settled frame", () => {
    const protocol = new WorkerProtocol(nonce, digest)
    protocol.receive(frame("hello", { sha256: digest, workerPid: 1 }))
    protocol.send("prepare")
    protocol.receive(frame("prepared", { policyFingerprint: "fp" }))
    protocol.send("commit")
    protocol.receive(frame("started", { pid: 2 }))
    const data = Buffer.concat([Buffer.from([0, 255, 128]), line("settled")])
    const output = protocol.receive(frame("output", { channel: "stdout", data: data.toString("base64") }))
    expect(output.type).toBe("output")
    expect(decodeBase64((output as { data: string }).data)).toEqual(data)
    expect(protocol.phase).toBe("running")
    expect(() => protocol.receive(frame("settled"))).toThrow(/phase/)
    protocol.receive(frame("root", { exitCode: 0 }))
    protocol.receive(frame("settled"))
    expect(() => protocol.receive(frame("output", { channel: "stdout", data: "" }))).toThrow(/phase/)
  })
  it("allows prepared cancellation settlement without a fabricated root exit", () => {
    const protocol = new WorkerProtocol(nonce, digest)
    protocol.receive(frame("hello", { sha256: digest, workerPid: 1 }))
    protocol.send("prepare")
    protocol.receive(frame("prepared", { policyFingerprint: "fp" }))
    protocol.send("shutdown")
    protocol.receive(frame("settled"))
    expect(protocol.phase).toBe("settled")
  })
  it("recognizes prelaunch refusal acknowledgement without a started or root frame", () => {
    const protocol = new WorkerProtocol(nonce, digest)
    protocol.receive(frame("hello", { sha256: digest, workerPid: 1 }))
    protocol.send("prepare")
    expect(protocol.receive(frame("refused", { detail: "owned directory changed" }))).toEqual(frame("refused", { detail: "owned directory changed" }))
    expect(protocol.phase).toBe("refused")
    protocol.receive(frame("settled"))
    expect(protocol.phase).toBe("settled")
  })
  it("refused cannot replace settlement for an already-started workload", () => {
    const protocol = new WorkerProtocol(nonce, digest)
    protocol.receive(frame("hello", { sha256: digest, workerPid: 1 }))
    protocol.send("prepare"); protocol.receive(frame("prepared", { policyFingerprint: "fp" }))
    protocol.send("commit"); protocol.receive(frame("started", { pid: 2 }))
    expect(() => protocol.receive(frame("refused", { detail: "invented" }))).toThrow()
  })
})
