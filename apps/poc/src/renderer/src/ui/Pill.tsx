import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import type { Tone } from './tones'

export type { Tone }

interface PillProps {
  tone?: Tone
  /** A dot in the tone's colour before the text. */
  dot?: boolean
  icon?: IconName
  title?: string
  className?: string
  /** A button when given; an <a> with `href` (the static review page). */
  onClick?: () => void
  href?: string
  children: ReactNode
}

/** The one small label of mag: a status, a verdict, a tag, a count; one shape, its tone says what it means. */
export function Pill({ tone = 'grey', dot, icon, title, className, onClick, href, children }: PillProps) {
  const cls = `pill ${tone}${className ? ` ${className}` : ''}`
  const body = <>{dot && <span className="d" aria-hidden />}{icon && <Icon name={icon} size={12} />}{children}</>
  if (href) return <a className={cls} href={href} title={title}>{body}</a>
  if (onClick) return <button type="button" className={cls} title={title} onClick={onClick}>{body}</button>
  return <span className={cls} title={title}>{body}</span>
}
