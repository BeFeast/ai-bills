import { describe, expect, it } from 'vitest';
import plugin from '../integrations/opencode/ai-bills-plugin.mjs';
import { buildConfig } from '../integrations/opencode/build-config.mjs';

describe('isolated OpenCode routing integration', () => {
  it('limits discovery to the authenticated client subset without embedding a credential', () => {
    const result = buildConfig({ data: [{ id: 'coding-role', tool_call: true, context_length: 64000, max_output_tokens: 8000 }, { id: 'model-a' }] }, { baseURL: 'https://routing.invalid/v1', pluginPath: '/fixture/plugin.mjs', defaultModel: 'coding-role' });
    expect(result.enabled_providers).toEqual(['ai-bills']);
    expect(result.provider['ai-bills'].whitelist).toEqual(['coding-role', 'model-a']);
    expect(result.provider['ai-bills'].models['coding-role'].tool_call).toBe(true);
    expect(result.provider['ai-bills'].models['coding-role'].limit).toEqual({ context: 64000, output: 8000 });
    expect(result.provider['ai-bills'].models['model-a'].tool_call).toBe(false);
    expect(result.provider['ai-bills'].options.apiKey).toBe('{env:AI_BILLS_CLIENT_KEY}');
    expect(result.model).toBe('ai-bills/coding-role');
    expect(() => buildConfig({ data: [{ id: 'model-a' }] }, { baseURL: 'https://routing.invalid/v1', pluginPath: '/fixture/plugin.mjs', defaultModel: 'outside' })).toThrow(/outside/);
  });
  it('preserves session identity while making separate calls within a tool loop distinct', async () => {
    const hooks = await plugin({});
    const input = { sessionID: 'session-a', model: { providerID: 'ai-bills' }, message: { id: 'message-a' } };
    const first = { headers: {} as Record<string, string> }; const second = { headers: {} as Record<string, string> };
    await hooks['chat.headers'](input, first); await hooks['chat.headers'](input, second);
    expect(first.headers['X-Session-ID']).toBe('opencode:session-a');
    expect(first.headers['X-Client-Turn-ID']).toBe('message-a');
    expect(first.headers['X-Request-ID']).not.toBe(second.headers['X-Request-ID']);
    expect(first.headers['X-Request-ID']).toMatch(/^opencode:message-a:/);
  });
  it('does not alter unrelated providers or invent a missing session identity', async () => {
    const hooks = await plugin({});
    const output = { headers: { existing: 'preserved' } };
    await hooks['chat.headers']({ sessionID: 's', model: { providerID: 'other' }, message: { id: 'm' } }, output);
    expect(output.headers).toEqual({ existing: 'preserved' });
    await expect(hooks['chat.headers']({ model: { providerID: 'ai-bills' } }, output)).rejects.toThrow(/stable/);
  });
});
