/** The mag mark: three nested arcs open to the right, queue lanes bent into a magnet. Drawn in the current text color. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round" aria-hidden="true">
      <path d="M38 8H22a14 14 0 0 0 0 28h16" />
      <path d="M38 14H22a8 8 0 0 0 0 16h16" opacity={0.6} />
      <path d="M38 20H22a2 2 0 0 0 0 4h16" opacity={0.3} />
    </svg>
  )
}
