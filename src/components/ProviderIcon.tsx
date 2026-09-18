const icons: Record<string, string> = {
  anthropic: 'claude', claude: 'claude',
  openai: 'openai', chatgpt: 'openai', codex: 'codex',
  google: 'google', gemini: 'gemini',
  kimi: 'kimi', moonshot: 'kimi', moonshotai: 'kimi',
  cursor: 'cursor', grok: 'grok', xai: 'grok',
  opencode: 'opencode', opencodesst: 'opencode',
  ollama: 'ollama', ollamacloud: 'ollama', suno: 'suno',
};

/** Decorative mark beside the visible provider or account label, always on a white tile so dark marks survive the dark scheme. */
export function ProviderIcon({ provider, size = 26 }: { provider: string; size?: 20 | 24 | 26 | 32 }) {
  const icon = icons[provider.toLowerCase().replace(/[^a-z0-9]/g, '')];
  const style = { '--tile': `${size}px`, '--tile-radius': `${Math.round(size * 0.24)}px` } as React.CSSProperties;
  return icon
    ? <span className="provider-tile" style={style} aria-hidden="true"><img className="provider-icon" src={`/provider-icons/${icon}.svg`} width={Math.round(size * 0.7)} height={Math.round(size * 0.7)} alt="" /></span>
    : <span className="provider-tile provider-tile--fallback" style={style} aria-hidden="true">{provider.trim().slice(0, 2).toUpperCase() || '?'}</span>;
}
