import { describe, expect, it } from "vitest"
import { aggregateErrors, errorCode, FactRecoveryRequiredError } from "../src/index.ts"

const coded = (code: string, message = code) => Object.assign(new Error(message), { code })

describe("errorCode", () => {
  it("reads a direct code and walks cause chains", () => {
    expect(errorCode(coded("FACT_CLOSED"))).toBe("FACT_CLOSED")
    const outer = new Error("outer", { cause: coded("FACT_RECOVERY_REQUIRED") })
    expect(errorCode(outer)).toBe("FACT_RECOVERY_REQUIRED")
  })

  it("finds a code inside an existing aggregate", () => {
    const aggregate = new AggregateError([new Error("cleanup"), coded("FACT_RECOVERY_REQUIRED")], "cleanup failed")
    expect(errorCode(aggregate)).toBe("FACT_RECOVERY_REQUIRED")
  })

  it("returns undefined for values without a code", () => {
    expect(errorCode(new Error("plain"))).toBeUndefined()
    expect(errorCode("text")).toBeUndefined()
    expect(errorCode(undefined)).toBeUndefined()
  })
})

describe("aggregateErrors", () => {
  it("keeps the recovery gate visible on the aggregate itself", () => {
    const aggregate = aggregateErrors([new FactRecoveryRequiredError()], "Managed restored read/document cleanup unresolved")
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect(aggregate.message).toBe("Managed restored read/document cleanup unresolved")
    expect(errorCode(aggregate)).toBe("FACT_RECOVERY_REQUIRED")
    expect((aggregate as { code?: string }).code).toBe("FACT_RECOVERY_REQUIRED")
  })

  it("finds a nested recovery code", () => {
    const nested = new AggregateError([new FactRecoveryRequiredError()], "inner")
    expect((aggregateErrors([new Error("other"), nested], "outer") as { code?: string }).code).toBe("FACT_RECOVERY_REQUIRED")
  })

  it("does not invent a code for ordinary cleanup failures", () => {
    const aggregate = aggregateErrors([coded("EPERM"), new Error("close failed")], "cleanup unresolved")
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect((aggregate as { code?: string }).code).toBeUndefined()
    expect(errorCode(aggregate)).toBe("EPERM")
  })
})
