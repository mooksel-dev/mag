import { ICONS, type IconName } from './icons'

export type { IconName }

/** One icon of the v2 set; decorative (aria-hidden): the button around it carries the label. */
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className ? `i ${className}` : 'i'} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />
  )
}

/** The same icon as markup, for DOM built outside React (a code block's Run button). */
export const iconSvg = (name: IconName, size = 14): string =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 20 20" aria-hidden="true">${ICONS[name]}</svg>`

/** A fold's caret: down when open, right when folded. */
export const Caret = ({ open }: { open: boolean }) => <Icon name={open ? 'chev-d' : 'chev-r'} size={12} className="caret" />
