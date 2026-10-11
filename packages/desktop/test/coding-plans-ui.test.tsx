// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CodingPlans } from "../src/renderer/settings/CodingPlans.tsx"
import { SettingsPane } from "../src/renderer/settings/SettingsPane.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"
import type { DesktopRequest } from "../src/shared/bridge.ts"
import type { CodingPlanAccount, CodingPlansRequest, CodingPlansState } from "../src/shared/coding-plans.ts"

const account: CodingPlanAccount = { id: "account-1", provider: "openai-codex", email: "person@example.test", label: "Personal", status: "connected", models: [{ id: "model-one", name: "First model" }, { id: "model-two", name: "Second model" }] }
const empty: CodingPlansState = { accounts: [], welcomePending: false }
const connected: CodingPlansState = { accounts: [account], welcomePending: false }
const management: CodingPlansState = { ...connected, openaiManagement: { status: "connected", accountId: "account-1", email: "person@example.test", plan: "Pro", availableCount: 2, windows: [{ name: "Weekly", usedPercent: 65, resetsAt: 1792000000000 }], credits: [{ id: "credit-1", status: "available", resetType: "codex_rate_limits", title: "Weekly reset", expiresAt: 1793000000000 }, { id: "credit-2", status: "available", resetType: "codex_rate_limits", title: "Second reset" }] } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => useLocale.getState().setLocale("en"))
afterEach(() => { cleanup(); vi.useRealTimers(); useLocale.getState().setLocale("zh-TW") })

it("shows identity-only sign-in without offering inference or invented account quota", async () => {
  const request = vi.fn(async () => ({ ...connected, accounts: [{ ...account, status: "identity-only" as const }] }))
  render(<CodingPlans request={request} />)
  await screen.findByText("person@example.test")
  expect(screen.getByText("Identity only")).toBeTruthy()
  expect(screen.queryByRole("combobox", { name: /Codex subscription model/ })).toBeNull()
  expect(screen.queryByRole("button", { name: "Use model" })).toBeNull()
  expect(screen.queryByText(/\$\d|\d+%/i)).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Authorize plan access" }))
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/coding-plans/start", accountId: "account-1" })
})

it("navigates to model management without selecting models or opening usage in a browser", async () => {
  const request = vi.fn(async () => connected)
  const onManageModels = vi.fn()
  render(<CodingPlans request={request} onManageModels={onManageModels} />)
  fireEvent.click(await screen.findByRole("button", { name: "Manage models" }))
  expect(onManageModels).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole("combobox", { name: /Codex subscription model/ })).toBeNull()
  expect(screen.queryByRole("button", { name: "Use model" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Refresh models" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Manage usage" })).toBeNull()
  expect(request.mock.calls).toEqual([[{ kind: "desktop/coding-plans/state" }]])
})

it("opens Models and providers through the settings navigation callback", async () => {
  const previous = localStorage.getItem("ih:settings-section")
  localStorage.setItem("ih:settings-section", "coding-plans")
  const request = vi.fn(async (input: DesktopRequest) => input.kind === "desktop/coding-plans/state" ? management : input.kind === "desktop/global-provider/directory" ? [] : undefined)
  try {
    render(<SettingsPane bridge={{ request, onEvent: () => () => {} }} onClose={() => {}} />)
    fireEvent.click(await screen.findByRole("button", { name: "Manage models" }))
    await screen.findByRole("heading", { name: "Models and providers", level: 1 })
    expect(request).toHaveBeenCalledWith({ kind: "desktop/global-provider/directory" })
    expect(screen.queryByRole("heading", { name: "Plan limits" })).toBeNull()
  } finally { if (previous === null) localStorage.removeItem("ih:settings-section"); else localStorage.setItem("ih:settings-section", previous) }
})

it("cancels pending login and discards a poll that arrives after cancellation", async () => {
  vi.useFakeTimers()
  const stale = deferred<CodingPlansState>()
  let reads = 0
  const pending: CodingPlansState = { ...empty, login: { status: "pending" } }
  const request = vi.fn((action: CodingPlansRequest) => action.kind === "desktop/coding-plans/cancel" ? Promise.resolve(empty) : ++reads === 1 ? Promise.resolve(pending) : stale.promise)
  render(<CodingPlans request={request} />)
  await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }))
  await act(async () => {})
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull()
  await act(async () => stale.resolve(pending))
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull()
  const calls = request.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(request.mock.calls).toHaveLength(calls)
})

it("discards an old connection response and stops polling after unmount", async () => {
  vi.useFakeTimers()
  const stale = deferred<CodingPlansState>()
  const oldRequest = vi.fn(() => stale.promise)
  const newRequest = vi.fn(async () => empty)
  const view = render(<CodingPlans request={oldRequest} />)
  view.rerender(<CodingPlans request={newRequest} />)
  await act(async () => {})
  await act(async () => stale.resolve({ ...connected, login: { status: "pending" } }))
  expect(screen.queryByText("person@example.test")).toBeNull()
  view.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(oldRequest).toHaveBeenCalledTimes(1)
  expect(newRequest).toHaveBeenCalledTimes(1)
})

it("persists welcome dismissal and reports failed actions without dropping account state", async () => {
  const request = vi.fn(async (action: CodingPlansRequest) => {
    if (action.kind === "desktop/coding-plans/welcome-dismiss") return management
    if (action.kind === "desktop/coding-plans/management-refresh") throw new Error("Usage unavailable")
    return { ...management, welcomePending: true }
  })
  render(<CodingPlans request={request} />)
  await screen.findByRole("dialog", { name: "Your Codex subscription is connected" })
  fireEvent.click(screen.getByRole("button", { name: "Got it" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/coding-plans/welcome-dismiss" })
  fireEvent.click(screen.getByRole("button", { name: "Refresh allowances and reset cards" }))
  expect((await screen.findByRole("alert")).textContent).toContain("Usage unavailable")
  expect(screen.getByText("person@example.test")).toBeTruthy()
})

it("cancels while the browser-start response is still pending and ignores its late success", async () => {
  const starting = deferred<CodingPlansState>()
  const request = vi.fn((action: CodingPlansRequest) => action.kind === "desktop/coding-plans/start" ? starting.promise : Promise.resolve(empty))
  render(<CodingPlans request={request} />)
  await waitFor(() => expect((screen.getByRole("button", { name: "Continue with ChatGPT" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }))
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }))
  await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull())
  await act(async () => starting.resolve(connected))
  expect(screen.queryByText("person@example.test")).toBeNull()
})

it("retries initial loading and can reauthorize and sign out the matching account", async () => {
  let reads = 0
  const expired: CodingPlansState = { ...connected, accounts: [{ ...account, status: "reauth-required" }] }
  const request = vi.fn(async (action: CodingPlansRequest) => {
    if (action.kind === "desktop/coding-plans/state" && ++reads === 1) throw new Error("Connection unavailable")
    if (action.kind === "desktop/coding-plans/signout") return empty
    return expired
  })
  render(<CodingPlans request={request} />)
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }))
  fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }))
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "desktop/coding-plans/start", accountId: "account-1" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "Sign out" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
  await waitFor(() => expect(screen.queryByText("person@example.test")).toBeNull())
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/coding-plans/signout", accountId: "account-1" })
})

it("uses fast polling only for pending authorization and pauses when settings are inactive", async () => {
  vi.useFakeTimers()
  let reads = 0
  const request = vi.fn(async () => ++reads === 1 ? { ...empty, login: { status: "pending" as const } } : connected)
  const view = render(<CodingPlans request={request} />)
  await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(screen.getByText("person@example.test")).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(request).toHaveBeenCalledTimes(2)
  view.rerender(<CodingPlans request={request} active={false} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(request).toHaveBeenCalledTimes(2)
})

it("reads connected state every minute for backend freshness and stops when inactive", async () => {
  vi.useFakeTimers()
  const request = vi.fn(async (_input: CodingPlansRequest) => management)
  const view = render(<CodingPlans request={request} />)
  await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })
  expect(request).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls.every(([input]) => input.kind === "desktop/coding-plans/state")).toBe(true)
  view.rerender(<CodingPlans request={request} active={false} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
  expect(request).toHaveBeenCalledTimes(2)
})

it("shows inline remaining allowance, localized reset countdowns and a single account identity", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"))
  const request = vi.fn(async () => ({ ...management, openaiManagement: { ...management.openaiManagement!, windows: [{ name: "7 days", usedPercent: 23, resetsAt: Date.now() + 90 * 60_000 }, { name: "5 hours", usedPercent: Number.NaN }] } }))
  render(<CodingPlans request={request} />)
  await act(async () => {})
  expect(screen.getByRole("progressbar", { name: "Weekly allowance remaining" }).getAttribute("value")).toBe("77")
  expect(screen.getByText("77% remaining")).toBeTruthy()
  expect(screen.getByText("Resets in 1h 30m")).toBeTruthy()
  expect(screen.getByText("5-hour allowance")).toBeTruthy()
  expect(screen.getAllByRole("progressbar")).toHaveLength(1)
  expect(screen.getAllByText("person@example.test")).toHaveLength(1)
  expect(screen.queryByText("account-1")).toBeNull()
  expect(screen.queryByRole("button", { name: "Continue with ChatGPT" })).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  await act(async () => useLocale.getState().setLocale("zh-TW"))
  expect(screen.getByRole("progressbar", { name: "剩餘額度：每週額度" })).toBeTruthy()
  expect(screen.getByText("1 小時 30 分鐘後重置")).toBeTruthy()
})

it("uses provider window duration for labels and does not reset values when the reset time is reached", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"))
  const request = vi.fn(async () => ({ ...management, openaiManagement: { ...management.openaiManagement!, windows: [{ name: "7 days", limitSeconds: 18000, usedPercent: 100, resetsAt: Date.now() - 1 }, { name: "5 hours", limitSeconds: 604800, usedPercent: 23 }] } }))
  render(<CodingPlans request={request} />)
  await act(async () => {})
  expect(screen.getByRole("progressbar", { name: "5-hour allowance remaining" }).getAttribute("value")).toBe("0")
  expect(screen.getByRole("progressbar", { name: "Weekly allowance remaining" }).getAttribute("value")).toBe("77")
  expect(screen.getByText("Reset time reached; awaiting an update")).toBeTruthy()
  expect(screen.getByText("Reset time not available")).toBeTruthy()
  expect(request.mock.calls).toEqual([[{ kind: "desktop/coding-plans/state" }]])
})

it("keeps main and named additional windows distinct when both have weekly limits", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"))
  render(<CodingPlans request={async () => ({ ...management, openaiManagement: { ...management.openaiManagement!, windows: [
    { name: "7 days", limitSeconds: 604800, usedPercent: 23, resetsAt: Date.now() + 60 * 60_000 },
    { name: "7 days", scopeName: "Codex Spark", limitSeconds: 604800, usedPercent: 60, resetsAt: Date.now() + 2 * 60 * 60_000 },
    { name: "Code review: 7 days", limitSeconds: 604800, usedPercent: 10, resetsAt: Date.now() + 3 * 60 * 60_000 },
  ] } })} />)
  await act(async () => {})
  expect(screen.getByRole("progressbar", { name: "Weekly allowance remaining" }).getAttribute("value")).toBe("77")
  expect(screen.getByRole("progressbar", { name: "Codex Spark · Weekly allowance remaining" }).getAttribute("value")).toBe("40")
  expect(screen.getByRole("progressbar", { name: "Code review · Weekly allowance remaining" }).getAttribute("value")).toBe("90")
  expect(screen.getByText("Resets in 1h 0m")).toBeTruthy()
  expect(screen.getByText("Resets in 2h 0m")).toBeTruthy()
  expect(screen.getByText("Resets in 3h 0m")).toBeTruthy()
  await act(async () => useLocale.getState().setLocale("zh-TW"))
  expect(screen.getByRole("progressbar", { name: "剩餘額度：Codex Spark · 每週額度" }).getAttribute("value")).toBe("40")
})

it.each([
  { plan: "pro", windows: [{ name: "primary", limitSeconds: 604800, usedPercent: 23 }], names: ["Weekly allowance remaining"] },
  { plan: "plus", windows: [{ name: "primary", limitSeconds: 18000, usedPercent: 50 }, { name: "secondary", limitSeconds: 604800, usedPercent: 23 }], names: ["5-hour allowance remaining", "Weekly allowance remaining"] },
])("renders only the provider-reported allowance windows for $plan", async ({ plan, windows, names }) => {
  render(<CodingPlans request={async () => ({ ...management, openaiManagement: { ...management.openaiManagement!, plan, windows } })} />)
  await screen.findByRole("heading", { name: "Plan limits" })
  expect(screen.getAllByRole("progressbar")).toHaveLength(names.length)
  for (const name of names) expect(screen.getByRole("progressbar", { name })).toBeTruthy()
  expect(screen.getByText(plan === "pro" ? "ChatGPT Pro" : "ChatGPT Plus")).toBeTruthy()
  if (plan === "pro") expect(screen.queryByText("5-hour allowance")).toBeNull()
})

it.each([
  [{ balance: "0" }, "Credit balance: 0"],
  [{ balance: "12.50" }, "Credit balance: 12.50"],
  [{ unlimited: true }, "Credits: unlimited"],
  [{ hasCredits: true }, undefined],
  [undefined, undefined],
] as const)("shows credit balance only when explicitly reported: %o", async (creditBalance, expected) => {
  render(<CodingPlans request={async () => ({ ...management, openaiManagement: { ...management.openaiManagement!, creditBalance } })} />)
  await screen.findByRole("heading", { name: "Plan limits" })
  if (expected) expect(screen.getByText(expected)).toBeTruthy()
  else expect(screen.queryByText(/Credit balance:|Credits: unlimited/)).toBeNull()
})

it("shows only reported management allowance and confirms the exact management account and credit", async () => {
  const request = vi.fn(async () => management)
  render(<CodingPlans request={request} />)
  const section = await screen.findByRole("region", { name: "Codex subscription allowance and reset cards" })
  expect(screen.getByText("person@example.test")).toBeTruthy()
  expect(within(section).getByText("35% remaining")).toBeTruthy()
  expect(within(section).getByText("Available reset cards: 2")).toBeTruthy()
  fireEvent.click(within(section).getAllByRole("button", { name: "Use reset card" })[0]!)
  const dialog = screen.getByRole("dialog", { name: "Confirm reset card" })
  expect(within(dialog).getByText("person@example.test")).toBeTruthy()
  expect(within(dialog).getByText("account-1")).toBeTruthy()
  expect(within(dialog).getByText("Weekly reset")).toBeTruthy()
  expect(within(dialog).getByText("credit-1")).toBeTruthy()
  expect(request.mock.calls).toHaveLength(1)
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and use card" }))
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "desktop/coding-plans/reset-credit", accountId: "account-1", creditId: "credit-1", confirmed: true }))
})

it("uses one Codex subscription login for models and allowance without secondary account controls", async () => {
  render(<CodingPlans request={async () => management} />)
  await screen.findByRole("region", { name: "Codex subscription allowance and reset cards" })
  expect(screen.getByRole("option", { name: "OpenAI / Codex" })).toBeTruthy()
  expect(screen.getByRole("heading", { name: "OpenAI / ChatGPT (Codex subscription)" })).toBeTruthy()
  expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1)
  expect(screen.queryByRole("button", { name: /management account|management authorization/i })).toBeNull()
  expect(screen.queryByText(/separately authorized|matched by email/i)).toBeNull()
})

it("does not offer reset cards for an account ID that differs from the primary Codex connection", async () => {
  render(<CodingPlans request={async () => ({ ...management, openaiManagement: { ...management.openaiManagement!, accountId: "different-account" } })} />)
  await screen.findByText("person@example.test")
  expect(screen.queryByRole("button", { name: "Use reset card" })).toBeNull()
})

it("keeps unknown management counts unknown and retries only the pending credit", async () => {
  const request = vi.fn(async () => ({ ...management, openaiManagement: { ...management.openaiManagement!, availableCount: undefined, windows: undefined, pendingRedemption: { requestId: "request-1", creditId: "credit-1" }, outcome: "unknown" as const } }))
  render(<CodingPlans request={request} />)
  const section = await screen.findByRole("region", { name: "Codex subscription allowance and reset cards" })
  expect(within(section).queryByText(/Available reset cards: 0|remaining/)).toBeNull()
  expect(within(section).getByText("Available reset cards: unknown")).toBeTruthy()
  expect(within(section).getByText(/The reset result is unknown/)).toBeTruthy()
  expect((within(section).getByRole("button", { name: "Use reset card" }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(section).getByRole("button", { name: "Retry this card" }))
  fireEvent.click(screen.getByRole("button", { name: "Confirm and use card" }))
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "desktop/coding-plans/reset-credit", accountId: "account-1", creditId: "credit-1", confirmed: true }))
})

it("polls the primary Codex device login and cancels it without allowing a stale poll to restore it", async () => {
  vi.useFakeTimers()
  const stale = deferred<CodingPlansState>()
  let reads = 0
  const pending: CodingPlansState = { ...empty, openaiManagement: { status: "pending", login: { userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/codex/device" } } }
  const request = vi.fn((input: CodingPlansRequest) => input.kind === "desktop/coding-plans/cancel" ? Promise.resolve({ ...empty, openaiManagement: { status: "disconnected" as const } }) : ++reads === 1 ? Promise.resolve(pending) : stale.promise)
  render(<CodingPlans request={request} />)
  await act(async () => {})
  const primary = screen.getByRole("region", { name: "OpenAI / ChatGPT (Codex subscription)" })
  expect(within(primary).getByText("ABCD-EFGH")).toBeTruthy()
  expect(within(primary).getByRole("button", { name: "Copy verification code" })).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }))
  await act(async () => {})
  await act(async () => stale.resolve(pending))
  expect(screen.queryByText("ABCD-EFGH")).toBeNull()
  expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeTruthy()
})

it("shows expired and redeemed cards without redemption actions and never infers unknown allowance", async () => {
  const request = vi.fn(async () => ({ ...management, openaiManagement: { ...management.openaiManagement!, windows: [{ name: "Unreported", usedPercent: Number.NaN }], credits: [{ id: "expired", status: "expired", resetType: "codex_rate_limits", expiresAt: 1 }, { id: "redeemed", status: "redeemed", resetType: "codex_rate_limits" }] } }))
  render(<CodingPlans request={request} />)
  const section = await screen.findByRole("region", { name: "Codex subscription allowance and reset cards" })
  expect(within(section).getByText(/Expired/)).toBeTruthy()
  expect(within(section).getByText(/Redeemed/)).toBeTruthy()
  expect(within(section).getByText("Allowance unknown")).toBeTruthy()
  expect(within(section).queryByRole("button", { name: "Use reset card" })).toBeNull()
})

it.each([
  { resetType: "future_type", expiresAt: Date.now() + 60_000 },
  { resetType: "codex_rate_limits", expiresAt: 1 },
])("disables fresh redemption for unsupported or expired available cards: %o", async credit => {
  const request = vi.fn(async () => ({ ...management, openaiManagement: { ...management.openaiManagement!, credits: [{ id: "unavailable-card", status: "available", title: "Unavailable card", ...credit }] } }))
  render(<CodingPlans request={request} />)
  const section = await screen.findByRole("region", { name: "Codex subscription allowance and reset cards" })
  const button = within(section).getByRole("button", { name: "Use reset card" }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  if (credit.resetType === "future_type") expect(within(section).getByText(/Unavailable in I-harness/)).toBeTruthy()
  fireEvent.click(button)
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(within(section).queryByText(/codex_rate_limits/)).toBeNull()
})

it("can retry the pending card even when its type is no longer supported", async () => {
  const request = vi.fn(async () => ({ ...management, openaiManagement: { ...management.openaiManagement!, credits: [{ id: "credit-1", status: "available", resetType: "future_type", expiresAt: 1 }], pendingRedemption: { creditId: "credit-1", requestId: "previously-confirmed" }, outcome: "unknown" as const } }))
  render(<CodingPlans request={request} />)
  fireEvent.click(await screen.findByRole("button", { name: "Retry this card" }))
  fireEvent.click(screen.getByRole("button", { name: "Confirm and use card" }))
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "desktop/coding-plans/reset-credit", accountId: "account-1", creditId: "credit-1", confirmed: true }))
})

it.each([
  ["reset", "Allowance reset confirmed."],
  ["nothing_to_reset", "There is currently no allowance to reset."],
  ["no_credit", "The service reported no available reset card."],
  ["already_redeemed", "This reset card has already been redeemed."],
] as const)("reports %s without claiming a different redemption outcome", async (outcome, expected) => {
  render(<CodingPlans request={async () => ({ ...management, openaiManagement: { ...management.openaiManagement!, outcome } })} />)
  expect(await screen.findByText(expected)).toBeTruthy()
})
