// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Dispatch, SetStateAction } from "react"
import { afterEach, expect, it } from "vitest"
import { SettingsDraftScope, useSettingsDraft } from "../src/renderer/settings/settings-drafts.tsx"

afterEach(cleanup)
it("applies a late functional update to its original scope without borrowing the current scope value", () => {
  let earlier!: Dispatch<SetStateAction<string>>
  function Form({ scope }: { scope: string }) {
    const [value, setValue] = useSettingsDraft(["test-form", scope], "")
    if (scope === "a") earlier = setValue
    return <input aria-label="Draft" value={value} onChange={event => setValue(event.target.value)} />
  }
  const owner = {}
  const view = render(<SettingsDraftScope owner={owner}><Form scope="a" /></SettingsDraftScope>)
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "A draft" } })
  const completeEarlier = earlier
  view.rerender(<SettingsDraftScope owner={owner}><Form scope="b" /></SettingsDraftScope>)
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "B draft" } })
  act(() => completeEarlier(previous => `${previous} completed`))
  expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("B draft")
  view.rerender(<SettingsDraftScope owner={owner}><Form scope="a" /></SettingsDraftScope>)
  expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("A draft completed")
})

it("checks the latest cached snapshot when an earlier owner acknowledges a pending save", () => {
  let acknowledge!: Dispatch<SetStateAction<string>>
  function Form() {
    const [value, setValue] = useSettingsDraft(["pending-form"], "")
    acknowledge = setValue
    return <input aria-label="Draft" value={value} onChange={event => setValue(event.target.value)} />
  }
  const owner = {}
  const first = render(<SettingsDraftScope owner={owner}><Form /></SettingsDraftScope>)
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Submitted draft" } })
  const completeEarlier = acknowledge
  first.unmount()
  render(<SettingsDraftScope owner={owner}><Form /></SettingsDraftScope>)
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Newer draft" } })
  act(() => completeEarlier(previous => previous === "Submitted draft" ? "" : previous))
  cleanup()
  render(<SettingsDraftScope owner={owner}><Form /></SettingsDraftScope>)
  expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("Newer draft")
})
