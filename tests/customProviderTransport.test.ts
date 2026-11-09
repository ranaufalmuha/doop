import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { runChatCompletionsTurn } from '../server/chatCompletionsAgent.ts'
import { customChatConfig } from '../server/customProvider.ts'
import type { ModelAccount } from '../server/modelAccounts.ts'
import { ModelAuthError, ModelUnavailableError } from '../server/openaiAgent.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * The custom transport: the stored origin plus the two literal paths, the
 * account's key (or the keyless placeholder), its budget, its vision flag, and
 * the turn-time error classes (AC16). A real local stub is the provider, so the
 * guarded fetch, caps and redirect policy are exercised end to end.
 */

interface Received {
  method: string
  url: string
  authorization?: string
  body?: Record<string, unknown>
}

let server: http.Server
let origin: string
let received: Received[] = []
function defaultReply(_req: Received, res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(complete().body))
}
let reply: (req: Received, res: http.ServerResponse) => void = defaultReply

const TOOL: Anthropic.Tool = {
  name: 'doop_ping',
  description: 'ping',
  input_schema: { type: 'object', properties: {} },
}

const request = {
  system: 'be a designer',
  tools: [TOOL],
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 16_000,
}

function account(overrides: Partial<ModelAccount> = {}): ModelAccount {
  return {
    userId: 'alice',
    kind: 'custom',
    baseUrl: origin,
    label: '9Router',
    model: '9router/auto',
    vision: true,
    maxOutputTokens: 4_096,
    apiKey: 'sk-custom-secret',
    enabled: true,
    connectedAt: 1,
    ...overrides,
  }
}

function complete(): ResponseFailure {
  return {
    status: 200,
    body: { choices: [{ message: { content: 'ok' } }] },
  }
}
interface ResponseFailure {
  status: number
  body: unknown
  headers?: Record<string, string>
}

beforeAll(async () => {
  stubEnv('CUSTOM_ENDPOINT_POLICY', 'private')
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const entry: Received = {
        method: req.method ?? '',
        url: req.url ?? '',
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        ...(raw ? { body: JSON.parse(raw) as Record<string, unknown> } : {}),
      }
      received.push(entry)
      reply(entry, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  unstubAllEnvs()
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(() => {
  received = []
  reply = defaultReply
})

describe('the guarded custom request', () => {
  it('posts to the literal chat path with the account key, model and budget', async () => {
    await runChatCompletionsTurn(customChatConfig(account()), request)
    expect(received).toHaveLength(1)
    const [call] = received
    expect(call!.method).toBe('POST')
    expect(call!.url).toBe('/v1/chat/completions')
    expect(call!.authorization).toBe('Bearer sk-custom-secret')
    expect(call!.body).toMatchObject({ model: '9router/auto', max_tokens: 4_096, tool_choice: 'auto' })
    const tools = call!.body!.tools as { function: { name: string } }[]
    expect(tools[0]!.function.name).toBe('doop_ping')
  })

  it('sends the keyless placeholder when no key is stored', async () => {
    await runChatCompletionsTurn(customChatConfig(account({ apiKey: undefined })), request)
    expect(received[0]!.authorization).toBe('Bearer doop-local')
  })

  it('sends image parts when vision is on and text notes when it is off', async () => {
    const imageMessage: Anthropic.MessageParam = {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
        },
      ],
    }
    await runChatCompletionsTurn(customChatConfig(account({ vision: true })), {
      ...request,
      messages: [imageMessage],
    })
    expect(JSON.stringify(received[0]!.body)).toContain('image_url')

    received = []
    await runChatCompletionsTurn(customChatConfig(account({ vision: false })), {
      ...request,
      messages: [imageMessage],
    })
    expect(JSON.stringify(received[0]!.body)).not.toContain('image_url')
    expect(JSON.stringify(received[0]!.body)).toContain('image omitted')
  })

  it('sends an opaque namespaced model id byte-for-byte (AC9)', async () => {
    await runChatCompletionsTurn(customChatConfig(account({ model: 'anthropic/claude-opus-4-6' })), request)
    expect(received[0]!.body!.model).toBe('anthropic/claude-opus-4-6')
  })

  it('abandons a completion past the 8 MiB cap (AC17)', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(9 * 1024 * 1024) })
      res.end()
    }
    await expect(runChatCompletionsTurn(customChatConfig(account()), request)).rejects.toThrow(/Could not reach/)
  })

  it('surfaces a redirect instead of following it', async () => {
    reply = (_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest' })
      res.end()
    }
    await expect(runChatCompletionsTurn(customChatConfig(account()), request)).rejects.toThrow(
      /redirected — use the final base URL/,
    )
    expect(received).toHaveLength(1)
  })
})

describe('turn-time error mapping', () => {
  it('maps 401 to a dead credential', async () => {
    reply = (_req, res) => {
      res.writeHead(401)
      res.end('{"error":{"message":"bad key"}}')
    }
    await expect(runChatCompletionsTurn(customChatConfig(account()), request)).rejects.toBeInstanceOf(ModelAuthError)
  })

  it('maps a model-shaped 404 to ModelUnavailableError', async () => {
    reply = (_req, res) => {
      res.writeHead(404)
      res.end('{"error":{"message":"The model `nope` does not exist"}}')
    }
    await expect(runChatCompletionsTurn(customChatConfig(account()), request)).rejects.toBeInstanceOf(
      ModelUnavailableError,
    )
  })

  it('maps 403, 429 and 5xx to configuration/provider messages without the key', async () => {
    reply = (_req, res) => {
      res.writeHead(403)
      res.end('{"error":{"message":"not allowed for sk-custom-secret"}}')
    }
    await expect(runChatCompletionsTurn(customChatConfig(account()), request)).rejects.toThrow(/not allowed/)
    await expect(runChatCompletionsTurn(customChatConfig(account()), request)).rejects.not.toThrow(/sk-custom-secret/)

    reply = (_req, res) => {
      res.writeHead(429, { 'Retry-After': '7' })
      res.end('{"error":{"message":"slow down"}}')
    }
    await expect(runChatCompletionsTurn(customChatConfig(account()), request)).rejects.toThrow(/retry in 7s/)

    reply = (_req, res) => {
      res.writeHead(503)
      res.end()
    }
    await expect(runChatCompletionsTurn(customChatConfig(account()), request)).rejects.toThrow(/Provider unavailable/)
  })

  it('treats a 200 with an error object as a failure and a non-JSON body as its own message', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"no endpoints found"}}')
    }
    await expect(runChatCompletionsTurn(customChatConfig(account()), request)).rejects.toBeInstanceOf(
      ModelUnavailableError,
    )

    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>hello</html>')
    }
    await expect(runChatCompletionsTurn(customChatConfig(account()), request)).rejects.toThrow(/non-JSON/)
  })
})
