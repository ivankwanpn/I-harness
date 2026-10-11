// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { UsageStatistics, type UsageStatisticsRequest } from "../src/renderer/settings/UsageStatistics.tsx"
import { usageDateRange } from "../src/renderer/settings/usage-statistics-helpers.ts"
import { useLocale } from "../src/renderer/design/i18n.ts"
import { SettingsPane } from "../src/renderer/settings/SettingsPane.tsx"
import { usageTokenSegments, usageTrendRuns } from "../src/renderer/settings/usage-statistics-helpers.ts"
import type { DesktopBridge } from "../src/shared/bridge.ts"
import type { UsageSnapshot, UsageTotals } from "../../usage-stats/src/types.ts"

const totals: UsageTotals = { requests: 2, completed: 1, failed: 1, cancelled: 0, inputTokens: 100, uncachedInputTokens: 20, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: null, totalTokens: 120, cacheHitRate: .8, measuredRequests: 1, cacheMeasuredRequests: 1, estimatedCostUsd: null, pricedRequests: 0, subscriptionRequests: 1 }
function fixture(): UsageSnapshot { return { generatedAt: Date.now(), summary: totals, daily: [{ ...totals, date: "2026-10-11" }], models: [{ ...totals, key: "gpt-test", label: "gpt-test" }], providers: [{ ...totals, key: "openai", label: "openai" }], records: [{ id: "request-1", startedAt: Date.now(), durationMs: 1200, workspace: "workspace-a", providerId: "openai", modelId: "gpt-test", billing: "subscription", status: "completed", totalInputTokens: 100, uncachedInputTokens: 20, totalTokens: 120, estimatedCostUsd: null, inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, inputTokenSemantics: "includes-cache" }], totalRecords: 26, page: 1, pageSize: 25, options: { projects: ["project-a"], workspaces: ["workspace-a"], providers: ["openai"], models: ["gpt-test"] }, prices: [], warnings: [] } }
beforeEach(() => useLocale.getState().setLocale("en"))
afterEach(() => { cleanup(); useLocale.getState().setLocale("zh-TW") })

it("resolves presets and inclusive custom dates using local calendar midnights", () => {
  const now = new Date(2026, 9, 11, 17)
  expect(usageDateRange("7", "", "", now)).toEqual({ start: new Date(2026, 9, 5).getTime(), end: new Date(2026, 9, 12).getTime() })
  expect(usageDateRange("custom", "2026-10-01", "2026-10-03", now)).toEqual({ start: new Date(2026, 9, 1).getTime(), end: new Date(2026, 9, 4).getTime() })
  expect(usageDateRange("custom", "2026-10-04", "2026-10-03", now)).toBeNull()
})
it("preserves unavailable measurements and exposes coverage and subscription detail", async () => {
  render(<UsageStatistics active request={async () => fixture()} />)
  await screen.findByText("1 / 2 requests measured")
  expect(within(screen.getByTestId("usage-cost")).getByText("Unavailable")).toBeTruthy()
  fireEvent.click(screen.getByRole("tab", { name: "Requests" }))
  fireEvent.click(screen.getByRole("button", { name: "View request request-1" }))
  const dialog = await screen.findByRole("dialog", { name: "Request details" })
  expect(within(dialog).getByText("Subscription · no API cost estimate")).toBeTruthy()
  expect(within(dialog).getByText("Unavailable")).toBeTruthy()
})
it("queries selected filters and paginates records without changing summary scope", async () => {
  const request = vi.fn(async (_request: UsageStatisticsRequest) => fixture())
  render(<UsageStatistics active request={request} />)
  await screen.findByText("1 / 2 requests measured")
  fireEvent.change(screen.getByRole("combobox", { name: "Workspace" }), { target: { value: "workspace-a" } })
  await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ workspace: "workspace-a", page: 1 }) })))
  fireEvent.click(screen.getByRole("tab", { name: "Requests" }))
  fireEvent.click(screen.getByRole("button", { name: "Next page" }))
  await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ workspace: "workspace-a", page: 2 }) })))
})
it("retains the previous snapshot after refresh failure and recovers on retry", async () => {
  let fail = false
  render(<UsageStatistics active request={async () => { if (fail) throw new Error("disk unavailable"); return fixture() }} />)
  await screen.findByText("1 / 2 requests measured")
  fail = true
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("disk unavailable"))
  expect(screen.getByText("1 / 2 requests measured")).toBeTruthy()
  fail = false
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
})
it("does not load while inactive and ignores responses from an older filter", async () => {
  const pending: Array<(snapshot: UsageSnapshot) => void> = []
  const request = vi.fn(() => new Promise<UsageSnapshot>(resolve => pending.push(resolve)))
  const view = render(<UsageStatistics active={false} request={request} />)
  expect(request).not.toHaveBeenCalled()
  view.rerender(<UsageStatistics active request={request} />)
  await waitFor(() => expect(pending).toHaveLength(1))
  fireEvent.click(screen.getByRole("button", { name: "Today" }))
  await waitFor(() => expect(pending).toHaveLength(2))
  await act(async () => pending[1]!({ ...fixture(), summary: { ...totals, requests: 9 } }))
  await act(async () => pending[0]!(fixture()))
  expect(within(screen.getByTestId("usage-requests")).getByText("9")).toBeTruthy()
})

it("opens global usage statistics from settings without an active workspace", async () => {
  localStorage.clear()
  const request = vi.fn(async (value: { kind: string }) => value.kind === "desktop/usage/query" ? fixture() : undefined)
  render(<SettingsPane onClose={() => {}} bridge={{ request, onEvent: () => () => {} } as DesktopBridge} />)
  fireEvent.click(screen.getByRole("button", { name: "Usage statistics" }))
  await screen.findByText("1 / 2 requests measured")
  expect(screen.getByRole("heading", { name: "Usage statistics", level: 1 })).toBeTruthy()
  expect(screen.queryByText("Select a workspace to use this setting.")).toBeNull()
})

it("uses every scope filter, validates custom dates and supports request sorting", async () => {
  const request = vi.fn(async (_request: UsageStatisticsRequest) => fixture())
  render(<UsageStatistics active request={request} />)
  await screen.findByText("1 / 2 requests measured")
  for (const [name, value] of [["Project", "project-a"], ["Provider", "openai"], ["Model", "gpt-test"]]) fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } })
  await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ projectId: "project-a", providerId: "openai", modelId: "gpt-test" }) })))
  fireEvent.click(screen.getByRole("button", { name: "Custom" }))
  fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-10-05" } })
  fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-03" } })
  await screen.findByText("Choose a valid date range (up to 366 days).")
  fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-08" } })
  await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ start: new Date(2026, 9, 5).getTime(), end: new Date(2026, 9, 9).getTime() }) })))
  fireEvent.click(screen.getByRole("tab", { name: "Requests" }))
  fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "tokens" } })
  await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ sort: "tokens", page: 1 }) })))
})

it("supports keyboard tab selection and rejects ranges beyond the storage limit", async () => {
  expect(usageDateRange("custom", "2025-01-01", "2026-10-03")).toBeNull()
  render(<UsageStatistics active request={async () => fixture()} />)
  await screen.findByText("1 / 2 requests measured")
  const models = screen.getByRole("tab", { name: "Models" })
  models.focus()
  fireEvent.keyDown(models, { key: "ArrowRight" })
  expect(screen.getByRole("tab", { name: "Providers" }).getAttribute("aria-selected")).toBe("true")
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Providers" }))
})

it("records explicit zero prices while leaving blank cache rates unknown", async () => {
  const request = vi.fn(async (_request: UsageStatisticsRequest) => fixture())
  render(<UsageStatistics active request={request} />)
  await screen.findByText("1 / 2 requests measured")
  fireEvent.click(screen.getByRole("button", { name: "API pricing" }))
  const dialog = screen.getByRole("dialog", { name: "API pricing" })
  fireEvent.change(within(dialog).getByLabelText("Input / million"), { target: { value: "0" } })
  fireEvent.change(within(dialog).getByLabelText("Output / million"), { target: { value: "4.5" } })
  fireEvent.change(within(dialog).getByLabelText("Price source"), { target: { value: "Manual test tariff" } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Save pricing" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  const mutation = request.mock.calls.map(([value]) => value).find(value => value.kind === "desktop/usage/pricing")
  expect(mutation).toMatchObject({ price: { inputPerMillion: 0, outputPerMillion: 4.5, source: "Manual test tariff" } })
  expect(mutation && mutation.kind === "desktop/usage/pricing" && mutation.price.cacheReadPerMillion).toBeUndefined()
})

it("shows an empty range separately from missing measurements and renders genuine zero costs", async () => {
  const empty = fixture()
  empty.summary = { ...totals, requests: 0, completed: 0, failed: 0, measuredRequests: 0, cacheMeasuredRequests: 0, subscriptionRequests: 0, totalTokens: 0, estimatedCostUsd: 0 }
  empty.daily = []; empty.models = []; empty.providers = []; empty.records = []; empty.totalRecords = 0
  render(<UsageStatistics active request={async () => empty} />)
  await screen.findByRole("heading", { name: "No requests in this range" })
  expect(within(screen.getByTestId("usage-cost")).getByText("$0.00")).toBeTruthy()
  expect(within(screen.getByTestId("usage-requests")).getByText("0")).toBeTruthy()
})

it("keeps failed pricing edits open and restores focus after Escape closes details", async () => {
  const request = async (value: UsageStatisticsRequest) => { if (value.kind === "desktop/usage/pricing") throw new Error("Cannot save pricing"); return fixture() }
  render(<UsageStatistics active request={request} />)
  await screen.findByText("1 / 2 requests measured")
  fireEvent.click(screen.getByRole("tab", { name: "Requests" }))
  const open = screen.getByRole("button", { name: "View request request-1" })
  open.focus(); fireEvent.click(open)
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(document.activeElement).toBe(open)
  fireEvent.click(screen.getByRole("button", { name: "API pricing" }))
  const dialog = screen.getByRole("dialog", { name: "API pricing" })
  for (const [label, value] of [["Input / million", "1"], ["Output / million", "4"], ["Price source", "manual"]]) fireEvent.change(within(dialog).getByLabelText(label!), { target: { value } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Save pricing" }))
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "Cannot save pricing")
  expect((within(dialog).getByLabelText("Input / million") as HTMLInputElement).value).toBe("1")
})

it("stacks only the same measured requests as total tokens, preserving unclassified input", () => {
  const mixed = { ...totals, requests: 2, measuredRequests: 1, totalTokens: 120, outputTokens: 120, chartTokens: { uncachedInputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 0, outputTokens: 20, unclassifiedTokens: 0 } }
  expect(usageTokenSegments(mixed)).toEqual([20, 80, 0, 20, 0])
  expect(usageTokenSegments(mixed).reduce<number>((sum, value) => sum + (value ?? 0), 0)).toBe(120)
  expect(usageTokenSegments({ ...totals, chartTokens: undefined })).toEqual([0, 0, 0, 0, 120])
  expect(usageTokenSegments({ ...totals, totalTokens: null, chartTokens: null })).toEqual([null, null, null, null, null])
})

it("clears an inspected chart date when the new range no longer contains it", async () => {
  render(<UsageStatistics active request={async () => fixture()} />)
  await screen.findByText("1 / 2 requests measured")
  const date = screen.getByRole("combobox", { name: "Inspect trend date" }) as HTMLSelectElement
  const oldDate = date.options[1]!.value
  fireEvent.change(date, { target: { value: oldDate } })
  expect(date.value).not.toBe("")
  fireEvent.click(screen.getByRole("button", { name: "Today" }))
  await waitFor(() => expect(date.options.length).toBe(2))
  expect(date.value).toBe("")
  expect(screen.queryByText(/with token measurements/)).toBeNull()
  expect(screen.queryByText(oldDate, { selector: ".usage-chart-value strong" })).toBeNull()
})

it("clears loading when a pending query is invalidated by custom dates", async () => {
  render(<UsageStatistics active request={() => new Promise(() => {})} />)
  fireEvent.click(screen.getByRole("button", { name: "Custom" }))
  fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-10-20" } })
  fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-01" } })
  expect(screen.getByRole("region", { name: "Usage statistics" }).getAttribute("aria-busy")).toBe("false")
})

it("distinguishes configured prices with insufficient measurements from unpriced requests", async () => {
  const snapshot = fixture()
  snapshot.records[0] = { ...snapshot.records[0]!, billing: "api", price: { providerId: "openai", modelId: "gpt-test", inputPerMillion: 1, outputPerMillion: 4, source: "manual", updatedAt: Date.now() } }
  render(<UsageStatistics active request={async () => snapshot} />)
  await screen.findByText("1 / 2 requests measured")
  fireEvent.click(screen.getByRole("tab", { name: "Requests" }))
  expect(screen.getByText("Estimate unavailable")).toBeTruthy()
  expect(screen.queryByText("Unpriced")).toBeNull()
})

it("switches between flat bars, total line and total area without bridging unknown values", async () => {
  expect(usageTrendRuns([20, null, 50, 60, null])).toEqual([[{ index: 0, value: 20 }], [{ index: 2, value: 50 }, { index: 3, value: 60 }]])
  const { container } = render(<UsageStatistics active request={async () => fixture()} />)
  await screen.findByText("1 / 2 requests measured")
  expect(container.querySelector(".usage-chart rect[rx]")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Line" }))
  expect(container.querySelector(".usage-trend-line")).toBeTruthy()
  expect(container.querySelector(".usage-chart rect")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Area" }))
  expect(container.querySelector(".usage-trend-area")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Bars" }))
  expect(container.querySelector(".usage-chart rect")).toBeTruthy()
})
