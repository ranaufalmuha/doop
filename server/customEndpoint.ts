import dns from 'node:dns/promises'
import net from 'node:net'
import type { LookupFunction } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { env } from './env.ts'

/**
 * The one gate every user-supplied custom-provider origin passes through:
 * URL shape, endpoint policy, DNS classification, resolve-and-pin, and the
 * single guarded request helper used by connect, the catalog, the probe and
 * every completion turn.
 *
 * The origin is untrusted input that the server fetches from, so this module
 * is deliberately the only place that does it. No caller may build its own
 * URL or fetch; `customFetch` refuses any path other than the two literals the
 * spec allows, and it never follows a redirect.
 */

export type CustomEndpointPolicy = 'off' | 'public' | 'private'

export const CUSTOM_MODELS_PATH = '/v1/models'
export const CUSTOM_CHAT_PATH = '/v1/chat/completions'

/** The keyless-local placeholder 9Router and friends accept when they do not
 *  check keys. Not a secret, and never stored. */
export const CUSTOM_KEY_PLACEHOLDER = 'doop-local'

export const MAX_BASE_URL_LENGTH = 2_000
export const MAX_LABEL_LENGTH = 40
export const MAX_MODEL_ID_LENGTH = 120
export const MIN_OUTPUT_TOKENS = 1024
export const MAX_OUTPUT_TOKENS = 16_000
export const DEFAULT_OUTPUT_TOKENS = 8_192

export const CATALOG_MAX_BYTES = 2 * 1024 * 1024
export const COMPLETION_MAX_BYTES = 8 * 1024 * 1024
export const CATALOG_TIMEOUT_MS = 5_000
export const TURN_HEADERS_TIMEOUT_MS = 30_000
export const TURN_TOTAL_TIMEOUT_MS = 120_000
export const CONNECT_ATTEMPTS_PER_MIN = 10

export function customEndpointPolicy(): CustomEndpointPolicy {
  return env.CUSTOM_ENDPOINT_POLICY
}

/** Whether the custom-provider feature is on at all. `off` hides the row and
 *  makes every custom route answer 404. */
export function customEndpointsEnabled(): boolean {
  return customEndpointPolicy() !== 'off'
}

/* ---------------------------------------------------------------- */
/* address classification                                          */
/* ---------------------------------------------------------------- */

export type AddressClass = 'public' | 'private' | 'metadata' | 'blocked'

const metadata4 = new net.BlockList()
metadata4.addSubnet('169.254.0.0', 16, 'ipv4')
metadata4.addAddress('100.100.100.200', 'ipv4')
const metadata6 = new net.BlockList()
metadata6.addAddress('fd00:ec2::254', 'ipv6')

/* self-host networks the `private` policy admits: loopback, RFC1918, ULA */
const private4 = new net.BlockList()
for (const [network, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  private4.addSubnet(network, prefix, 'ipv4')
}
const private6 = new net.BlockList()
for (const [network, prefix] of [
  ['::1', 128],
  ['fc00::', 7],
] as const) {
  private6.addSubnet(network, prefix, 'ipv6')
}

/* never global: unspecified, CGNAT, link-local, documentation/benchmark,
   multicast and reserved space. All refused under either policy. */
const blocked4 = new net.BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked4.addSubnet(network, prefix, 'ipv4')
}
const blocked6 = new net.BlockList()
for (const [network, prefix] of [
  ['::', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked6.addSubnet(network, prefix, 'ipv6')
}

/** Read an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`, `::ffff:7f00:1`) as
 *  the IPv4 address it stands for, so the IPv4 rules decide it. */
function ipv4FromMapped(ip: string): string | null {
  const lower = ip.toLowerCase()
  const dotted = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) return dotted[1] ?? null
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16)
    const lo = Number.parseInt(hex[2]!, 16)
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
  }
  return null
}

export function classifyCustomAddress(raw: string): AddressClass {
  const ip = raw.replace(/^\[|\]$/g, '')
  const mapped = ipv4FromMapped(ip)
  if (mapped) return classifyCustomAddress(mapped)
  const family = net.isIP(ip)
  if (family === 4) {
    if (metadata4.check(ip, 'ipv4')) return 'metadata'
    if (private4.check(ip, 'ipv4')) return 'private'
    if (blocked4.check(ip, 'ipv4')) return 'blocked'
    return 'public'
  }
  if (family === 6) {
    if (metadata6.check(ip, 'ipv6')) return 'metadata'
    if (private6.check(ip, 'ipv6')) return 'private'
    if (blocked6.check(ip, 'ipv6')) return 'blocked'
    return 'public'
  }
  return 'blocked'
}

function addressAllowed(classification: AddressClass, policy: CustomEndpointPolicy): boolean {
  if (classification === 'metadata' || classification === 'blocked') return false
  if (policy === 'public') return classification === 'public'
  return classification === 'public' || classification === 'private'
}

const PRIVATE_REFUSED =
  "That URL is private to the server's own network — custom providers must be reachable from here."
const METADATA_REFUSED = 'That URL points at a cloud metadata service and is never allowed.'

/* ---------------------------------------------------------------- */
/* URL shape                                                       */
/* ---------------------------------------------------------------- */

/** The authority segment of a raw URL, before any path/query/fragment. */
function rawAuthority(value: string): string | null {
  const match = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)
  return match ? (match[1] ?? null) : null
}

/**
 * Trim, validate and reduce a provider base URL to the stored origin.
 * Accepts the origin or the `/v1` root the providers document, and nothing
 * deeper: the two request paths are literals. Throws a user-facing sentence.
 */
export function normalizeCustomBaseUrl(raw: unknown, policy: CustomEndpointPolicy = customEndpointPolicy()): string {
  if (policy === 'off') throw new Error('Custom provider connections are disabled on this server')
  if (typeof raw !== 'string') throw new Error('Enter the provider’s base URL')
  const value = raw.trim()
  if (!value) throw new Error('Enter the provider’s base URL')
  if (value.length > MAX_BASE_URL_LENGTH) throw new Error('That URL is too long')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('That is not a valid URL — use the server’s origin or its /v1 root.')
  }
  /* OWASP: the raw input and the parsed URL must agree on the host, so a
     backslash/userinfo trick cannot make the fetch target differ from what is
     validated. */
  const authority = rawAuthority(value)
  if (authority === null || authority.includes('\\')) {
    throw new Error('That is not a valid URL — use the server’s origin or its /v1 root.')
  }
  const parsedHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const authorityHost = authority
    .replace(/^.*@/, '')
    .replace(/:\d+$/, '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (authorityHost !== parsedHost) {
    throw new Error('That is not a valid URL — use the server’s origin or its /v1 root.')
  }
  if (url.username || url.password) throw new Error('The URL must not contain a username or password.')
  if (url.search || url.hash) throw new Error('The URL must not contain a query string or fragment.')
  const scheme = url.protocol
  if (scheme !== 'https:' && !(scheme === 'http:' && policy === 'private')) {
    throw new Error(
      scheme === 'http:'
        ? 'Custom providers must use https:// on this server.'
        : 'Use an https:// URL for the provider.',
    )
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (path !== '' && path !== '/v1') {
    throw new Error('Use the server’s origin or its /v1 root — nothing deeper.')
  }
  return `${url.protocol}//${url.host}`
}

export function parseCustomOrigin(origin: string): URL {
  const url = new URL(origin)
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('That is not a valid stored origin')
  }
  return url
}

/** The host a connection would contact, for the audit line and the UI. */
export function customOriginHost(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return ''
  }
}

/** True when a string carries an ASCII control character. Kept out of a
 *  regex so the lint rule against control-character patterns stays on. */
export function hasCustomControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return true
  }
  return false
}

/** Model ids are opaque: trimmed, 1–120 chars, no whitespace/control chars and
 *  no quote/backslash. Never split on `/` or infer anything from the name. */
export function cleanCustomModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (id.length < 1 || id.length > MAX_MODEL_ID_LENGTH) return null
  if (/\s/.test(id) || hasCustomControlChars(id)) return null
  if (/["'<>\\]/.test(id)) return null
  return id
}

export function isValidCustomModelId(value: unknown): value is string {
  return cleanCustomModelId(value) !== null
}

/* ---------------------------------------------------------------- */
/* resolve and pin                                                 */
/* ---------------------------------------------------------------- */

export interface ResolvedCustomEndpoint {
  url: URL
  host: string
  addresses: { address: string; family: 4 | 6 }[]
}

function refuseForClassification(classification: AddressClass, policy: CustomEndpointPolicy): never {
  /* under the public policy every refused address is "not reachable from
     here"; metadata gets its clearer sentence only in self-host mode */
  if (classification === 'metadata' && policy === 'private') throw new Error(METADATA_REFUSED)
  throw new Error(PRIVATE_REFUSED)
}

/** Resolve every A/AAAA record once and reject the whole connection when any
 *  address is not allowed by the policy. The returned addresses are the ones
 *  the request is pinned to. */
export async function resolveCustomEndpoint(
  origin: string,
  policy: CustomEndpointPolicy = customEndpointPolicy(),
): Promise<ResolvedCustomEndpoint> {
  if (policy === 'off') throw new Error('Custom provider connections are disabled on this server')
  const url = parseCustomOrigin(origin)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const literalFamily = net.isIP(host)
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily as 4 | 6 }]
    : ((await dns.lookup(host, { all: true, verbatim: true })) as { address: string; family: 4 | 6 }[])
  if (!addresses.length) throw new Error('Could not reach the endpoint — the host did not resolve.')
  const classes = addresses.map((address) => classifyCustomAddress(address.address))
  /* `private` admits http, but only for a self-host endpoint: an http URL to a
     public address is refused even in private mode. */
  if (url.protocol === 'http:' && classes.some((classification) => classification === 'public')) {
    throw new Error('Custom providers must use https:// on this server.')
  }
  addresses.forEach((address, index) => {
    const classification = classes[index]!
    if (!addressAllowed(classification, policy)) refuseForClassification(classification, policy)
  })
  return { url, host, addresses }
}

/** Syntax + DNS classification, without sending anything. The connect route
 *  calls this before it fetches or writes a row. */
export async function screenCustomBaseUrl(
  raw: unknown,
  policy: CustomEndpointPolicy = customEndpointPolicy(),
): Promise<string> {
  const origin = normalizeCustomBaseUrl(raw, policy)
  await resolveCustomEndpoint(origin, policy)
  return origin
}

/** A lookup pinned to the addresses already classified, preserving Host/SNI
 *  and certificate validation. This is the DNS-rebinding defence. */
export function createCustomPinnedLookup(
  expectedHost: string,
  addresses: { address: string; family: 4 | 6 }[],
): LookupFunction {
  const expected = expectedHost.toLowerCase().replace(/\.$/, '')
  return (hostname, options, callback) => {
    if (hostname.toLowerCase().replace(/\.$/, '') !== expected) {
      const error = Object.assign(new Error('unexpected hostname during pinned request'), { code: 'ENOTFOUND' })
      callback(error, '', 0)
      return
    }
    const family = typeof options === 'number' ? options : options.family
    const candidates = family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses
    const first = candidates[0]
    if (!first) {
      const error = Object.assign(new Error('no approved address for requested family'), { code: 'ENOTFOUND' })
      callback(error, '', 0)
      return
    }
    if (typeof options === 'object' && options.all) callback(null, candidates)
    else callback(null, first.address, first.family)
  }
}

/* ---------------------------------------------------------------- */
/* one guarded request                                             */
/* ---------------------------------------------------------------- */

export interface CustomRequest {
  origin: string
  /** one of the two literal paths; anything else is refused */
  path: typeof CUSTOM_MODELS_PATH | typeof CUSTOM_CHAT_PATH
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs: number
  /** wait for response headers; defaults to the overall timeout */
  headersTimeoutMs?: number
  maxBytes: number
  policy?: CustomEndpointPolicy
}

export interface CustomFetchResult {
  status: number
  ok: boolean
  contentType: string
  retryAfter: string | null
  text: string
}

async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error('The provider response was too large.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * Resolve, classify, pin and perform exactly one request. Redirects are never
 * followed; the response body is read through a hard byte cap; a timeout and
 * the caller's abort signal both cancel the request immediately.
 */
export async function customFetch(req: CustomRequest): Promise<CustomFetchResult> {
  if (req.path !== CUSTOM_MODELS_PATH && req.path !== CUSTOM_CHAT_PATH) {
    throw new Error('refusing a non-literal custom endpoint path')
  }
  const policy = req.policy ?? customEndpointPolicy()
  const resolved = await resolveCustomEndpoint(req.origin, policy)
  const url = new URL(req.path, resolved.url)
  if (url.host !== resolved.url.host) throw new Error('refusing a request whose host changed')

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('custom request timed out'))
  }, req.timeoutMs)
  timer.unref?.()
  const forwardAbort = () => controller.abort(req.signal?.reason)
  if (req.signal) {
    if (req.signal.aborted) controller.abort(req.signal.reason)
    else req.signal.addEventListener('abort', forwardAbort, { once: true })
  }
  const dispatcher = new Agent({
    connect: { lookup: createCustomPinnedLookup(resolved.host, resolved.addresses) },
    connections: 1,
    pipelining: 0,
    headersTimeout: req.headersTimeoutMs ?? req.timeoutMs,
    bodyTimeout: req.timeoutMs,
  })
  try {
    const response = await undiciFetch(url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      redirect: 'manual',
      signal: controller.signal,
      dispatcher,
    })
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > req.maxBytes) {
      await response.body?.cancel().catch(() => {})
      throw new Error('The provider response was too large.')
    }
    const body = await readCapped(response.body as unknown as ReadableStream<Uint8Array> | null, req.maxBytes)
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      contentType: response.headers.get('content-type') ?? '',
      retryAfter: response.headers.get('retry-after'),
      text: body.toString('utf8'),
    }
  } catch (error) {
    if (timedOut) throw new Error('Could not reach the endpoint — the request timed out.', { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
    req.signal?.removeEventListener('abort', forwardAbort)
    void dispatcher.close().catch(() => {})
  }
}

/* ---------------------------------------------------------------- */
/* error detail                                                    */
/* ---------------------------------------------------------------- */

const DETAIL_LIMIT = 300

/** Pull a human sentence out of any of the provider error shapes, cap it, and
 *  scrub the account key before it can reach a log or the browser. */
export function customProviderDetail(text: string, apiKey?: string): string {
  let detail = ''
  try {
    const body = JSON.parse(text) as unknown
    if (typeof body === 'string') detail = body
    else if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>
      const nested = record.error
      if (typeof nested === 'string') detail = nested
      else if (nested && typeof nested === 'object') {
        const error = nested as Record<string, unknown>
        detail =
          (typeof error.message === 'string' && error.message) || (typeof error.code === 'string' && error.code) || ''
      }
      if (!detail && typeof record.detail === 'string') detail = record.detail
      if (!detail && typeof record.message === 'string') detail = record.message
    }
  } catch {
    detail = text
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  detail = detail.slice(0, DETAIL_LIMIT)
  if (apiKey && apiKey.length > 0) detail = detail.split(apiKey).join('[redacted]')
  return detail.split(CUSTOM_KEY_PLACEHOLDER).join('[redacted]')
}

/** Whether a 2xx body is actually an error (OpenRouter-style). Returns the
 *  detail when so. The caller passes the account key so the detail reaches no
 *  error surface unscrubbed. */
export function customBodyError(text: string, apiKey?: string): string | null {
  try {
    const body = JSON.parse(text) as { error?: unknown } | null
    if (!body || typeof body !== 'object') return null
    const error = body.error
    if (!error) return null
    return customProviderDetail(text, apiKey)
  } catch {
    return null
  }
}

export function retryAfterSeconds(retryAfter: string | null): number | null {
  if (!retryAfter) return null
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const at = Date.parse(retryAfter)
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000))
  return null
}

/** The connect/catalog-facing sentence for one upstream status. */
export function customHttpMessage(
  result: { status: number; retryAfter: string | null; text: string },
  label: string,
  apiKey?: string,
): string {
  const detail = customProviderDetail(result.text, apiKey)
  if (result.status >= 300 && result.status < 400) {
    return 'Endpoint redirected — use the final base URL.'
  }
  switch (result.status) {
    case 401:
      return 'Authentication failed — check the API key.'
    case 403:
      return 'Key is valid but this model or endpoint is not allowed.'
    case 404:
      return `Endpoint or model not found — check the base URL and the model id.${detail ? ` ${detail}` : ''}`
    case 400:
    case 422:
      return `The model rejected the request.${detail ? ` ${detail}` : ''} Check that it supports tools, images and the output budget.`
    case 429: {
      const seconds = retryAfterSeconds(result.retryAfter)
      return seconds === null ? 'Rate limited — retry in a moment.' : `Rate limited — retry in ${seconds}s.`
    }
    case 500:
    case 502:
    case 503:
    case 504:
      return 'Provider unavailable.'
    default:
      return `${label} request failed (${result.status}).${detail ? ` ${detail}` : ''}`
  }
}
