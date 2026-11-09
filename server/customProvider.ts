import { and, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { modelAccounts } from './db/schema.ts'
import { accountModelFor, getAccount, type ModelAccount } from './modelAccounts.ts'
import { ModelConfigurationError } from './openaiAgent.ts'
import type { CustomChatCompletionsConfig } from './chatCompletionsAgent.ts'
import {
  CATALOG_MAX_BYTES,
  CATALOG_TIMEOUT_MS,
  COMPLETION_MAX_BYTES,
  CONNECT_ATTEMPTS_PER_MIN,
  CUSTOM_CHAT_PATH,
  CUSTOM_KEY_PLACEHOLDER,
  CUSTOM_MODELS_PATH,
  DEFAULT_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MAX_LABEL_LENGTH,
  MIN_OUTPUT_TOKENS,
  TURN_HEADERS_TIMEOUT_MS,
  TURN_TOTAL_TIMEOUT_MS,
  cleanCustomModelId,
  customBodyError,
  customEndpointPolicy,
  customFetch,
  customHttpMessage,
  customOriginHost,
  customProviderDetail,
  hasCustomControlChars,
  plaintextCustomOriginWarning,
  screenCustomBaseUrl,
  type CustomEndpointPolicy,
} from './customEndpoint.ts'

/**
 * The custom OpenAI-compatible provider: one connection per user, validated by
 * a single tool-call probe and then run through the shared guarded transport.
 *
 * The probe is the contract. `/v1/models` is only a suggestion list, so a
 * failing catalog never decides the connect result; a provider that cannot make
 * a tool call (or rejects the image when vision is claimed) is rejected, because
 * the Doop Agent cannot work without function calling.
 */

export class CustomRateLimitError extends Error {}
export class CustomDisabledError extends Error {}

export interface CustomCatalogEntry {
  id: string
  name: string
  blurb: string
  vision: boolean
}

export interface CustomCatalog {
  models: CustomCatalogEntry[]
  live: boolean
  error?: string
}

interface CatalogModel {
  id: string
  name: string
  maxCompletionTokens?: number
}

interface ConnectInput {
  baseUrl?: unknown
  label?: unknown
  apiKey?: unknown
  model?: unknown
  vision?: unknown
  maxOutputTokens?: unknown
}

/* A 1×1 transparent PNG: enough to prove the model accepts image input. */
const PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/* The custom catalog drops only unambiguous non-chat modalities. It must NOT
   reuse NOT_AN_AGENT_MODEL, which also drops instruct/chat/live/search — those
   are legitimate parts of chat ids (llama3.1:8b-instruct-q4_K_M, qwen2.5:7b-instruct). */
const NON_CHAT = /(^|[^a-z0-9])(embedding|audio|tts|whisper|transcrib|realtime|moderation|image|robotics)([^a-z0-9]|$)/i

function isNonChatId(id: string): boolean {
  const lastSegment = id.split('/').pop() ?? id
  return NON_CHAT.test(lastSegment)
}

function validateLabel(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error('Enter a provider name.')
  const label = value.trim()
  if (!label) throw new Error('Enter a provider name.')
  if (label.length > MAX_LABEL_LENGTH) {
    throw new Error(`Provider names are at most ${MAX_LABEL_LENGTH} characters.`)
  }
  if (hasCustomControlChars(label)) throw new Error('That provider name contains an unsupported character.')
  return label
}

function validateApiKey(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('That API key is not valid.')
  const key = value.trim()
  if (!key) return null
  if (key.length > 2_000 || /\s/.test(key) || hasCustomControlChars(key)) {
    throw new Error('That API key is not valid.')
  }
  return key
}

function validateOutputTokens(value: unknown): number {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  if (!Number.isInteger(number)) throw new Error('The output budget must be a whole number.')
  const tokens = number as number
  if (tokens < MIN_OUTPUT_TOKENS || tokens > MAX_OUTPUT_TOKENS) {
    throw new Error(`The output budget must be between ${MIN_OUTPUT_TOKENS} and ${MAX_OUTPUT_TOKENS}.`)
  }
  return tokens
}

function clampBudget(hint: number | undefined): number {
  if (hint === undefined || !Number.isFinite(hint)) return DEFAULT_OUTPUT_TOKENS
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Math.trunc(hint)))
}

function parseCatalog(text: string): CatalogModel[] {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return []
  }
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const models: CatalogModel[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const id = cleanCustomModelId(entry.id)
    if (!id || seen.has(id) || isNonChatId(id)) continue
    seen.add(id)
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id
    const hint =
      typeof entry.max_completion_tokens === 'number' && Number.isFinite(entry.max_completion_tokens)
        ? entry.max_completion_tokens
        : undefined
    models.push({ id, name, ...(hint !== undefined ? { maxCompletionTokens: hint } : {}) })
    if (models.length >= 1_000) break
  }
  return models
}

interface CatalogLookup {
  models: CatalogModel[]
  live: boolean
}

/** Ask the provider for its suggestion list. Any failure is "no catalog", not
 *  a failed connect: the probe is what decides. */
async function fetchCatalog(
  origin: string,
  apiKey: string | undefined,
  policy: CustomEndpointPolicy,
): Promise<CatalogLookup> {
  try {
    const result = await customFetch({
      origin,
      path: CUSTOM_MODELS_PATH,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey || CUSTOM_KEY_PLACEHOLDER}`,
        Accept: 'application/json',
      },
      timeoutMs: CATALOG_TIMEOUT_MS,
      maxBytes: CATALOG_MAX_BYTES,
      policy,
    })
    if (!result.ok) return { models: [], live: false }
    const models = parseCatalog(result.text)
    return { models, live: models.length > 0 }
  } catch {
    return { models: [], live: false }
  }
}

/** The catalog is advisory and a scripted client can open the picker in a
 *  loop, so one outbound `/v1/models` request per user per minute is enough.
 *  Connect and PATCH clear the entry; the TTL covers the rest. */
const CATALOG_CACHE_TTL_MS = 60_000
const catalogCache = new Map<string, { expiresAt: number; catalog: CustomCatalog }>()

/** Forget one user's cached catalog after their row changes. */
export function clearCustomCatalogCache(userId: string): void {
  catalogCache.delete(userId)
}

async function loadCustomCatalog(account: ModelAccount): Promise<CustomCatalog> {
  const stored = accountModelFor(account)
  const v = account.vision === true
  const label = account.label || 'the provider'
  if (!account.baseUrl) return { models: [], live: false }
  const catalog = await fetchCatalog(account.baseUrl, account.apiKey, customEndpointPolicy())
  if (!catalog.live || catalog.models.length === 0) {
    return {
      models: [{ id: stored, name: stored, blurb: '', vision: v }],
      live: false,
      error: `Could not load models from ${label}. Enter a model id instead.`,
    }
  }
  return {
    models: catalog.models.map((model) => ({ id: model.id, name: model.name, blurb: '', vision: v })),
    live: true,
  }
}

/** The picker's catalog, with the spec's never-empty fallback, cached briefly
 *  so opening the picker repeatedly does not hammer the user's own provider. */
export async function customCatalogFor(account: ModelAccount): Promise<CustomCatalog> {
  const now = Date.now()
  const cached = catalogCache.get(account.userId)
  if (cached && cached.expiresAt > now) return cached.catalog
  const catalog = await loadCustomCatalog(account)
  catalogCache.set(account.userId, { expiresAt: now + CATALOG_CACHE_TTL_MS, catalog })
  return catalog
}

interface ProbeOptions {
  origin: string
  apiKey: string | undefined
  model: string
  vision: boolean
  label: string
}

/** The connect gate: one request proving endpoint, key, model, tool calling
 *  and (when claimed) image input. */
async function probe(options: ProbeOptions): Promise<void> {
  const { origin, apiKey, model, vision, label } = options
  const prompt = 'Call the doop_ping tool now.'
  const message = vision
    ? {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: PIXEL_PNG } },
        ],
      }
    : { role: 'user', content: prompt }
  let result
  try {
    result = await customFetch({
      origin,
      path: CUSTOM_CHAT_PATH,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey || CUSTOM_KEY_PLACEHOLDER}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [message],
        tools: [
          {
            type: 'function',
            function: {
              name: 'doop_ping',
              description: 'Confirm the model can call tools.',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
          },
        ],
        tool_choice: 'auto',
        max_tokens: 32,
      }),
      timeoutMs: TURN_TOTAL_TIMEOUT_MS,
      headersTimeoutMs: TURN_HEADERS_TIMEOUT_MS,
      maxBytes: COMPLETION_MAX_BYTES,
    })
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Could not reach the endpoint.', { cause: error })
  }
  if (result.status >= 300 && result.status < 400) {
    throw new Error(customHttpMessage(result, label, apiKey))
  }
  if (!result.ok) {
    if (vision && (result.status === 400 || result.status === 422)) {
      throw new Error(
        'The model rejected the image — untick “can see screenshots” and try again. ' +
          customProviderDetail(result.text, apiKey),
      )
    }
    throw new Error(customHttpMessage(result, label, apiKey))
  }
  const bodyError = customBodyError(result.text, apiKey)
  if (bodyError) throw new Error(`${label}: ${bodyError}`)
  let body: { choices?: { message?: { tool_calls?: unknown[] } }[] }
  try {
    body = JSON.parse(result.text) as typeof body
  } catch {
    throw new Error('Endpoint returned non-JSON — check the base URL.')
  }
  const toolCalls = body.choices?.[0]?.message?.tool_calls
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw new Error(
      'That provider did not make a tool call. The Doop Agent needs function calling to run — check the model supports tools.',
    )
  }
}

/** One row per user and kind: write the whole custom row and switch it on. */
async function saveCustomAccount(account: {
  userId: string
  baseUrl: string
  label: string
  apiKey: string | null
  model: string
  vision: boolean
  maxOutputTokens: number
}): Promise<void> {
  const now = Date.now()
  const row = {
    userId: account.userId,
    kind: 'custom',
    enabled: true,
    accountId: null,
    email: null,
    plan: null,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    apiKey: account.apiKey,
    model: account.model,
    reasoningEffort: null,
    baseUrl: account.baseUrl,
    label: account.label,
    vision: account.vision,
    maxOutputTokens: account.maxOutputTokens,
    connectedAt: now,
    updatedAt: now,
  }
  await db
    .insert(modelAccounts)
    .values(row)
    .onConflictDoUpdate({
      target: [modelAccounts.userId, modelAccounts.kind],
      set: {
        enabled: true,
        apiKey: row.apiKey,
        model: row.model,
        baseUrl: row.baseUrl,
        label: row.label,
        vision: row.vision,
        maxOutputTokens: row.maxOutputTokens,
        updatedAt: row.updatedAt,
      },
    })
}

/* connect/probe attempts are capped per user; in-memory is enough for a
   single-process app and resets with the server */
const attempts = new Map<string, number[]>()

export function takeCustomConnectAttempt(userId: string, now = Date.now()): boolean {
  const cutoff = now - 60_000
  const recent = (attempts.get(userId) ?? []).filter((at) => at > cutoff)
  if (recent.length >= CONNECT_ATTEMPTS_PER_MIN) {
    attempts.set(userId, recent)
    return false
  }
  recent.push(now)
  attempts.set(userId, recent)
  return true
}

/** test hook: forget every rate-limit window and cached catalog */
export function resetCustomRateLimits(): void {
  attempts.clear()
  catalogCache.clear()
}

/** Connect or rotate the one custom provider. Nothing is written until the
 *  probe succeeds, so a failed attempt leaves the previous row intact. */
export async function connectCustom(userId: string, input: ConnectInput): Promise<void> {
  const policy = customEndpointPolicy()
  if (policy === 'off') throw new CustomDisabledError('Custom provider connections are disabled on this server')
  if (!takeCustomConnectAttempt(userId)) {
    throw new CustomRateLimitError('Too many connection attempts — wait a moment.')
  }
  const started = Date.now()
  let host = ''
  let scheme = ''
  let outcome = 'rejected:400'
  try {
    const previous = await getAccount(userId, 'custom')
    /* an omitted origin on a rotation keeps the stored one; it is screened
       again like any other */
    const rawBaseUrl = input.baseUrl === undefined ? previous?.baseUrl : input.baseUrl
    const origin = await screenCustomBaseUrl(rawBaseUrl, policy)
    host = customOriginHost(origin)
    scheme = new URL(origin).protocol.replace(':', '')
    /* plaintext http is allowed under `private` for LAN gateways; say once,
       at connect time, that the key now crosses the network in clear text */
    const warning = plaintextCustomOriginWarning(origin)
    if (warning) console.warn(`[custom-model] user=${userId} ${warning}`)

    const label = validateLabel(input.label, previous?.label || customOriginHost(origin) || 'Custom provider')

    /* apiKey: omitted keeps the stored key; an explicit empty string clears it */
    const apiKey = input.apiKey === undefined ? (previous?.apiKey ?? null) : validateApiKey(input.apiKey)

    const requestedModel = input.model === undefined ? undefined : cleanCustomModelId(input.model)
    if (input.model !== undefined && requestedModel === null) {
      throw new Error('Enter a valid model id (1–120 characters, no quotes or whitespace).')
    }

    const catalog = await fetchCatalog(origin, apiKey ?? undefined, policy)
    const catalogModel = catalog.models.find((model) => model.id === requestedModel)
    const model = requestedModel ?? previous?.model ?? catalog.models[0]?.id
    if (!model) throw new Error('Enter a model id — the provider did not list any.')

    const vision =
      input.vision === undefined
        ? (previous?.vision ?? false)
        : typeof input.vision === 'boolean'
          ? input.vision
          : false

    const maxOutputTokens =
      input.maxOutputTokens === undefined
        ? (previous?.maxOutputTokens ?? clampBudget(catalogModel?.maxCompletionTokens))
        : validateOutputTokens(input.maxOutputTokens)

    await probe({ origin, apiKey: apiKey ?? undefined, model, vision, label })
    await saveCustomAccount({ userId, baseUrl: origin, label, apiKey, model, vision, maxOutputTokens })
    clearCustomCatalogCache(userId)
    outcome = 'ok'
  } catch (error) {
    if (error instanceof CustomRateLimitError) throw error
    if (error instanceof Error && /too many connection attempts/i.test(error.message)) {
      outcome = 'rejected:429'
    }
    throw error
  } finally {
    console.log(
      `[custom-model] user=${userId} scheme=${scheme || 'unknown'} host=${host || 'unknown'} outcome=${outcome} duration=${Date.now() - started}ms`,
    )
  }
}

/** `PATCH` with exactly one field. Returns true when the write switched the
 *  account on, so the route can wake queued work. */
export async function patchCustom(userId: string, body: Record<string, unknown>): Promise<boolean> {
  const account = await getAccount(userId, 'custom')
  if (!account) throw new Error('that account is not connected')
  const fields = Object.keys(body).filter((key) => body[key] !== undefined)
  if (fields.length !== 1) throw new Error('change one setting at a time')
  const field = fields[0]!
  if (field === 'model') {
    const model = cleanCustomModelId(body.model)
    if (!model) throw new Error('Enter a valid model id (1–120 characters, no quotes or whitespace).')
    await writeOnly(userId, { model })
    return false
  }
  if (field === 'vision') {
    if (typeof body.vision !== 'boolean') throw new Error('vision must be true or false')
    await writeOnly(userId, { vision: body.vision })
    return false
  }
  if (field === 'maxOutputTokens') {
    await writeOnly(userId, { maxOutputTokens: validateOutputTokens(body.maxOutputTokens) })
    return false
  }
  if (field === 'enabled') {
    if (typeof body.enabled !== 'boolean') throw new Error('enabled must be true or false')
    await writeOnly(userId, { enabled: body.enabled })
    return body.enabled
  }
  throw new Error('unknown setting')
}

/** Write only the picked column, only onto the row that was read. */
async function writeOnly(
  userId: string,
  values: Partial<{ model: string; vision: boolean; maxOutputTokens: number; enabled: boolean }>,
): Promise<void> {
  const written = await db
    .update(modelAccounts)
    .set({ ...values, updatedAt: Date.now() })
    .where(and(eq(modelAccounts.userId, userId), eq(modelAccounts.kind, 'custom')))
    .returning({ userId: modelAccounts.userId })
  if (!written.length) throw new Error('the connected account changed — try again')
  clearCustomCatalogCache(userId)
}

/** The transport config for one custom account: the stored origin (never a
 *  URL), the sealed key, the account's budget and vision flag. The custom
 *  config type sends every request through the guarded transport, so a caller
 *  cannot construct one that skips it. */
export function customChatConfig(account: ModelAccount): CustomChatCompletionsConfig {
  if (!account.baseUrl) throw new ModelConfigurationError('Reconnect the custom provider in Settings.')
  const model = accountModelFor(account)
  if (!model) throw new ModelConfigurationError('Pick a model for the custom provider in Settings.')
  return {
    kind: 'custom',
    origin: account.baseUrl,
    apiKey: account.apiKey ?? undefined,
    model,
    label: account.label || 'Custom provider',
    vision: account.vision === true,
    maxTokens: account.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
  }
}

/* exported for tests: the catalog parser is pure */
export const _internal = { parseCatalog, isNonChatId }
