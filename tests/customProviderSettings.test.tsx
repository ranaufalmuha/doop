// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  accounts: vi.fn(),
  models: vi.fn(),
  connect: vi.fn(),
  patch: vi.fn(),
  disconnect: vi.fn(),
  setDefault: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: {
    modelAccounts: mocks.accounts,
    agentModels: mocks.models,
    connectCustomProvider: mocks.connect,
    updateCustomProvider: mocks.patch,
    disconnectCustomProvider: mocks.disconnect,
    setDefaultRunner: mocks.setDefault,
  },
}))
vi.mock('../src/lib/localAgent', () => ({
  useLocalAgent: () => ({ enabled: false }),
  selectLocalAgent: vi.fn(),
}))
vi.mock('../src/lib/store', () => ({ useStore: { getState: () => ({ allowanceChanged: vi.fn() }) } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/LocalClaude', () => ({ LocalClaudeRow: () => null }))
import type { ModelAccounts } from '../src/lib/api'
import { ModelAccountPanel } from '../src/components/ModelAccount'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MENUS = { chatgpt: [], 'openai-key': [], 'anthropic-key': [], 'openrouter-key': [], 'gemini-key': [], custom: [] }

const empty = (): ModelAccounts => ({
  accounts: [],
  chatgptEnabled: true,
  customEnabled: true,
  policy: 'public',
  menus: MENUS,
})

const connected = (overrides: Record<string, unknown> = {}): ModelAccounts => ({
  ...empty(),
  default: 'custom',
  accounts: [
    {
      kind: 'custom',
      enabled: true,
      label: '9Router',
      baseUrl: 'https://api.9router.dev',
      model: '9router/auto',
      vision: false,
      maxOutputTokens: 8192,
      connectedAt: 1,
      ...overrides,
    },
  ],
})

let root: Root
let container: HTMLDivElement
const row = () =>
  Array.from(container.querySelectorAll<HTMLElement>('[role="listitem"]')).find((el) =>
    el.textContent?.includes('Custom provider (OpenAI-compatible)'),
  )
/* modals render in a portal outside the container, so fields are document-wide */
const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!
const type = (id: string, value: string) =>
  act(async () => {
    const el = input(id)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
const openForm = async () => {
  const connect = Array.from(row()!.querySelectorAll('button')).find((b) => b.textContent === 'Connect')!
  await act(async () => connect.click())
}
const submit = async (label: string) => {
  /* the form's own button comes after the row's Connect, so take the last */
  const buttons = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent === label)
  await act(async () => buttons[buttons.length - 1]!.click())
}
async function openMenu(action: string) {
  act(() => {
    container
      .querySelector('[aria-label="More for 9Router"]')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (el) => el.textContent === action,
  )!
  await act(async () => item.click())
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.models.mockResolvedValue({ models: [], live: false })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('connects a custom provider from the form and never shows the key back', async () => {
  mocks.accounts.mockResolvedValue(empty())
  mocks.connect.mockResolvedValue(connected())
  await act(async () => root.render(<ModelAccountPanel />))

  await openForm()
  await type('custom-label', '9Router')
  await type('custom-url', 'https://api.9router.dev/v1')
  await type('custom-key', 'sk-secret-value')
  await type('custom-model', '9router/auto')
  await submit('Connect')

  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({
    baseUrl: 'https://api.9router.dev/v1',
    label: '9Router',
    apiKey: 'sk-secret-value',
    model: '9router/auto',
    vision: false,
    maxOutputTokens: 8192,
  })
  /* the connected row replaces the form: label, origin, budget and model */
  expect(container.textContent).toContain('9Router')
  expect(container.textContent).toContain('Default')
  expect(container.textContent).toContain('api.9router.dev')
  expect(container.textContent).toContain('8192 tokens')
  expect(container.textContent).toContain('9router/auto')
  /* a text-only model says so, as every other provider's row does */
  expect(container.textContent).toContain('no visual review')
  expect(container.textContent).not.toContain('sk-secret-value')
  expect(container.querySelector('#custom-key')).toBeNull()
})

it('validates the URL and budget before it calls the server', async () => {
  mocks.accounts.mockResolvedValue(empty())
  await act(async () => root.render(<ModelAccountPanel />))

  await openForm()
  await type('custom-label', '9Router')
  await type('custom-url', 'http://api.9router.dev/v1')
  await type('custom-budget', '999')
  await submit('Connect')

  expect(mocks.connect).not.toHaveBeenCalled()
  expect(container.textContent).toContain('This server does not allow http:// connections.')
  expect(container.textContent).toContain('Use a whole number between 1024 and 16000.')
  expect(input('custom-url').getAttribute('aria-invalid')).toBe('true')
  expect(input('custom-budget').getAttribute('aria-invalid')).toBe('true')
})

it('allows an http local origin under the private self-host policy', async () => {
  mocks.accounts.mockResolvedValue({ ...empty(), policy: 'private' })
  mocks.connect.mockResolvedValue(connected({ baseUrl: 'http://127.0.0.1:20128', label: 'Local 9Router' }))
  await act(async () => root.render(<ModelAccountPanel />))

  await openForm()
  await type('custom-label', 'Local 9Router')
  await type('custom-url', 'http://127.0.0.1:20128/v1')
  await submit('Connect')

  expect(mocks.connect).toHaveBeenCalledWith(
    expect.objectContaining({ baseUrl: 'http://127.0.0.1:20128/v1', label: 'Local 9Router' }),
  )
})

it('shows a rejected key under the key field and clears it on the next keystroke', async () => {
  const message = 'Authentication failed — check the API key.'
  mocks.accounts.mockResolvedValue(empty())
  mocks.connect.mockRejectedValue(Object.assign(new Error('400'), { body: { error: message } }))
  await act(async () => root.render(<ModelAccountPanel />))

  await openForm()
  await type('custom-label', '9Router')
  await type('custom-url', 'https://api.9router.dev/v1')
  await type('custom-key', 'sk-wrong')
  await submit('Connect')

  const alert = container.querySelector('[role="alert"]')!
  expect(alert.textContent).toBe(message)
  expect(input('custom-key').getAttribute('aria-invalid')).toBe('true')
  expect(input('custom-key').getAttribute('aria-describedby')).toBe(alert.id)
  /* the form stays open with what was typed, so the person can fix the key */
  expect(input('custom-key').value).toBe('sk-wrong')

  await type('custom-key', 'sk-wrong-2')
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('turns a connected provider off and on, and makes it the default', async () => {
  mocks.accounts.mockResolvedValue({ ...connected(), default: 'chatgpt' })
  mocks.patch.mockResolvedValue(connected({ enabled: false }))
  mocks.setDefault.mockResolvedValue(connected())
  await act(async () => root.render(<ModelAccountPanel />))

  await openMenu('Make default')
  expect(mocks.setDefault).toHaveBeenCalledExactlyOnceWith('custom')

  const toggle = container.querySelector<HTMLElement>('[role="switch"][aria-label="Use 9Router"]')!
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  await act(async () => toggle.click())
  expect(mocks.patch).toHaveBeenCalledExactlyOnceWith({ enabled: false })
  expect(container.textContent).toContain('Off')
})

it('replaces the key without re-entering the rest', async () => {
  mocks.accounts.mockResolvedValue(connected())
  mocks.connect.mockResolvedValue(connected({ label: '9Router 2' }))
  await act(async () => root.render(<ModelAccountPanel />))

  await openMenu('Replace key')
  /* the form arrives prefilled, with the key deliberately empty */
  expect(input('custom-replace-label').value).toBe('9Router')
  expect(input('custom-replace-url').value).toBe('https://api.9router.dev')
  expect(input('custom-replace-model').value).toBe('9router/auto')
  expect(input('custom-replace-key').value).toBe('')
  await type('custom-replace-key', 'sk-new')
  await submit('Save connection')
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({
    baseUrl: 'https://api.9router.dev',
    label: '9Router',
    apiKey: 'sk-new',
    model: '9router/auto',
    vision: false,
    maxOutputTokens: 8192,
  })
})

it('asks before disconnecting a custom provider', async () => {
  mocks.accounts.mockResolvedValue(connected())
  mocks.disconnect.mockResolvedValue(empty())
  await act(async () => root.render(<ModelAccountPanel />))

  await openMenu('Disconnect')
  /* nothing is deleted until the confirmation is accepted */
  expect(mocks.disconnect).not.toHaveBeenCalled()
  await submit('Disconnect')
  expect(mocks.disconnect).toHaveBeenCalledOnce()
  expect(container.textContent).not.toContain('api.9router.dev')
})

it('keeps a stored custom row removable while custom endpoints are off', async () => {
  const stored = { ...connected({ enabled: false }), customEnabled: false, policy: 'off' as const }
  mocks.accounts.mockResolvedValue(stored)
  mocks.disconnect.mockResolvedValue({ ...empty(), customEnabled: false, policy: 'off' })
  await act(async () => root.render(<ModelAccountPanel />))

  const customRow = Array.from(container.querySelectorAll<HTMLElement>('[role="listitem"]')).find((el) =>
    el.textContent?.includes('9Router'),
  )!
  /* the row keeps its label, model and base URL, and says why it is read-only */
  expect(customRow.textContent).toContain('9Router')
  expect(customRow.textContent).toContain('api.9router.dev')
  expect(customRow.textContent).toContain('9router/auto')
  expect(customRow.textContent).toContain('turned off')
  /* nothing that would call POST/PATCH or the 404 catalog while off */
  expect(customRow.querySelector('[role="switch"]')).toBeNull()
  expect(customRow.querySelector('[aria-label^="Model for"]')).toBeNull()
  expect(customRow.querySelector('[aria-label^="More for"]')).toBeNull()
  expect(container.textContent).not.toContain('Custom provider (OpenAI-compatible)')
  expect(mocks.models).not.toHaveBeenCalledWith('custom')

  const remove = Array.from(customRow.querySelectorAll('button')).find((b) => b.textContent === 'Remove')!
  await act(async () => remove.click())
  /* removal deletes the sealed key, so it confirms first */
  expect(mocks.disconnect).not.toHaveBeenCalled()
  await submit('Remove')
  expect(mocks.disconnect).toHaveBeenCalledOnce()
  expect(container.textContent).not.toContain('api.9router.dev')
})
