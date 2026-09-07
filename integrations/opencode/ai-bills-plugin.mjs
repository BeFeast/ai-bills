import { randomUUID } from 'node:crypto';

/** OpenCode loads this plugin only in the managed provider instance. */
export default async function aiBillsPlugin(_input, options = {}) {
  const providerId = options.providerId || 'ai-bills';
  return {
    'chat.headers': async (input, output) => {
      if (input.model?.providerID !== providerId) return;
      if (typeof input.sessionID !== 'string' || !input.sessionID || typeof input.message?.id !== 'string' || !input.message.id) {
        throw new Error('Managed routing requires a stable OpenCode session and message identity');
      }
      output.headers['X-Session-ID'] = `opencode:${input.sessionID}`;
      output.headers['X-Client-Turn-ID'] = input.message.id;
      // A single user message can produce many inference calls during tool use.
      // Each hook invocation gets its own logical call identity; retries inside
      // that SDK call reuse this headers object. Never reuse the turn ID alone.
      output.headers['X-Request-ID'] = `opencode:${input.message.id}:${randomUUID()}`;
    },
  };
}
