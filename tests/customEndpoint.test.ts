import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyCustomAddress,
  cleanCustomModelId,
  normalizeCustomBaseUrl,
  plaintextCustomOriginWarning,
  resolveCustomEndpoint,
  screenCustomBaseUrl,
} from '../server/customEndpoint.ts'
import { unstubAllEnvs } from './envStub.ts'

/**
 * The custom-provider origin is untrusted input that the server fetches from.
 * These pin the shape rules (AC5), the address classifier (AC3/AC4) and the
 * opaque model-id rule (AC9) without any network I/O.
 */

afterEach(unstubAllEnvs)

describe('normalizeCustomBaseUrl', () => {
  it('stores the origin for every accepted form in the spec table', () => {
    expect(normalizeCustomBaseUrl('https://api.9router.dev', 'public')).toBe('https://api.9router.dev')
    expect(normalizeCustomBaseUrl('https://api.9router.dev/v1', 'public')).toBe('https://api.9router.dev')
    expect(normalizeCustomBaseUrl('https://api.9router.dev/v1/', 'public')).toBe('https://api.9router.dev')
    expect(normalizeCustomBaseUrl('http://127.0.0.1:20128/v1', 'private')).toBe('http://127.0.0.1:20128')
    expect(normalizeCustomBaseUrl('http://localhost:20128/v1', 'private')).toBe('http://localhost:20128')
    expect(normalizeCustomBaseUrl('http://10.0.0.5:4000/v1', 'private')).toBe('http://10.0.0.5:4000')
  })

  it('rejects a path deeper than the /v1 root', () => {
    for (const bad of [
      'https://router.example.com/api',
      'https://router.example.com/openai/v1',
      'https://router.example.com/v1/chat/completions',
    ]) {
      expect(() => normalizeCustomBaseUrl(bad, 'public')).toThrow(/origin or its \/v1 root/)
    }
  })

  it('rejects credentials, query strings, fragments and backslash tricks', () => {
    for (const bad of [
      'https://user:pass@router.example.com',
      'https://router.example.com?x=1',
      'https://router.example.com#frag',
      'https://router.example.com\\@evil.example',
    ]) {
      expect(() => normalizeCustomBaseUrl(bad, 'public')).toThrow()
    }
  })

  it('accepts http syntax only under the private policy', () => {
    expect(() => normalizeCustomBaseUrl('http://api.9router.dev/v1', 'public')).toThrow(/https:\/\//)
    expect(normalizeCustomBaseUrl('http://api.9router.dev/v1', 'private')).toBe('http://api.9router.dev')
    /* private mode still refuses http to a public address once it resolves */
    return expect(screenCustomBaseUrl('http://8.8.8.8/v1', 'private')).rejects.toThrow(/https:\/\//)
  })

  it('rejects empty, over-long and non-http schemes', () => {
    expect(() => normalizeCustomBaseUrl('', 'public')).toThrow()
    expect(() => normalizeCustomBaseUrl('   ', 'public')).toThrow()
    expect(() => normalizeCustomBaseUrl(`https://a.example/${'x'.repeat(2_100)}`, 'public')).toThrow(/too long/)
    expect(() => normalizeCustomBaseUrl('ftp://router.example.com', 'public')).toThrow()
  })

  it('is disabled entirely when the policy is off', () => {
    expect(() => normalizeCustomBaseUrl('https://api.9router.dev', 'off')).toThrow(/disabled/)
  })
})

describe('plaintextCustomOriginWarning', () => {
  it('warns once for http to a non-loopback host, and never for loopback or https (F3)', () => {
    const warning = plaintextCustomOriginWarning('http://192.168.1.10:4000')
    expect(warning).toMatch(/http:\/\/192\.168\.1\.10:4000/)
    expect(warning).toMatch(/unencrypted/)
    /* one warning per origin and process */
    expect(plaintextCustomOriginWarning('http://192.168.1.10:4000')).toBeNull()

    for (const quiet of [
      'http://127.0.0.1:4000',
      'http://[::1]:4000',
      'http://localhost:4000',
      'https://192.168.1.10:4000',
    ]) {
      expect(plaintextCustomOriginWarning(quiet)).toBeNull()
    }
  })
})

describe('classifyCustomAddress', () => {
  it('separates public, private, metadata and always-blocked ranges', () => {
    expect(classifyCustomAddress('8.8.8.8')).toBe('public')
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '::1', 'fc00::1']) {
      expect(classifyCustomAddress(ip)).toBe('private')
    }
    for (const ip of ['169.254.169.254', '100.100.100.200', 'fd00:ec2::254']) {
      expect(classifyCustomAddress(ip)).toBe('metadata')
    }
    for (const ip of ['0.0.0.0', '100.64.0.1', '192.0.2.1', '224.0.0.1', 'fe80::1', 'ff02::1']) {
      expect(classifyCustomAddress(ip)).toBe('blocked')
    }
  })

  it('reads IPv4-mapped IPv6 in both spellings as the IPv4 address', () => {
    expect(classifyCustomAddress('::ffff:127.0.0.1')).toBe('private')
    expect(classifyCustomAddress('::ffff:7f00:1')).toBe('private')
    expect(classifyCustomAddress('::ffff:8.8.8.8')).toBe('public')
  })
})

describe('screenCustomBaseUrl', () => {
  it('refuses private addresses under the public policy without fetching', async () => {
    for (const url of [
      'https://127.0.0.1/v1',
      'https://10.0.0.5/v1',
      'https://172.16.0.5/v1',
      'https://192.168.0.5/v1',
      'https://169.254.169.254/v1',
      'https://100.64.0.5/v1',
      'https://[::1]/v1',
    ]) {
      await expect(screenCustomBaseUrl(url, 'public')).rejects.toThrow()
    }
  })

  it('admits loopback and RFC1918 under the private policy', async () => {
    await expect(screenCustomBaseUrl('http://127.0.0.1:20128/v1', 'private')).resolves.toBe('http://127.0.0.1:20128')
    await expect(screenCustomBaseUrl('http://10.0.0.5:4000/v1', 'private')).resolves.toBe('http://10.0.0.5:4000')
  })

  it('blocks metadata even under the private policy', async () => {
    await expect(screenCustomBaseUrl('http://169.254.169.254/v1', 'private')).rejects.toThrow(/metadata/)
    await expect(screenCustomBaseUrl('http://100.100.100.200/v1', 'private')).rejects.toThrow(/metadata/)
  })

  it('resolves every address and refuses when any is not allowed', async () => {
    await expect(resolveCustomEndpoint('https://127.0.0.1', 'public')).rejects.toThrow(/private to the server/)
  })
})

describe('custom model ids are opaque', () => {
  it('accepts slugs, namespaced ids and tagged local ids byte-for-byte', () => {
    for (const id of [
      'anthropic/claude-opus-4-6',
      '9router/auto',
      'premium-coding',
      'moonshotai/kimi-k3',
      'qwen3:32b',
      'meta.llama-4',
      '@cf/meta/llama-3.1-8b-instruct',
      'llama3.1:8b-instruct-q4_K_M',
    ]) {
      expect(cleanCustomModelId(id)).toBe(id)
    }
  })

  it('rejects empty, whitespace, over-long and quote/backslash ids', () => {
    expect(cleanCustomModelId('')).toBeNull()
    expect(cleanCustomModelId(' ')).toBeNull()
    expect(cleanCustomModelId('x'.repeat(121))).toBeNull()
    expect(cleanCustomModelId('bad"id')).toBeNull()
    expect(cleanCustomModelId("bad'id")).toBeNull()
    expect(cleanCustomModelId('bad\\id')).toBeNull()
    expect(cleanCustomModelId('bad id')).toBeNull()
    expect(cleanCustomModelId(123)).toBeNull()
  })
})
