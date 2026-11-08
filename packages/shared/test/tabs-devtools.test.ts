import { describe, expect, it } from 'vitest'
import { classifyApiResponse, graphqlOperationName } from '../src/devtools'
import { isRestrictedUrl, tabIdFromTargetId, targetIdForTab } from '../src/tabs'

describe('tabs', () => {
  it('detects pages Chrome forbids', () => {
    expect(isRestrictedUrl('chrome://settings')).toBe(true)
    expect(isRestrictedUrl('chrome-extension://abc/page.html')).toBe(true)
    expect(isRestrictedUrl('https://chromewebstore.google.com/detail/x')).toBe(true)
    expect(isRestrictedUrl('')).toBe(true)
    expect(isRestrictedUrl('http://localhost:3000/')).toBe(false)
    expect(isRestrictedUrl('https://github.com/')).toBe(false)
  })

  it('round-trips target ids and refuses anything else', () => {
    expect(tabIdFromTargetId(targetIdForTab(1234))).toBe(1234)
    expect(tabIdFromTargetId('12a')).toBeNull()
    expect(tabIdFromTargetId('')).toBeNull()
  })
})

describe('api classification', () => {
  it('recognizes JSON and GraphQL', () => {
    expect(classifyApiResponse({ url: 'https://x.dev/api/items', mimeType: 'application/json' })).toBe('json')
    expect(classifyApiResponse({ url: 'https://x.dev/graphql', mimeType: 'application/json' })).toBe('graphql')
    expect(classifyApiResponse({ url: 'https://x.dev/api', mimeType: 'application/json', requestBody: '{"query":"query Me { me { id } }"}' })).toBe('graphql')
    expect(classifyApiResponse({ url: 'https://x.dev/a.png', mimeType: 'image/png' })).toBeNull()
  })

  it('extracts operation names', () => {
    expect(graphqlOperationName('{"operationName":"Viewer","query":"..."}')).toBe('Viewer')
    expect(graphqlOperationName('{"query":"mutation AddItem($a: Int) { add(a: $a) }"}')).toBe('AddItem')
    expect(graphqlOperationName('not json')).toBeUndefined()
  })
})
