import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/**
 * Custom OpenAI-compatible provider, over HTTP, against a real local stub.
 * Covers connect (AC1), the probe gate (AC7), the advisory catalog and manual
 * ids (AC8), opaque ids (AC9), keyless/rotate/delete (AC10), key secrecy
 * (AC11), owner isolation (AC12), default routing (AC13), the composer runner
 * (AC14), vision/budget PATCH (AC15/AC18), policy (AC19), one-change PATCH and
 * the connect rate limit (AC20), and redirects (AC6). The public-policy
 * refusals (AC2–AC4) run on their own server so no request can be made.
 */

interface StubState {
  modelsStatus: number
  modelsBody: unknown
  chatStatus: number
  chatBody: unknown
  redirectTo?: string
  lastAuth?: string
  lastChatBody?: Record<string, unknown>
  modelsCalls: number
  chatCalls: number
}

const state: StubState = {
  modelsStatus: 200,
  modelsBody: { data: [{ id: '9router/auto' }] },
  chatStatus: 200,
  chatBody: {
    choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'doop_ping', arguments: '{}' } }] } }],
  },
  modelsCalls: 0,
  chatCalls: 0,
}

let stub: http.Server
let stubOrigin: string

function resetStub(overrides: Partial<StubState> = {}): void {
  state.modelsStatus = 200
  state.modelsBody = { data: [{ id: '9router/auto' }] }
  state.chatStatus = 200
  state.chatBody = {
    choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'doop_ping', arguments: '{}' } }] } }],
  }
  state.redirectTo = undefined
  state.lastAuth = undefined
  state.lastChatBody = undefined
  state.modelsCalls = 0
  state.chatCalls = 0
  Object.assign(state, overrides)
}

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        state.modelsCalls++
        res.writeHead(state.modelsStatus, { 'Content-Type': 'application/json' })
        res.end(typeof state.modelsBody === 'string' ? state.modelsBody : JSON.stringify(state.modelsBody))
        return
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        state.chatCalls++
        state.lastAuth = req.headers.authorization
        state.lastChatBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined
        if (state.redirectTo) {
          res.writeHead(302, { Location: state.redirectTo })
          res.end()
          return
        }
        res.writeHead(state.chatStatus, { 'Content-Type': 'application/json' })
        res.end(typeof state.chatBody === 'string' ? state.chatBody : JSON.stringify(state.chatBody))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  stubOrigin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()))
})

type View = {
  accounts: {
    kind: string
    enabled: boolean
    model?: string
    label?: string
    baseUrl?: string
    vision?: boolean
    maxOutputTokens?: number
  }[]
  default?: string
  customEnabled: boolean
  policy: string
  menus: Record<string, unknown[]>
}

const customAccount = (view: View) => view.accounts.find((account) => account.kind === 'custom')

describe('the private-policy server', () => {
  let server: Server
  let alice: Client
  let bob: Client
  let carol: Client
  let dave: Client
  let eve: Client
  let frank: Client

  beforeAll(async () => {
    server = await startServer({ CUSTOM_ENDPOINT_POLICY: 'private', ANTHROPIC_API_KEY: '', DATABASE_URL: '' })
    alice = await new Client(server).signUp('custom-alice@example.test', 'Alice')
    bob = await new Client(server).signUp('custom-bob@example.test', 'Bob')
    carol = await new Client(server).signUp('custom-carol@example.test', 'Carol')
    dave = await new Client(server).signUp('custom-dave@example.test', 'Dave')
    eve = await new Client(server).signUp('custom-eve@example.test', 'Eve')
    frank = await new Client(server).signUp('custom-frank@example.test', 'Frank')
  }, 90_000)

  afterAll(() => server?.stop())

  beforeEach(() => resetStub())

  it('connects a self-host 9Router, hides the key, and lists the composer runner (AC1/AC11/AC14)', async () => {
    const response = await alice.post('/api/model-account/custom', {
      baseUrl: `${stubOrigin}/v1`,
      label: '9Router',
      apiKey: 'sk-alice-secret-do-not-echo',
      model: '9router/auto',
    })
    expect(response.status).toBe(200)
    const view = (await response.json()) as View
    expect(view.customEnabled).toBe(true)
    expect(view.policy).toBe('private')
    expect(customAccount(view)).toMatchObject({
      kind: 'custom',
      enabled: true,
      label: '9Router',
      baseUrl: stubOrigin,
      model: '9router/auto',
      vision: false,
      maxOutputTokens: 8192,
    })
    expect(JSON.stringify(view)).not.toContain('sk-alice-secret-do-not-echo')
    expect(view.menus.custom).toEqual([])
    expect(state.lastAuth).toBe('Bearer sk-alice-secret-do-not-echo')
    expect(state.lastChatBody).toMatchObject({ model: '9router/auto', tool_choice: 'auto', max_tokens: 32 })
    const tools = state.lastChatBody!.tools as { function: { name: string } }[]
    expect(tools[0]!.function.name).toBe('doop_ping')

    const runners = await (await alice.get('/api/agent-runners')).json()
    const runner = runners.runners.find((entry: { provider: string }) => entry.provider === 'custom')
    expect(runner).toMatchObject({
      provider: 'custom',
      name: '9Router',
      model: '9router/auto',
      vision: false,
      models: [{ id: '9router/auto', name: '9router/auto', blurb: '' }],
    })
  })

  it('saves when /models fails but the probe succeeds, and the catalog falls back (AC7/AC8)', async () => {
    resetStub({ modelsStatus: 401 })
    const connected = await carol.post('/api/model-account/custom', {
      baseUrl: stubOrigin,
      label: 'Carol Router',
      apiKey: 'sk-carol',
      model: 'my-model',
    })
    expect(connected.status).toBe(200)
    expect(customAccount((await connected.json()) as View)).toMatchObject({ model: 'my-model' })

    const catalog = await (await carol.get('/api/model-account/models?kind=custom')).json()
    expect(catalog).toMatchObject({
      live: false,
      models: [{ id: 'my-model', name: 'my-model', blurb: '', vision: false }],
    })
    expect(typeof catalog.error).toBe('string')
  })

  it('refuses a probe that answers 401 and leaves the previous row intact (AC7)', async () => {
    resetStub({ chatStatus: 401, chatBody: '{"error":{"message":"bad key"}}' })
    const failed = await carol.post('/api/model-account/custom', {
      baseUrl: stubOrigin,
      label: 'Carol Router',
      apiKey: 'sk-carol-rotated',
    })
    expect(failed.status).toBe(400)
    expect(((await failed.json()) as { error: string }).error).toMatch(/Authentication failed/)
    expect(customAccount((await (await carol.get('/api/model-account')).json()) as View)).toMatchObject({
      model: 'my-model',
    })
  })

  it('refuses a probe with no tool call and names the missing capability (AC7)', async () => {
    resetStub({ chatBody: { choices: [{ message: { content: 'I can help with that.' } }] } })
    const failed = await carol.post('/api/model-account/custom', {
      baseUrl: stubOrigin,
      label: 'Carol Router',
      apiKey: 'sk-carol',
    })
    expect(failed.status).toBe(400)
    expect(((await failed.json()) as { error: string }).error).toMatch(/tool call/)
  })

  it('abandons an over-cap catalog and still connects on the probe (AC17)', async () => {
    resetStub({
      modelsBody: JSON.stringify({
        data: Array.from({ length: 60_000 }, (_, index) => ({ id: `model-${index}`, padding: 'x'.repeat(40) })),
      }),
    })
    const connected = await carol.post('/api/model-account/custom', {
      baseUrl: stubOrigin,
      label: 'Carol Router',
      apiKey: 'sk-carol',
      model: 'my-model',
    })
    expect(connected.status).toBe(200)
    const catalog = await (await carol.get('/api/model-account/models?kind=custom')).json()
    expect(catalog.live).toBe(false)
    expect(typeof catalog.error).toBe('string')
  })

  it('surfaces a redirect and never follows it (AC6)', async () => {
    resetStub({ redirectTo: 'http://169.254.169.254/latest' })
    const failed = await carol.post('/api/model-account/custom', {
      baseUrl: stubOrigin,
      label: 'Carol Router',
      apiKey: 'sk-carol',
    })
    expect(failed.status).toBe(400)
    expect(((await failed.json()) as { error: string }).error).toMatch(/redirected — use the final base URL/)
    expect(state.chatCalls).toBe(1)
  })

  it('accepts a manual model id and filters only non-chat catalog entries (AC8)', async () => {
    resetStub({ modelsStatus: 404, modelsBody: '{"error":"nope"}' })
    expect(
      (
        await alice.post('/api/model-account/custom', {
          baseUrl: stubOrigin,
          label: '9Router',
          apiKey: 'sk-alice-secret-do-not-echo',
          model: 'my-model',
        })
      ).status,
    ).toBe(200)
    const manual = await (await alice.get('/api/model-account/models?kind=custom')).json()
    expect(manual).toMatchObject({ live: false, models: [{ id: 'my-model' }] })

    await alice.delete('/api/model-account/custom')
    resetStub({
      modelsBody: {
        data: [
          { id: 'llama3.1:8b-instruct-q4_K_M' },
          { id: 'qwen2.5:7b-instruct' },
          { id: 'text-embedding-3-large' },
          { id: 'whisper-1' },
        ],
      },
    })
    const connected = await alice.post('/api/model-account/custom', {
      baseUrl: stubOrigin,
      label: 'Local',
      model: undefined,
    })
    expect(connected.status).toBe(200)
    const live = await (await alice.get('/api/model-account/models?kind=custom')).json()
    expect(live.live).toBe(true)
    expect(live.models.map((model: { id: string }) => model.id)).toEqual([
      'llama3.1:8b-instruct-q4_K_M',
      'qwen2.5:7b-instruct',
    ])
    /* the stored id is always allowed, even when the live catalog omits it */
    expect((await alice.patch('/api/model-account/custom', { model: 'my-model' })).status).toBe(200)
    expect(customAccount((await (await alice.get('/api/model-account')).json()) as View)).toMatchObject({
      model: 'my-model',
    })
  })

  it('stores opaque model ids verbatim (AC9)', async () => {
    const ids = [
      'anthropic/claude-opus-4-6',
      '9router/auto',
      'premium-coding',
      'moonshotai/kimi-k3',
      'qwen3:32b',
      'meta.llama-4',
      '@cf/meta/llama-3.1-8b-instruct',
    ]
    for (const id of ids) {
      expect((await alice.patch('/api/model-account/custom', { model: id })).status).toBe(200)
      expect(customAccount((await (await alice.get('/api/model-account')).json()) as View)).toMatchObject({ model: id })
    }
    expect((await alice.patch('/api/model-account/custom', { model: '' })).status).toBe(400)
    expect((await alice.patch('/api/model-account/custom', { model: ' '.repeat(3) })).status).toBe(400)
    expect((await alice.patch('/api/model-account/custom', { model: 'x'.repeat(121) })).status).toBe(400)
  })

  it('connects keyless, rotates the key without changing the model, and disconnects (AC10)', async () => {
    const keyless = await dave.post('/api/model-account/custom', {
      baseUrl: stubOrigin,
      label: 'Local gateway',
      model: 'local-model',
    })
    expect(keyless.status).toBe(200)
    expect(JSON.stringify(await keyless.json())).not.toContain('doop-local')
    expect(state.lastAuth).toBe('Bearer doop-local')

    const rotated = await dave.post('/api/model-account/custom', { baseUrl: stubOrigin, apiKey: 'sk-dave-new' })
    expect(rotated.status).toBe(200)
    expect(customAccount((await rotated.json()) as View)).toMatchObject({ model: 'local-model' })
    expect(state.lastAuth).toBe('Bearer sk-dave-new')

    expect((await dave.delete('/api/model-account/custom')).status).toBe(200)
    expect(customAccount((await (await dave.get('/api/model-account')).json()) as View)).toBeUndefined()
    const runners = await (await dave.get('/api/agent-runners')).json()
    expect(runners.runners.some((entry: { provider: string }) => entry.provider === 'custom')).toBe(false)
    expect(await (await dave.get('/api/model-account/models?kind=custom')).json()).toEqual({ models: [], live: false })
  })

  it('changes vision and budget one field at a time, rejecting the rest (AC15/AC18/AC20)', async () => {
    const budget = (await (await alice.get('/api/model-account')).json()) as View
    expect(customAccount(budget)).toMatchObject({ vision: false, maxOutputTokens: 8192 })

    expect((await alice.patch('/api/model-account/custom', { vision: true })).status).toBe(200)
    expect(customAccount((await (await alice.get('/api/model-account')).json()) as View)).toMatchObject({
      vision: true,
    })
    expect((await alice.patch('/api/model-account/custom', { vision: false })).status).toBe(200)

    expect((await alice.patch('/api/model-account/custom', { maxOutputTokens: 4096 })).status).toBe(200)
    expect(customAccount((await (await alice.get('/api/model-account')).json()) as View)).toMatchObject({
      maxOutputTokens: 4096,
    })
    for (const bad of [0, 1023, 16001, 4096.5, 'many']) {
      expect((await alice.patch('/api/model-account/custom', { maxOutputTokens: bad })).status).toBe(400)
    }
    expect((await alice.patch('/api/model-account/custom', { model: 'x', vision: true })).status).toBe(400)
    expect((await alice.patch('/api/model-account/custom', {})).status).toBe(400)
  })

  it('sets the default and falls back when it is switched off (AC13)', async () => {
    resetStub()
    const put = await alice.put('/api/agent-runners/default', { provider: 'custom' })
    expect(put.status).toBe(200)
    expect(((await put.json()) as View).default).toBe('custom')
    expect((await (await alice.get('/api/agent-runners')).json()).default).toBe('custom')

    expect((await alice.patch('/api/model-account/custom', { enabled: false })).status).toBe(200)
    const off = (await (await alice.get('/api/model-account')).json()) as View
    expect(off.default).toBeUndefined()
    const runners = await (await alice.get('/api/agent-runners')).json()
    expect(runners.runners.some((entry: { provider: string }) => entry.provider === 'custom')).toBe(false)
    expect((await alice.put('/api/agent-runners/default', { provider: 'custom' })).status).toBe(400)

    expect((await alice.patch('/api/model-account/custom', { enabled: true })).status).toBe(200)
    expect(((await (await alice.get('/api/agent-runners')).json()) as { default?: string }).default).toBe('custom')
  })

  it('isolates one person’s custom account from another (AC12)', async () => {
    const view = (await (await bob.get('/api/model-account')).json()) as View
    expect(view.accounts).toEqual([])
    expect(await (await bob.get('/api/model-account/models?kind=custom')).json()).toEqual({ models: [], live: false })
    expect((await bob.put('/api/agent-runners/default', { provider: 'custom' })).status).toBe(400)
  })

  it('caches the custom catalog for a minute and clears it when the row changes (F6)', async () => {
    resetStub()
    const connected = await frank.post('/api/model-account/custom', {
      baseUrl: stubOrigin,
      label: 'Frank Router',
      apiKey: 'sk-frank',
      model: '9router/auto',
    })
    expect(connected.status).toBe(200)
    /* connect asks once for the suggestion list */
    const afterConnect = state.modelsCalls
    expect(afterConnect).toBe(1)

    const first = await (await frank.get('/api/model-account/models?kind=custom')).json()
    expect(first).toMatchObject({ live: true })
    expect(state.modelsCalls).toBe(afterConnect + 1)

    /* a second open inside the minute is served from the cache */
    const second = await (await frank.get('/api/model-account/models?kind=custom')).json()
    expect(second).toEqual(first)
    expect(state.modelsCalls).toBe(afterConnect + 1)

    /* changing the connection invalidates the cached list */
    expect((await frank.patch('/api/model-account/custom', { vision: true })).status).toBe(200)
    await frank.get('/api/model-account/models?kind=custom')
    expect(state.modelsCalls).toBe(afterConnect + 2)
  })

  it('rate-limits connect attempts to ten per minute per user (AC20)', async () => {
    let lastStatus = 0
    for (let attempt = 1; attempt <= 10; attempt++) {
      lastStatus = (await eve.post('/api/model-account/custom', { baseUrl: 'not a url' })).status
      expect(lastStatus).toBe(400)
    }
    const limited = await eve.post('/api/model-account/custom', { baseUrl: 'not a url' })
    expect(limited.status).toBe(429)
    expect(((await limited.json()) as { error: string }).error).toMatch(/Too many connection attempts/)
    expect(customAccount((await (await eve.get('/api/model-account')).json()) as View)).toBeUndefined()
  })
})

describe('the public-policy server', () => {
  let server: Server
  let alice: Client

  beforeAll(async () => {
    server = await startServer({ CUSTOM_ENDPOINT_POLICY: 'public', ANTHROPIC_API_KEY: '', DATABASE_URL: '' })
    alice = await new Client(server).signUp('custom-public@example.test', 'Alice')
  }, 90_000)

  afterAll(() => server?.stop())

  it('is https-only and refuses private/metadata addresses without a request (AC2–AC4)', async () => {
    const view = (await (await alice.get('/api/model-account')).json()) as View
    expect(view.customEnabled).toBe(true)
    expect(view.policy).toBe('public')

    const http = await alice.post('/api/model-account/custom', {
      baseUrl: 'http://api.9router.dev/v1',
      label: '9Router',
    })
    expect(http.status).toBe(400)
    expect(((await http.json()) as { error: string }).error).toMatch(/https:\/\//)

    for (const url of [
      'https://127.0.0.1/v1',
      'https://10.0.0.5/v1',
      'https://[::1]/v1',
      'https://169.254.169.254/v1',
    ]) {
      const refused = await alice.post('/api/model-account/custom', { baseUrl: url, label: 'Bad' })
      expect(refused.status).toBe(400)
      expect(((await refused.json()) as { error: string }).error).toMatch(
        /private to the server's own network|metadata/,
      )
    }
    expect(customAccount((await (await alice.get('/api/model-account')).json()) as View)).toBeUndefined()
  })
})

describe('the off policy', () => {
  let server: Server
  let alice: Client

  beforeAll(async () => {
    /* a stored row can only be created while the feature is on, then the same
       database reboots with `off` as an operator would flip the policy */
    server = await startServer({ CUSTOM_ENDPOINT_POLICY: 'private', ANTHROPIC_API_KEY: '', DATABASE_URL: '' })
    alice = await new Client(server).signUp('custom-off@example.test', 'Alice')
    resetStub()
    const connected = await alice.post('/api/model-account/custom', {
      baseUrl: stubOrigin,
      label: '9Router',
      apiKey: 'sk-off-secret',
      model: '9router/auto',
    })
    expect(connected.status).toBe(200)
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer(
      { CUSTOM_ENDPOINT_POLICY: 'off', ANTHROPIC_API_KEY: '', DATABASE_URL: '' },
      server.dataDir,
    )
  }, 120_000)

  afterAll(() => server?.stop())

  it('hides the feature and 404s writes, but still shows and deletes a stored row (AC19/F4)', async () => {
    const view = (await (await alice.get('/api/model-account')).json()) as View
    expect(view.customEnabled).toBe(false)
    expect(view.policy).toBe('off')
    /* status keeps the row visible so its owner can see what they remove */
    expect(customAccount(view)).toMatchObject({ kind: 'custom', label: '9Router' })

    expect(
      (await alice.post('/api/model-account/custom', { baseUrl: 'https://api.9router.dev', label: 'x' })).status,
    ).toBe(404)
    expect((await alice.patch('/api/model-account/custom', { vision: true })).status).toBe(404)
    expect((await alice.get('/api/model-account/models?kind=custom')).status).toBe(404)

    const deleted = await alice.delete('/api/model-account/custom')
    expect(deleted.status).toBe(200)
    expect(customAccount((await deleted.json()) as View)).toBeUndefined()
    expect(customAccount((await (await alice.get('/api/model-account')).json()) as View)).toBeUndefined()
  })
})
