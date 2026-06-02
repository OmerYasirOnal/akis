/**
 * The official AKIS brand mark (frontend/public/akis-mark.svg — the real logo, teal
 * #3ECFA0, transparent). Rendered as an <img> so it stays pixel-perfect at any size;
 * add a glow with a `drop-shadow-[…]` className from the caller.
 */
export function AkisLogo({ size = 40, className = '' }: { size?: number; className?: string }) {
  return <img src="/akis-mark.svg" alt="AKIS" width={size} height={size} className={className} style={{ width: size, height: size }} />
}
