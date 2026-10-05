'use client';
import { useEffect, useState } from 'react';
import { Button, Notice } from './ui';

const names: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', kimi: 'Kimi' };
export function DesktopBarSettings({ providers }: { providers: string[] }) {
  const [selection, setSelection] = useState<string[] | null>(null);
  const [editable, setEditable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const available = [...new Set([...providers, ...(selection ?? [])])].sort();
  const shown = selection ?? available.slice(0, 8);
  useEffect(() => {
    let active = true;
    fetch('/api/widget/preferences', { cache: 'no-store' }).then(async r => {
      if (!r.ok) throw new Error('Could not load desktop bar settings');
      const data = await r.json();
      if (active) { setSelection(data.providers); setEditable(data.editable); setLoaded(true); }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  async function save() {
    setBusy(true); setMessage(''); setError('');
    try {
      const r = await fetch('/api/widget/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providers: selection }) });
      if (!r.ok) throw new Error((await r.json()).error || 'Could not save settings');
      setMessage('Saved. Your desktop bars update on their next refresh.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save settings'); }
    finally { setBusy(false); }
  }
  function move(index: number, by: number) {
    const next = [...shown]; [next[index], next[index + by]] = [next[index + by], next[index]]; setSelection(next); setMessage('');
  }
  return <section className="desktop-bar-settings">
    <h2>Desktop bar</h2>
    <p>A small meter for each provider, shared by your macOS and Linux bars. Full means more quota remains; an empty outline means none; a dash means unknown.</p>
    <div className="desktop-bar-preview" aria-label="Bar layout preview">
      <span aria-hidden="true">Ⓩ</span>{shown.map(p => <span key={p} className="desktop-bar-meter" title={names[p] ?? p}><span /></span>)}
      <span className="muted">Layout preview</span>
    </div>
    {error && <Notice tone="bad">{error}</Notice>}
    {message && <Notice tone="ok">{message}</Notice>}
    {loaded && !editable && <p>Only an administrator can change these shared settings.</p>}
    <fieldset disabled={!loaded || !editable || busy}>
      <legend>Providers · left to right</legend>
      {shown.map((p, i) => <div key={p} className="desktop-bar-provider">
        <label><input type="checkbox" checked onChange={() => { setSelection(shown.filter(x => x !== p)); setMessage(''); }} /> {names[p] ?? p}</label>
        <Button variant="ghost" size="sm" disabled={i === 0} aria-label={`Move ${names[p] ?? p} left`} onClick={() => move(i, -1)}>←</Button>
        <Button variant="ghost" size="sm" disabled={i === shown.length - 1} aria-label={`Move ${names[p] ?? p} right`} onClick={() => move(i, 1)}>→</Button>
      </div>)}
      {available.filter(p => !shown.includes(p)).map(p => <div key={p} className="desktop-bar-provider"><label><input type="checkbox" checked={false} disabled={shown.length >= 8} onChange={() => { setSelection([...shown, p]); setMessage(''); }} /> {names[p] ?? p}</label></div>)}
      {!shown.length && <p>Only the Zecori icon will appear.</p>}
      <p>Each meter averages known accounts equally. Hover over the bar for exact values; click for account details.</p>
      <div className="toolbar"><Button onClick={save}>{busy ? 'Saving…' : 'Save'}</Button><Button variant="secondary" onClick={() => { setSelection(null); setMessage(''); }}>Use automatic selection</Button></div>
    </fieldset>
  </section>;
}
