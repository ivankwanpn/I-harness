// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Button } from "../src/renderer/vendor/opencode/Button.tsx"

afterEach(cleanup)

it("blocks activation while loading and exposes the operation to assistive technology", () => {
  const activate = vi.fn()
  const view = render(<Button loading loadingLabel="Saving changes" onClick={activate}>Save changes</Button>)
  const button = screen.getByRole("button", { name: "Saving changes" }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.getAttribute("aria-busy")).toBe("true")
  fireEvent.click(button)
  expect(activate).not.toHaveBeenCalled()

  view.rerender(<Button loading={false} onClick={activate}>Save changes</Button>)
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  expect(activate).toHaveBeenCalledOnce()
})

it("preserves an explicit disabled state after loading completes", () => {
  const activate = vi.fn()
  const view = render(<Button disabled loading onClick={activate}>Remove resource</Button>)
  view.rerender(<Button disabled loading={false} onClick={activate}>Remove resource</Button>)
  const button = screen.getByRole("button", { name: "Remove resource" }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(activate).not.toHaveBeenCalled()
})

it("keeps an icon action named while loading without exposing decorative glyphs", () => {
  const view = render(<Button icon={<svg role="img"><title>Delete glyph</title></svg>} aria-label="Remove local version">Remove</Button>)
  expect(screen.getByRole("button", { name: "Remove local version" })).toBeTruthy()
  expect(screen.queryByRole("img", { name: "Delete glyph" })).toBeNull()
  view.rerender(<Button loading icon={<svg role="img"><title>Delete glyph</title></svg>} aria-label="Remove local version">Remove</Button>)
  expect(screen.getByRole("button", { name: "Remove local version" }).getAttribute("aria-busy")).toBe("true")
})

it("keeps ordinary actions out of form submission and permits an explicit submit action", () => {
  const submitted = vi.fn(event => event.preventDefault())
  render(<form onSubmit={submitted}><Button>Cancel</Button><Button type="submit">Save</Button></form>)
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(submitted).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(submitted).toHaveBeenCalledOnce()
})
