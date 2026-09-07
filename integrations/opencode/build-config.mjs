import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Build from the authenticated client's catalog, never the global provider list.
 * Catalog metadata can be enriched privately with verified model capabilities.
 * @param {{data: Array<{id: string, name?: string, label?: string, tool_call?: boolean, attachment?: boolean, reasoning?: boolean, context_length?: number, max_output_tokens?: number, limit?: {context?: number, output?: number}, modalities?: object}>}} catalog
 * @param {{baseURL: string, pluginPath: string, providerId?: string, defaultModel?: string}} options
 */
export function buildConfig(catalog, options) {
  const { baseURL, pluginPath, providerId = 'ai-bills', defaultModel } = options;
  const endpoint = new URL(baseURL);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Expected a credential-free HTTP API endpoint');
  if (!Array.isArray(catalog.data) || !catalog.data.length) throw new Error('Client model catalog is empty');
  /** @type {Record<string, {name: string, tool_call: boolean, attachment: boolean, reasoning: boolean, limit: {context: number, output: number}, modalities?: object}>} */
  const models = {};
  for (const row of catalog.data) {
    if (typeof row.id !== 'string' || !row.id || row.id in models) throw new Error('Catalog model IDs must be nonempty and unique');
    const context = row.limit?.context ?? row.context_length ?? 32768;
    const output = row.limit?.output ?? row.max_output_tokens ?? 4096;
    if (!Number.isSafeInteger(context) || !Number.isSafeInteger(output) || context <= output || output <= 0) throw new Error('Invalid model limits');
    models[row.id] = {
      name: row.name || row.label || row.id,
      tool_call: row.tool_call === true,
      attachment: row.attachment === true,
      reasoning: row.reasoning === true,
      limit: { context, output },
      ...(row.modalities ? { modalities: row.modalities } : {}),
    };
  }
  if (defaultModel && !(defaultModel in models)) throw new Error('Default model is outside the client subset');
  return {
    $schema: 'https://opencode.ai/config.json',
    enabled_providers: [providerId],
    ...(defaultModel ? { model: `${providerId}/${defaultModel}` } : {}),
    plugin: [[pathToFileURL(resolve(pluginPath)).href, { providerId }]],
    provider: {
      [providerId]: {
        name: 'AI Bills managed routing',
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: endpoint.href.replace(/\/$/, ''), apiKey: '{env:AI_BILLS_CLIENT_KEY}' },
        whitelist: Object.keys(models),
        models,
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [catalogPath, baseURL, pluginPath, outputPath, defaultModel] = process.argv.slice(2);
  if (!catalogPath || !baseURL || !pluginPath || !outputPath) throw new Error('Usage: build-config.mjs CATALOG_JSON API_BASE PLUGIN_PATH OUTPUT_JSON [DEFAULT_MODEL]');
  const config = buildConfig(JSON.parse(readFileSync(catalogPath, 'utf8')), { baseURL, pluginPath, defaultModel });
  writeFileSync(outputPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
