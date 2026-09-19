/** Zecori product identity on top of the BeFeast design system: the character mark and the outlined wordmark.
 * Assets ship from public/brand; the working UI keeps BeFeast tokens, only these marks carry the character's palette. */
export const PRODUCT_NAME = 'Zecori';
export const PRODUCT_TAGLINE = 'your AI treasurer';
export const PRODUCT_ATTRIBUTION = 'by BeFeast';

export function ZecoriMark({ size = 32, className = '' }: { size?: 32 | 56 | 72; className?: string }) {
  // Serve a 2x source for crisp rendering on dense displays; the avatar keeps its opaque ivory background.
  const source = size <= 32 ? '/brand/zecori-avatar-64.png' : '/brand/zecori-avatar-128.png';
  return <img className={`zecori-mark${className ? ` ${className}` : ''}`} src={source} width={size} height={size} alt="" style={{ width: size, height: size }} />;
}

/** Outlined vector lettering, one variant per scheme; the text stays available to assistive technology. */
export function ZecoriWordmark({ height = 16 }: { height?: number }) {
  return <span className="zecori-wordmark" role="img" aria-label={PRODUCT_NAME} style={{ height }}>
    <img className="zecori-wordmark__light" src="/brand/zecori-wordmark.svg" alt="" height={height} />
    <img className="zecori-wordmark__dark" src="/brand/zecori-wordmark-inverse.svg" alt="" height={height} />
  </span>;
}

/** Sidebar signature: a small ledger mark, the product line and the BeFeast attribution. Mono, three lines, no timezone noise. */
export function ZecoriSignature({ version }: { version: string }) {
  return <pre className="zecori-signature" aria-label={`${PRODUCT_NAME} keeps the books. Version ${version}. By BeFeast.`}>
{`┌─┐
│¤│  Zecori keeps the books.
└─┘  v${version} · `}<a href="https://befeast.com" target="_blank" rel="noreferrer">befeast.com</a>
  </pre>;
}
