import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import type { ModelAccounts } from '@/lib/api'
import { CustomProviderEntry } from '@/components/CustomProviderSettings'

/**
 * The custom OpenAI-compatible provider row in Settings → Doop Agent: the
 * add card, its connect form, and the connected tile (on, off, default). The
 * component is presentational, so the catalogue can show every state without
 * a server behind it.
 */
const view = (overrides: Partial<ModelAccounts> = {}): ModelAccounts => ({
  accounts: [],
  chatgptEnabled: true,
  customEnabled: true,
  policy: 'public',
  menus: { chatgpt: [], 'openai-key': [], 'anthropic-key': [], 'openrouter-key': [], 'gemini-key': [], custom: [] },
  ...overrides,
})

const account = {
  kind: 'custom' as const,
  enabled: true,
  label: '9Router',
  baseUrl: 'https://api.9router.dev',
  model: '9router/auto',
  vision: false,
  maxOutputTokens: 8192,
  connectedAt: 1,
}

const meta = {
  title: 'Features/Custom model provider',
  parameters: { layout: 'fullscreen' },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper p-6">
      <div role="list" className="mx-auto max-w-[1000px] overflow-hidden rounded-panel bg-surface shadow-ring">
        {children}
      </div>
    </div>
  )
}

const props = {
  busy: false,
  error: undefined,
  onSubmit: async () => true,
  onPatch: async () => true,
  onMakeDefault: () => {},
  onDisconnect: async () => true,
  onClearError: () => {},
}

export const Add: Story = {
  render: () => (
    <Frame>
      <CustomProviderEntry view={view()} account={undefined} models={[]} {...props} />
    </Frame>
  ),
}

export const Connected: Story = {
  render: () => (
    <Frame>
      <CustomProviderEntry
        view={view({ accounts: [account], default: 'custom' })}
        account={account}
        models={[
          { id: '9router/auto', name: '9router/auto', blurb: '', vision: false },
          { id: 'anthropic/claude-opus-4-6', name: 'anthropic/claude-opus-4-6', blurb: '', vision: false },
        ]}
        {...props}
      />
    </Frame>
  ),
}

export const Off: Story = {
  render: () => (
    <Frame>
      <CustomProviderEntry
        view={view({ accounts: [{ ...account, enabled: false }] })}
        account={{ ...account, enabled: false }}
        models={[{ id: '9router/auto', name: '9router/auto', blurb: '', vision: false }]}
        {...props}
      />
    </Frame>
  ),
}

export const CatalogUnavailable: Story = {
  render: () => (
    <Frame>
      <CustomProviderEntry
        view={view({ accounts: [account] })}
        account={account}
        models={[{ id: '9router/auto', name: '9router/auto', blurb: '', vision: false }]}
        catalogError="Could not load models from 9Router. Enter a model id instead."
        {...props}
      />
    </Frame>
  ),
}
