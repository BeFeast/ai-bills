const icons: Record<string, string> = {
  anthropic: 'claude', claude: 'claude',
  openai: 'openai', chatgpt: 'openai', codex: 'codex',
  google: 'google', gemini: 'gemini',
  kimi: 'kimi', moonshot: 'kimi', moonshotai: 'kimi',
  cursor: 'cursor', grok: 'grok', xai: 'grok',
  opencode: 'opencode', opencodesst: 'opencode',
  ollama: 'ollama', ollamacloud: 'ollama', suno: 'suno',
};

/** Decorative beside the visible provider or account label. */
export function ProviderIcon({ provider }: { provider: string }) {
  const icon = icons[provider.toLowerCase().replace(/[^a-z0-9]/g, '')];
  return icon
    ? <img className="provider-icon" src={`/provider-icons/${icon}.svg`} width={26} height={26} alt="" aria-hidden="true" />
    : <span className="provider-icon provider-icon-fallback" aria-hidden="true">{provider.trim().slice(0, 2).toUpperCase() || '?'}</span>;
}
