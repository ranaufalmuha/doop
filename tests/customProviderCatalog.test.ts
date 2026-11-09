import { describe, expect, it } from 'vitest'
import { _internal } from '../server/customProvider.ts'

/**
 * The custom catalog is advisory: parse defensively, keep provider order, drop
 * only unambiguous non-chat modalities, de-duplicate, cap, and fall back to the
 * one stored id when the provider cannot be asked (AC8).
 *
 * The live end-to-end path (including the `live:false` fallback and the `off`
 * branch) is covered in tests/customProvider.test.ts; these pin the pure parser.
 */

const { parseCatalog } = _internal

const parseIds = (body: unknown) => parseCatalog(JSON.stringify(body)).map((model) => model.id)

describe('parseCatalog', () => {
  it('accepts the {data:[{id,name}]} shape and falls back to the id for a name', () => {
    const models = parseCatalog(JSON.stringify({ data: [{ id: 'a-model' }, { id: 'b-model', name: '  ' }] }))
    expect(models).toEqual([
      { id: 'a-model', name: 'a-model' },
      { id: 'b-model', name: 'b-model' },
    ])
  })

  it('returns no models for a non-array, a bad JSON body or a missing data key', () => {
    expect(parseCatalog('not json')).toEqual([])
    expect(parseCatalog('{"data":{}}')).toEqual([])
    expect(parseCatalog('{"models":[]}')).toEqual([])
  })

  it('keeps instruct/chat ids and drops embeddings, audio, image and realtime', () => {
    expect(
      parseIds({
        data: [
          { id: 'llama3.1:8b-instruct-q4_K_M' },
          { id: 'qwen2.5:7b-instruct' },
          { id: 'meta.llama-4-instruct' },
          { id: 'text-embedding-3-large' },
          { id: 'whisper-1' },
          { id: 'gpt-image-2' },
          { id: 'gpt-realtime' },
        ],
      }),
    ).toEqual(['llama3.1:8b-instruct-q4_K_M', 'qwen2.5:7b-instruct', 'meta.llama-4-instruct'])
  })

  it('matches non-chat tokens only in the last path segment, as whole tokens', () => {
    /* an earlier segment saying "image" is part of a namespace, not a modality */
    expect(parseIds({ data: [{ id: 'image-team/claude-chat' }] })).toEqual(['image-team/claude-chat'])
    /* "moderation" must not catch the substring in another word */
    expect(parseIds({ data: [{ id: 'moderationish-model' }] })).toEqual(['moderationish-model'])
  })

  it('de-duplicates while keeping the provider order', () => {
    expect(parseIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] })).toEqual(['b', 'a'])
  })

  it('drops ids that fail the opaque model-id rule', () => {
    expect(parseIds({ data: [{ id: '' }, { id: 'bad id' }, { id: 'x'.repeat(121) }, { id: 'good' }] })).toEqual([
      'good',
    ])
  })

  it('caps the list at 1000 entries', () => {
    const data = Array.from({ length: 1_005 }, (_, index) => ({ id: `model-${index}` }))
    expect(parseCatalog(JSON.stringify({ data }))).toHaveLength(1_000)
  })

  it('keeps a max_completion_tokens hint for the budget default', () => {
    expect(parseCatalog(JSON.stringify({ data: [{ id: 'small', max_completion_tokens: 2_048 }] }))).toEqual([
      { id: 'small', name: 'small', maxCompletionTokens: 2_048 },
    ])
  })
})
