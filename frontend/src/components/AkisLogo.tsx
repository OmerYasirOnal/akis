/**
 * The official AKIS brand mark (frontend/public/akis-mark.svg — the real logo, teal
 * #3ECFA0, transparent). Rendered as an <img> so it stays pixel-perfect at any size;
 * add a glow with a `drop-shadow-[…]` className from the caller.
 */
export function AkisLogo({ size = 40, className = '', alt = 'AKIS' }: { size?: number; className?: string; alt?: string }) {
  // Pass alt="" for decorative instances sitting next to a visible "AKIS" wordmark.
  return <img src="/akis-mark.svg" alt={alt} width={size} height={size} className={className} style={{ width: size, height: size }} />
}
