import * as z from 'zod'
import { describe, expect, it } from 'vitest'
import { MCP_TOOLS, isMcpToolName } from '../src/mcp-tools'
import { DAEMON_METHODS, EXTENSION_CAPABILITIES, EXTENSION_METHODS } from '../src/rpc'

describe('MCP tool contracts', () => {
  it('exposes exactly the six browser tools with client-safe names', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
      'browser_list_targets',
      'browser_read_page',
      'browser_act',
      'browser_get_devtools_errors',
      'browser_capture_network_api',
      'browser_screenshot',
    ])
    for (const tool of MCP_TOOLS) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
      expect(tool.description.length).toBeGreaterThan(80)
      // Every input schema must convert to JSON Schema (what MCP clients receive).
      const json = z.toJSONSchema(tool.inputSchema) as { type?: string }
      expect(json.type).toBe('object')
    }
    expect(isMcpToolName('browser_act')).toBe(true)
    expect(isMcpToolName('browser_set_role')).toBe(false)
  })

  it('validates refs and target ids strictly', () => {
    const act = MCP_TOOLS[2].inputSchema
    expect(act.safeParse({ action: 'click', ref: 'e12' }).success).toBe(true)
    expect(act.safeParse({ action: 'click', ref: '12' }).success).toBe(false)
    expect(act.safeParse({ action: 'click', target_id: 'abc' }).success).toBe(false)
    expect(act.safeParse({ action: 'fly' }).success).toBe(false)
  })
})

describe('RPC contracts', () => {
  it('declares every extension method as a capability', () => {
    expect([...EXTENSION_CAPABILITIES].sort()).toEqual(Object.keys(EXTENSION_METHODS).sort())
  })

  it('rejects unknown params fields (strict)', () => {
    expect(EXTENSION_METHODS['system.echo'].params.safeParse({ nonce: 'n', extra: true }).success).toBe(false)
    expect(DAEMON_METHODS['agents.connect'].params.safeParse({ agentId: 'cursor' }).success).toBe(true)
    expect(DAEMON_METHODS['agents.connect'].params.safeParse({ agentId: 'notepad' }).success).toBe(false)
  })
})
