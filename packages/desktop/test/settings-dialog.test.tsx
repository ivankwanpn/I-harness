// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { createPortal } from "react-dom"
import { SettingsDialog } from "../src/renderer/settings/SettingsDialog.tsx"
it("releases a hidden dialog layer while retaining its editor DOM and restores ownership on activation", () => {
  const close = vi.fn()
  const dialog = (active: boolean) => <SettingsDialog title="Retained editor" closeLabel="Close" initialFocusSelector="input" active={active} onClose={close}><input aria-label="Draft" defaultValue="Retained draft" /></SettingsDialog>
  const view = render(dialog(true))
  const input = screen.getByRole("textbox", { name: "Draft" }) as HTMLInputElement
  fireEvent.change(input, { target: { value: "Unsaved text" } })
  view.rerender(dialog(false))
  expect(screen.queryByRole("dialog")).toBeNull()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(close).not.toHaveBeenCalled()
  view.rerender(dialog(true))
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input)
  expect(input.value).toBe("Unsaved text")
  expect(document.activeElement).toBe(input)
  fireEvent.keyDown(document, { key: "Escape" })
  expect(close).toHaveBeenCalledOnce()
})

afterEach(cleanup)

it("leaves Escape to IME composition and its late closing keydown", async () => {
  const close = vi.fn()
  render(<SettingsDialog title="Edit resource" closeLabel="Close editor" initialFocusSelector="textarea" onClose={close}><textarea aria-label="Content" /></SettingsDialog>)
  const editor = screen.getByRole("textbox", { name: "Content" })
  await waitFor(() => expect(document.activeElement).toBe(editor))
  fireEvent.compositionStart(editor)
  fireEvent.keyDown(editor, { key: "Escape" })
  expect(close).not.toHaveBeenCalled()
  fireEvent.compositionEnd(editor)
  fireEvent.keyDown(editor, { key: "Escape" })
  expect(close).not.toHaveBeenCalled()
  fireEvent.keyUp(editor, { key: "Escape" })
  fireEvent.keyDown(editor, { key: "Escape" })
  expect(close).toHaveBeenCalledOnce()
})

it("ignores composing key events from engines that report keyCode 229", () => {
  const close = vi.fn()
  render(<SettingsDialog title="Edit resource" closeLabel="Close editor" initialFocusSelector="input" onClose={close}><input aria-label="Name" /></SettingsDialog>)
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape", keyCode: 229 })
  expect(close).not.toHaveBeenCalled()
})

it("gives only the foreground dialog document Escape ownership", () => {
  const closePreview = vi.fn(), closeEditor = vi.fn()
  render(<><SettingsDialog title="Preview" closeLabel="Close preview" initialFocusSelector="button" onClose={closePreview}><button>Edit</button></SettingsDialog>
    <SettingsDialog title="Editor" closeLabel="Close editor" initialFocusSelector="input" onClose={closeEditor}><input aria-label="Name" /></SettingsDialog></>)
  fireEvent.keyDown(document, { key: "Escape" })
  expect(closeEditor).toHaveBeenCalledOnce()
  expect(closePreview).not.toHaveBeenCalled()
})

it("keeps a busy foreground dialog open without dismissing the dialog behind it", () => {
  const closePreview = vi.fn(), closeEditor = vi.fn()
  render(<><SettingsDialog title="Preview" closeLabel="Close preview" initialFocusSelector="button" onClose={closePreview}><button>Edit</button></SettingsDialog>
    <SettingsDialog title="Editor" closeLabel="Close editor" busy initialFocusSelector="input" onClose={closeEditor}><input disabled aria-label="Name" /></SettingsDialog></>)
  fireEvent.keyDown(document, { key: "Escape" })
  expect(closeEditor).not.toHaveBeenCalled()
  expect(closePreview).not.toHaveBeenCalled()
  expect((screen.getByRole("button", { name: "Close editor" }) as HTMLButtonElement).disabled).toBe(true)
})

it("wraps keyboard focus past hidden and disabled controls", async () => {
  render(<SettingsDialog title="Editor" closeLabel="Close editor" initialFocusSelector="input" onClose={() => {}}>
    <input aria-label="Name" /><button disabled>Unavailable</button><button hidden>Hidden action</button>
    <details><summary>Advanced</summary><button>Collapsed action</button></details>
    <div style={{ display: "none" }}><button>Hidden by ancestor</button></div>
    <fieldset disabled><button>Disabled with group</button></fieldset>
  </SettingsDialog>)
  const dialog = screen.getByRole("dialog", { name: "Editor" })
  const close = within(dialog).getByRole("button", { name: "Close editor" })
  const advanced = within(dialog).getByText("Advanced")
  advanced.focus()
  fireEvent.keyDown(advanced, { key: "Tab" })
  expect(document.activeElement).toBe(close)
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true })
  expect(document.activeElement).toBe(advanced)
})

it("recovers escaped focus and traps a busy dialog with no available controls", () => {
  render(<><button>Background action</button><SettingsDialog title="Saving" closeLabel="Close saving" busy initialFocusSelector="input" onClose={() => {}}><input disabled aria-label="Name" /></SettingsDialog></>)
  const dialog = screen.getByRole("dialog", { name: "Saving" })
  screen.getByRole("button", { name: "Background action" }).focus()
  fireEvent.keyDown(document, { key: "Tab" })
  expect(document.activeElement).toBe(dialog)
  fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true })
  expect(document.activeElement).toBe(dialog)
})

it("excludes a nested disclosure summary while its outer details is closed", () => {
  render(<SettingsDialog title="Editor" closeLabel="Close editor" initialFocusSelector="button" onClose={() => {}}>
    <details><summary>Outer disclosure</summary>
      <details><summary>Inner hidden disclosure</summary><button>Hidden action</button></details>
    </details>
  </SettingsDialog>)
  const close = screen.getByRole("button", { name: "Close editor" })
  close.focus()
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true })
  expect(document.activeElement).toBe(screen.getByText("Outer disclosure"))
})

it("restores the invoking control when a dialog closes", async () => {
  const view = render(<section className="settings-pane"><button>Open editor</button></section>)
  const trigger = screen.getByRole("button", { name: "Open editor" })
  trigger.focus()
  view.rerender(<section className="settings-pane"><button>Open editor</button><SettingsDialog title="Editor" closeLabel="Close editor" initialFocusSelector="input" onClose={() => {}}><input aria-label="Name" /></SettingsDialog></section>)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox")))
  view.rerender(<section className="settings-pane"><button>Open editor</button></section>)
  expect(document.activeElement).toBe(trigger)
})

it("retains background isolation when an older overlapping dialog unmounts", () => {
  const content = (preview: boolean, editor: boolean) => <section className="settings-pane"><button>Open preview</button>
    {preview ? <SettingsDialog title="Preview" closeLabel="Close preview" initialFocusSelector="button" onClose={() => {}}><button>Edit</button></SettingsDialog> : null}
    {editor ? <SettingsDialog title="Editor" closeLabel="Close editor" initialFocusSelector="input" onClose={() => {}}><input aria-label="Name" /></SettingsDialog> : null}
  </section>
  const view = render(content(false, false))
  const trigger = screen.getByRole("button", { name: "Open preview" })
  trigger.focus()
  view.rerender(content(true, false))
  const edit = within(screen.getByRole("dialog", { name: "Preview" })).getByRole("button", { name: "Edit" })
  edit.focus()
  view.rerender(content(true, true))
  const background = view.container.querySelector(".settings-pane")!
  expect(background.hasAttribute("inert")).toBe(true)
  view.rerender(content(false, true))
  expect(background.hasAttribute("inert")).toBe(true)
  expect(document.activeElement).toBe(screen.getByRole("textbox"))
  view.rerender(content(false, false))
  expect(background.hasAttribute("inert")).toBe(false)
  expect(document.activeElement).toBe(trigger)
})

it("preserves an existing inert background after the final dialog closes", () => {
  const view = render(<section className="settings-pane" inert><SettingsDialog title="Editor" closeLabel="Close editor" initialFocusSelector="input" onClose={() => {}}><input aria-label="Name" /></SettingsDialog></section>)
  view.rerender(<section className="settings-pane" inert />)
  expect(view.container.querySelector(".settings-pane")?.hasAttribute("inert")).toBe(true)
})

it("lets a child menu consume Escape before the dialog", () => {
  const close = vi.fn()
  render(<SettingsDialog title="Editor" closeLabel="Close editor" initialFocusSelector="button" onClose={close}>
    <button onKeyDown={event => { if (event.key === "Escape") event.preventDefault() }}>Popup trigger</button>
  </SettingsDialog>)
  fireEvent.keyDown(screen.getByRole("button", { name: "Popup trigger" }), { key: "Escape" })
  expect(close).not.toHaveBeenCalled()
})

it("leaves a foreground portaled menu in charge of Escape and Tab", () => {
  const close = vi.fn()
  render(<><SettingsDialog title="Editor" closeLabel="Close editor" initialFocusSelector="input" onClose={close}><input aria-label="Name" /></SettingsDialog>
    {createPortal(<div role="menu"><button role="menuitem">Choose a model</button></div>, document.body)}</>)
  const item = screen.getByRole("menuitem")
  item.focus()
  fireEvent.keyDown(item, { key: "Escape" })
  expect(close).not.toHaveBeenCalled()
  fireEvent.keyDown(item, { key: "Tab" })
  expect(document.activeElement).toBe(item)
})
