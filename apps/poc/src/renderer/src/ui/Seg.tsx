import type { ReactNode } from 'react'

export interface SegOption<T> {
  value: T
  label: ReactNode
  title?: string
  disabled?: boolean
}

/** The one segmented control: a choice of a few, the chosen one raised. */
export function Seg<T>({ options, value, onChange, label, className }: { options: SegOption<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string }) {
  return (
    <div className={className ? `seg ${className}` : 'seg'} role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button key={i} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} title={o.title} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
