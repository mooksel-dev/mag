/** The mag mark: two nested arcs open to the right and a dot, queue lanes bent into a magnet. Drawn in the current text color. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round" aria-hidden="true">
      <path d="M36 9H22a13 13 0 0 0 0 26h14" />
      <path d="M36 16H22a6 6 0 0 0 0 12h14" opacity={0.6} />
      <circle cx="25" cy="22" r="2.5" fill="currentColor" stroke="none" opacity={0.4} />
    </svg>
  )
}
