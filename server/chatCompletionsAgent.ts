import { env } from './env.ts'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import {
  IMAGE_NOTE,
  ModelAuthError,
  ModelConfigurationError,
  ModelUnavailableError,
  flattenToolResult,
  imagePart,
  isModelUnavailable,
  responseError,
} from './openaiAgent.ts'
import type { StopReason, TurnBlock, TurnRequest, TurnResult } from './openaiAgent.ts'
import {
  COMPLETION_MAX_BYTES,
  CUSTOM_CHAT_PATH,
  TURN_HEADERS_TIMEOUT_MS,
  TURN_TOTAL_TIMEOUT_MS,
  customBodyError,
  customFetch,
  customHttpMessage,
  customProviderDetail,
  retryAfterSeconds,
} from './customEndpoint.ts'

/**
 * Runs one Doop Agent turn against an OpenAI-compatible Chat Completions
 * endpoint, speaking the Anthropic message shape the agent loop is written
 * in. This is the transport behind the wide-roster providers:
 *
 *  - OpenRouter (a user's `sk-or-` key) — one key, many vendors' models;
 *  - Google Gemini (a user's AI Studio key), through Google's own
 *    OpenAI-compatibility endpoint.
 *
 * Both URLs are fixed constants. Like the Azure transport, this module never
 * takes a user-supplied endpoint by default: a configurable base URL would be
 * a server-side fetch target, i.e. an SSRF into whatever network Doop runs on.
 * The one deliberate exception is the screened custom provider, whose
 * `guarded` config sends every request through `server/customEndpoint.ts`:
 * resolve-and-pin, no redirects, byte caps and a hard timeout. A bare
 * `url` with no `guarded` flag remains a fixed, trusted endpoint.
 *
 * Chat Completions shares the Responses API's one real impedance mismatch:
 * `role: 'tool'` messages are text-only, so images inside tool results are
 * re-attached as a following user message (openaiAgent's flattenToolResult).
 * On top of that this transport carries the roster's second mismatch: some
 * models cannot see images at all. With `vision: false` every image — tool
 * result or user block — is replaced by a text note here, at the one choke
 * point all seven image-producing tools pass through, so no request can 400
 * on a modality the model lacks.
 */

export const OPENROUTER_URL = env.OPENROUTER_CHAT_URL
export const GEMINI_OPENAI_URL = env.GEMINI_OPENAI_CHAT_URL

export const IMAGE_OMITTED_NOTE = '[image omitted — the selected model cannot view images]'

const APP_ORIGIN = env.BETTER_AUTH_URL

export interface ChatCompletionsConfig {
  /** a fixed URL constant, or the custom provider's literal chat path */
  url: string
  headers: Record<string, string>
  model: string
  /** for error messages, e.g. "OpenRouter" */
  label: string
  /** false = strip every image into a text note before sending */
  vision: boolean
  /** custom only: the stored origin, for the guarded request helper */
  origin?: string
  /** custom only: the account's output budget; the other kinds keep req.maxTokens */
  maxTokens?: number
  /** custom only: send through the SSRF-guarded fetch instead of global fetch */
  guarded?: boolean
  /** custom only: the account key, so turn-time provider detail is scrubbed
   *  before it reaches an error surface */
  scrubKey?: string
}

export function openrouterConfig(apiKey: string, model: string, vision: boolean): ChatCompletionsConfig {
  return {
    url: OPENROUTER_URL,
    /* the attribution headers are how OpenRouter credits the calling app */
    headers: { Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': APP_ORIGIN, 'X-Title': 'Doop' },
    model,
    label: 'OpenRouter',
    vision,
  }
}

export function geminiConfig(apiKey: string, model: string, vision: boolean): ChatCompletionsConfig {
  return {
    url: GEMINI_OPENAI_URL,
    headers: { Authorization: `Bearer ${apiKey}` },
    model,
    label: 'Gemini',
    vision,
  }
}

/* ---------------------------------------------------------------- */
/* Anthropic messages -> Chat Completions messages                  */
/* ---------------------------------------------------------------- */

type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

type ChatMessage =
  | { role: 'system' | 'user'; content: string | ChatPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

function toMessages(system: string, messages: Anthropic.MessageParam[], vision: boolean): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }]
  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push(
        message.role === 'assistant'
          ? { role: 'assistant', content: message.content }
          : { role: 'user', content: message.content },
      )
      continue
    }
    if (message.role === 'assistant') {
      const texts: string[] = []
      const calls: ChatToolCall[] = []
      for (const block of message.content) {
        if (block.type === 'text') texts.push(block.text)
        else if (block.type === 'tool_use') {
          calls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          })
        }
      }
      out.push({
        role: 'assistant',
        content: texts.length > 0 ? texts.join('\n') : null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      })
      continue
    }
    /* a user message: tool results first (they must directly follow the
       assistant's tool_calls), then any remaining text/images, then the
       images the text-only tool messages had to leave behind */
    const userParts: ChatPart[] = []
    const trailingImages: ChatPart[] = []
    for (const block of message.content) {
      switch (block.type) {
        case 'tool_result': {
          const { text, images } = flattenToolResult(block)
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: vision
              ? text
              : text.replaceAll('[image returned — see the attached image below]', IMAGE_OMITTED_NOTE),
          })
          if (vision) {
            for (const image of images) {
              if (image.type === 'input_image')
                trailingImages.push({ type: 'image_url', image_url: { url: image.image_url } })
            }
          }
          break
        }
        case 'text':
          userParts.push({ type: 'text', text: block.text })
          break
        case 'image': {
          if (!vision) {
            userParts.push({ type: 'text', text: IMAGE_OMITTED_NOTE })
            break
          }
          const image = imagePart(block.source as never)
          if (image && image.type === 'input_image') {
            userParts.push({ type: 'image_url', image_url: { url: image.image_url } })
          }
          break
        }
        default:
          break
      }
    }
    if (userParts.length > 0) out.push({ role: 'user', content: userParts })
    if (trailingImages.length > 0) {
      out.push({ role: 'user', content: [...trailingImages, { type: 'text', text: IMAGE_NOTE }] })
    }
  }
  return out
}

function toTools(tools: Anthropic.Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description ?? '', parameters: tool.input_schema },
  }))
}

/* ---------------------------------------------------------------- */
/* Chat Completions output -> Anthropic blocks                      */
/* ---------------------------------------------------------------- */

interface CompletionBody {
  /* OpenRouter reports some failures as an error object on a 200 */
  error?: { message?: string } | null
  choices?: {
    finish_reason?: string
    message?: {
      content?: string | null
      refusal?: string | null
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
    }
  }[]
}

function fromCompletion(body: CompletionBody, label: string): TurnResult {
  if (body.error?.message) {
    throw isModelUnavailable(body.error.message)
      ? new ModelUnavailableError(`${label}: ${body.error.message}`)
      : new Error(`${label}: ${body.error.message}`)
  }
  const choice = body.choices?.[0]
  if (!choice?.message) throw new Error(`${label} returned an empty response`)
  const content: TurnBlock[] = []
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content })
  const refused = Boolean(choice.message.refusal)
  let toolCalls = 0
  for (const call of choice.message.tool_calls ?? []) {
    toolCalls++
    let input: unknown
    try {
      input = call.function?.arguments ? JSON.parse(call.function.arguments) : {}
    } catch {
      /* a malformed argument blob becomes an empty call; the tool's own
         validation then returns a usable error to the model */
      input = {}
    }
    content.push({
      type: 'tool_use',
      id: call.id || `call_${randomUUID()}`,
      name: call.function?.name || 'unknown',
      input: input as Record<string, unknown>,
    })
  }
  const truncated = choice.finish_reason === 'length'
  const stop: StopReason = refused ? 'refusal' : toolCalls > 0 ? 'tool_use' : truncated ? 'max_tokens' : 'end_turn'
  /* a response with nothing in it would end the loop silently; make it a
     visible failure instead */
  if (content.length === 0 && !refused) throw new Error(`${label} returned an empty response`)
  return { content, stop_reason: stop }
}

/* ---------------------------------------------------------------- */
/* transport                                                        */
/* ---------------------------------------------------------------- */

/** Turn-time mapping for the custom provider, keeping the agent's existing
 *  error classes: 401 is a dead credential, a model-shaped 404 is a model
 *  problem, and DNS/TLS/timeout are configuration errors. */
function customTurnError(
  result: { status: number; retryAfter: string | null; text: string },
  label: string,
  apiKey?: string,
): Error {
  if (result.status >= 300 && result.status < 400) {
    return new Error('Endpoint redirected — use the final base URL.')
  }
  const detail = customProviderDetail(result.text, apiKey)
  if (result.status === 401) return new ModelAuthError(`${label} rejected the API key — replace it in Settings.`)
  if (result.status === 403) return new Error('Key is valid but this model or endpoint is not allowed.')
  if (result.status === 429) {
    const seconds = retryAfterSeconds(result.retryAfter)
    return new Error(seconds === null ? 'Rate limited — retry in a moment.' : `Rate limited — retry in ${seconds}s.`)
  }
  if (result.status === 404) {
    return isModelUnavailable(detail)
      ? new ModelUnavailableError(`${label} cannot run this model.${detail ? ` ${detail}` : ''}`)
      : new Error(`Endpoint or model not found — check the base URL and the model id.${detail ? ` ${detail}` : ''}`)
  }
  if (result.status >= 500) return new Error('Provider unavailable.')
  return new Error(customHttpMessage(result, label, apiKey))
}

function customTransportError(error: unknown): Error {
  const message = error instanceof Error ? error.message : ''
  if (/timed out|timeout/i.test(message)) {
    return new ModelConfigurationError('Could not reach the endpoint — the request timed out.')
  }
  if (/certificate|CERT_|self.signed|ssl|tls/i.test(message)) {
    return new ModelConfigurationError('Could not reach the endpoint — the certificate was rejected.')
  }
  return new ModelConfigurationError('Could not reach the endpoint — check the base URL.')
}

export async function runChatCompletionsTurn(config: ChatCompletionsConfig, req: TurnRequest): Promise<TurnResult> {
  const body = JSON.stringify({
    model: config.model,
    messages: toMessages(req.system, req.messages, config.vision),
    tools: toTools(req.tools),
    tool_choice: 'auto',
    max_tokens: config.maxTokens ?? req.maxTokens,
  })
  if (config.guarded) {
    if (!config.origin) throw new ModelConfigurationError('Reconnect the custom provider in Settings.')
    let result
    try {
      result = await customFetch({
        origin: config.origin,
        path: CUSTOM_CHAT_PATH,
        method: 'POST',
        headers: { ...config.headers, 'Content-Type': 'application/json' },
        body,
        signal: req.signal,
        timeoutMs: TURN_TOTAL_TIMEOUT_MS,
        headersTimeoutMs: TURN_HEADERS_TIMEOUT_MS,
        maxBytes: COMPLETION_MAX_BYTES,
      })
    } catch (error) {
      throw customTransportError(error)
    }
    if (!result.ok) throw customTurnError(result, config.label, config.scrubKey)
    const bodyError = customBodyError(result.text, config.scrubKey)
    if (bodyError) {
      throw isModelUnavailable(bodyError)
        ? new ModelUnavailableError(`${config.label}: ${bodyError}`)
        : new Error(`${config.label}: ${bodyError}`)
    }
    let parsed: CompletionBody
    try {
      parsed = JSON.parse(result.text) as CompletionBody
    } catch {
      throw new Error('Endpoint returned non-JSON — check the base URL.')
    }
    return fromCompletion(parsed, config.label)
  }
  const res = await fetch(config.url, {
    method: 'POST',
    headers: { ...config.headers, 'Content-Type': 'application/json' },
    body,
    signal: req.signal,
  })
  if (!res.ok) throw await responseError(res, config.label)
  return fromCompletion((await res.json()) as CompletionBody, config.label)
}

/* exported for tests */
export const _internal = { toMessages, toTools, fromCompletion }
