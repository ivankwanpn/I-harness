import { expectTypeOf, it } from "vitest"
import type {
  CompiledSandboxPolicy, ExecutionBackend, ExecutionHandle, ExecutionIo,
  ExecutionOutput, PreparedExecution, PreparedTransportExecution, ProcessSpec,
  TransportExecutionBackend, TransportExecutionHandle,
} from "@i-harness/sandbox"

it("exports byte transport contracts without requiring platform stream types", () => {
  expectTypeOf<ExecutionOutput>().toEqualTypeOf<{
    channel: "stdout" | "stderr" | "pty"; data: Uint8Array
  }>()
  expectTypeOf<ExecutionIo["output"]>().toEqualTypeOf<AsyncIterable<ExecutionOutput>>()
  expectTypeOf<ExecutionIo["write"]>().parameters.toEqualTypeOf<[Uint8Array]>()
  expectTypeOf<ExecutionIo["write"]>().returns.toEqualTypeOf<Promise<void>>()
  expectTypeOf<ExecutionIo["endInput"]>().parameters.toEqualTypeOf<[]>()
  expectTypeOf<ExecutionIo["endInput"]>().returns.toEqualTypeOf<Promise<void>>()
  expectTypeOf<ExecutionIo["resize"]>().toEqualTypeOf<((cols: number, rows: number) => Promise<void>) | undefined>()
  expectTypeOf<ExecutionIo["signal"]>().toEqualTypeOf<((signal: "INT" | "TERM" | "KILL") => Promise<void>) | undefined>()
})

it("refines preparation and commit while preserving the base lifecycle consumer", () => {
  expectTypeOf<TransportExecutionHandle>().toExtend<ExecutionHandle>()
  expectTypeOf<ExecutionHandle>().not.toExtend<TransportExecutionHandle>()
  expectTypeOf<TransportExecutionHandle["pid"]>().toEqualTypeOf<number>()
  expectTypeOf<TransportExecutionHandle["io"]>().toEqualTypeOf<ExecutionIo>()
  expectTypeOf<PreparedTransportExecution>().toExtend<PreparedExecution>()
  expectTypeOf<PreparedTransportExecution["commit"]>().parameter(0).toEqualTypeOf<() => void>()
  expectTypeOf<PreparedTransportExecution["commit"]>().returns.toEqualTypeOf<Promise<TransportExecutionHandle>>()
  expectTypeOf<TransportExecutionBackend>().toExtend<ExecutionBackend>()
  expectTypeOf<TransportExecutionBackend["prepare"]>().parameters.toEqualTypeOf<[ProcessSpec, CompiledSandboxPolicy, AbortSignal?]>()
  expectTypeOf<TransportExecutionBackend["prepare"]>().returns.toEqualTypeOf<Promise<PreparedTransportExecution>>()
})
