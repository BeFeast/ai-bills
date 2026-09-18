export function Sparkline({ values }: { values?: number[] | null }) {
  if (!values?.length) return <span className="t-small">n/a</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / Math.max(1, values.length - 1)) * 120).toFixed(1)},${(26 - ((v - min) / span) * 22).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="spark" width="120" height="28" viewBox="0 0 120 28" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
