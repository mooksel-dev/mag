import type { Workspace } from '@mag/core'
import type { ThemeMode } from '../useTheme'
import { Icon, type IconName } from '../ui/Icon'
import type { RailSection } from './TopicsColumn'

const THEME_NEXT: Record<ThemeMode, { next: ThemeMode; icon: IconName; label: string }> = {
  light: { next: 'dark', icon: 'sun', label: 'Light' },
  dark: { next: 'system', icon: 'moon', label: 'Dark' },
  system: { next: 'light', icon: 'circle-half', label: 'Follow the system' },
}

/**
 * The rail at the window's left (slack-like-shell-rail-resizable.1): the sections the column shows (Topics, Meetings)
 * with what waits on the user as a badge, Search; at the bottom + (New topic), the theme and the workspace's profile.
 * Sections not built yet (Inbox, Routines, Library, People) are not shown.
 */
export function Rail({ section, onSection, badges, onSearch, onNew, theme, onTheme, workspace, profileOn, onProfile }: {
  section: RailSection
  onSection: (s: RailSection) => void
  /** What waits on the user, per section; 0 or missing shows none. */
  badges: Partial<Record<RailSection, number>>
  onSearch: () => void
  onNew: () => void
  theme: ThemeMode
  onTheme: (m: ThemeMode) => void
  workspace: Workspace
  /** The workspace's settings (its profile) are open. */
  profileOn: boolean
  onProfile: () => void
}) {
  const item = (s: RailSection, icon: IconName, label: string) => {
    const n = badges[s] ?? 0
    return (
      <button key={s} className={`railbtn${section === s ? ' on' : ''}`} aria-current={section === s ? 'page' : undefined} aria-label={n ? `${label}, ${n} waiting on you` : label} title={label} onClick={() => onSection(s)}>
        <Icon name={icon} size={18} />
        <span className="raillabel">{label}</span>
        {n > 0 && <span className="railbadge" aria-hidden>{n > 99 ? '99+' : n}</span>}
      </button>
    )
  }
  const t = THEME_NEXT[theme]
  return (
    <nav className="rail" aria-label="Sections">
      {item('topics', 'chat', 'Topics')}
      {item('meetings', 'mic', 'Meetings')}
      <button className="railbtn" aria-haspopup="dialog" aria-label="Search" title="Search topics (⌘K)" onClick={onSearch}>
        <Icon name="search" size={18} />
        <span className="raillabel">Search</span>
      </button>
      <div className="grow" />
      <button className="railbtn railnew" aria-label="New topic" title="New topic (⌘N)" onClick={onNew}><Icon name="plus" size={18} /></button>
      <button className="railbtn" aria-label={`Theme: ${t.label}`} title={`Theme: ${t.label}; click to switch`} onClick={() => onTheme(t.next)}><Icon name={t.icon} size={18} /></button>
      <button className={`railbtn railme${profileOn ? ' on' : ''}`} aria-current={profileOn ? 'page' : undefined} aria-label={`${workspace.name}: profile and settings`} title={`${workspace.name}: your profile and the workspace's settings`} onClick={onProfile}>
        <span className="railavatar" aria-hidden>{workspace.name.trim().charAt(0).toUpperCase() || '?'}</span>
      </button>
    </nav>
  )
}
