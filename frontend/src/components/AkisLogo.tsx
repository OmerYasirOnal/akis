/**
 * The AKIS mark — a crisp "A" with three speed-lines, drawn as an inline SVG so it's
 * transparent (no PNG box), razor-sharp at any size, and tintable via the brand
 * gradient. Add a glow with a `drop-shadow-[…]` className from the caller.
 */
export function AkisLogo({ size = 40, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="AKIS" className={className}>
      <defs>
        <linearGradient id="akis-grad" x1="2" y1="6" x2="42" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2ee6c5" />
          <stop offset="0.55" stopColor="#07D1AF" />
          <stop offset="1" stopColor="#7c5cff" />
        </linearGradient>
      </defs>
      <g stroke="url(#akis-grad)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none">
        {/* the A */}
        <path d="M24 8 L11 40" />
        <path d="M24 8 L37 40" />
        <path d="M16.5 31 L31.5 31" />
        {/* speed lines */}
        <path d="M2 17 L13 17" />
        <path d="M0 24 L11 24" />
        <path d="M4 31 L9 31" />
      </g>
    </svg>
  )
}
