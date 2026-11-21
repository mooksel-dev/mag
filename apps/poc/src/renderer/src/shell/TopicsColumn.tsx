import { useEffect, useState } from 'react'
import {
  CARD_FILTERS,
  CARD_FILTER_LABELS,
  cardFilter,
  cardRef,
  countedCards,
  parkedTopics,
  rowMatches,
  sidebarRows,
  type ItemRef,
  type Project,
  type WorkCard,
  type Workspace,
} from '@mag/core'
import type { AppState, CrashReport, LibraryRow, PickerMode } from '../../../preload/api'
import { ProjectPicker } from '../Picker'
import { Inbox } from '../Inbox'
import { MeetingsSection } from '../Meetings'
import { PeopleSection } from '../People'
import { LibrarySection } from '../Library'
import { RoutinesSection } from '../Routines'
import { useNow } from '../Tasks'
import { CardRow, CrashRow, ProjectSection, StarsContext, useFilter, useFolded, useStoredFlag, type HomeGroup, type ListPage, type RowEnv, type Selection, type Stars } from '../WorkList'
import { allCards, columnCards, onlyProject, starredCards, toggleStar, waitingCount } from '../topicsColumn'
import { WorkspaceMenu } from './WorkspaceMenu'
import { Caret, Icon } from '../ui/Icon'

const mag = window.mag

/** The rail's sections that show in the column. */
export type RailSection = 'inbox' | 'topics' | 'meetings' | 'people' | 'library' | 'routines'

/** A project's page open in place of the conversation. */
export interface OpenPage { kind: ListPage; projectId: string }

/**
 * The column right of the rail (slack-like-shell-rail-resizable.1). Inbox: what waits on the user in the workspace.
 * Topics: the workspace's menu "<Workspace> ▾" (WorkspaceMenu), New topic, search (⌘K) and filters, then Starred, a
 * section per Project label (ProjectSection: its rows and the user's groups) and No project; closed rows of all of them
 * under Archive. A window filtered to a project lists that project's section only. Meetings: today's meetings list and
 * recorder. People: the workspace's persons (who-is-who-people-from.1). Library: what is final in the workspace
 * (deliverables-library-claims-review-and.4).
 */
export function TopicsColumn({ workspace, only, viewKey, state, section, selected, home, page, picker, onPicker, onSelect, onNew, onNewIn, onOpenPage, onOpenWorkspacePage, onSearch, meetingId, onOpenMeeting, onOpenLibrary, routineId, onOpenRoutine }: {
  workspace: Workspace
  /** The project the window is filtered to. */
  only: Project | null
  /** Keys this window's stored filter. */
  viewKey: string
  state: AppState
  section: RailSection
  selected: Selection | null
  /** Home is open: New topic is the current row. */
  home: boolean
  page: OpenPage | null
  picker: PickerMode | null
  onPicker: (m: PickerMode | null) => void
  onSelect: (s: Selection) => void
  /** Home in the window's project. */
  onNew: () => void
  /** Home in a project, creating into one of its groups or at its top. */
  onNewIn: (projectId: string, g: HomeGroup | null) => void
  onOpenPage: (p: OpenPage) => void
  /** The workspace's settings or its labels. */
  onOpenWorkspacePage: (kind: 'workspace' | 'labels') => void
  onSearch: () => void
  meetingId: string | null
  /** `at`: hh:mm:ss of a transcript line a search hit points at. */
  onOpenMeeting: (id: string, at?: string) => void
  /** A Library row's click. */
  onOpenLibrary: (o: LibraryRow['open']) => void
  /** The routine open in the window ('new': the form of a new one). */
  routineId: string | null
  onOpenRoutine: (id: string) => void
}) {
  const now = useNow(15_000)
  const [filter, setFilter] = useFilter(viewKey)
  const [menu, setMenu] = useState(false)
  const [crash, setCrash] = useState<CrashReport | null>(null)
  useEffect(() => {
    mag.lastCrash().then(setCrash, () => {})
  }, [])
  const column = onlyProject(columnCards(workspace.id, state.projects, state.tasks, state.sessions, now), only?.id ?? null)
  const all = allCards(column)
  const starredList = workspace.starred ?? []
  const starred = new Set<string>(starredList)
  const stars: Stars = {
    has: (ref) => starred.has(ref),
    toggle: (ref: ItemRef) => void mag.updateWorkspace(workspace.id, { starred: toggleStar(workspace.starred, ref) }),
  }
  const hiding = filter !== 'all'
  // A starred open row shows under Starred only; closed, it is in Archive as any.
  const shown = (c: WorkCard) => rowMatches(c, filter) && (c.closed || !starred.has(cardRef(c)))
  const sections = column.projects.map(({ project: p, cards }) => ({ project: p, cards, sidebar: sidebarRows(p.sidebar ?? [], cards, shown) }))
  const starRows = starredCards(column, starredList).filter((c) => rowMatches(c, filter))
  const looseOpen = column.loose.filter((c) => !c.closed && shown(c))
  const showLoose = !only && (!hiding || looseOpen.length > 0)
  const closedRows = [...sections.flatMap((s) => s.sidebar.closed), ...column.loose.filter((c) => c.closed)]
  // Counts count each row that matches on its own, a chat's works included: "Waiting on you 2" is two things to act on.
  const counted = countedCards(all)
  const env: RowEnv = { now, selected, sessions: state.sessions, onSelect, onNew }
  const [looseFolded, toggleLooseFold] = useFolded(`noproject.${workspace.id}`)
  const [starFolded, toggleStarFold] = useFolded(`starred.${workspace.id}`)
  const [closedFolded, toggleClosedFold] = useFolded(`archive.${workspace.id}`)
  const [looseClosed, setLooseClosed] = useStoredFlag(`mag.column.noproject.${workspace.id}`, false)
  const [starClosed, setStarClosed] = useStoredFlag(`mag.column.starred.${workspace.id}`, false)
  const [showClosed, setShowClosed] = useState(false)
  const newLoose = () => void mag.newChat(null, workspace.id).then((id) => onSelect({ kind: 'topic', id }))
  const looseWaiting = waitingCount(looseOpen)

  if (section === 'inbox') return <Inbox workspace={workspace} state={state} onSelect={onSelect} />
  if (section === 'routines') return <RoutinesSection workspace={workspace} state={state} selectedId={routineId} onOpen={onOpenRoutine} />
  if (section === 'people') {
    return (
      <nav className="worklist" aria-label="People">
        <div className="wlhead2"><span className="colhead2">People</span></div>
        <div className="wlscroll"><PeopleSection workspaceId={workspace.id} /></div>
      </nav>
    )
  }
  if (section === 'library') return <LibrarySection workspace={workspace} state={state} onOpen={onOpenLibrary} />
  if (section === 'meetings') {
    return (
      <nav className="worklist" aria-label="Meetings">
        <div className="wlhead2"><span className="colhead2">Meetings</span></div>
        <div className="wlscroll"><MeetingsSection selectedId={meetingId} onOpen={onOpenMeeting} /></div>
      </nav>
    )
  }
  return (
    <StarsContext.Provider value={stars}>
      <nav className="worklist" aria-label="Topics">
        <div className="wlhead2">
          <div className="projmenu">
            <button className="projbtn" aria-haspopup="menu" aria-expanded={menu || !!picker} title="Switch workspace, open a new window, settings" onClick={() => { onPicker(null); setMenu(!menu) }}>
              <span className="pname">{workspace.name}{only && <span className="wsonly"> · {only.name}</span>}</span>
              <Icon name="chev-d" size={12} className="caret" />
            </button>
            {menu && (
              <WorkspaceMenu
                current={workspace}
                workspaces={state.workspaces}
                only={only}
                openWorkspaces={state.openWorkspaces}
                onClose={() => setMenu(false)}
                onSettings={() => onOpenWorkspacePage('workspace')}
                onLabels={() => onOpenWorkspacePage('labels')}
                onPicker={onPicker}
              />
            )}
            {picker && <ProjectPicker key={picker} state={state} currentId={only?.id ?? null} mode={picker} onClose={() => onPicker(null)} />}
          </div>
          <button className={`newbtn${home ? ' on' : ''}`} aria-current={home ? 'page' : undefined} title="Ask, describe a task, review a PR or start from a ticket" onClick={onNew}>
            <Icon name="compose" /> New topic <kbd>⌘N</kbd>
          </button>
          <button className="wlsearch" aria-haspopup="dialog" title="Search topics by title, summary and messages, archive included" onClick={onSearch}>
            <Icon name="search" />
            <span className="wlsearchtext">Search topics</span>
            <kbd>⌘K</kbd>
          </button>
          {counted.length > 0 && (
            <div className="wlfilters" role="tablist" aria-label="Filter topics">
              {CARD_FILTERS.map((f) => (
                <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                  {CARD_FILTER_LABELS[f]} <span className="count">{cardFilter(counted, f).length}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="wlscroll">
          {hiding && !starRows.length && !looseOpen.length && sections.every((s) => !s.sidebar.entries.length) && <p className="muted small pad">Nothing here.</p>}
          {crash && <CrashRow crash={crash} onDismiss={() => mag.dismissCrash().then(() => setCrash(null))} />}
          {starRows.length > 0 && (
            <section className="colsection" aria-label="Starred">
              <div className="wlgrp colhead">
                <button className={`wlgname${waitingCount(starRows) ? ' unread' : ''}`} aria-expanded={!starClosed} onClick={() => setStarClosed(!starClosed)} title="Rows you starred: Star in a row's menu">
                  <span aria-hidden><Caret open={!starClosed} /></span> <Icon name="star" size={14} /> <span className="colname">Starred</span>
                  {waitingCount(starRows) > 0 && <span className="colcount">{waitingCount(starRows)}</span>}
                </button>
              </div>
              {!starClosed && <div className="colbody">{starRows.map((c) => <CardRow key={cardRef(c)} card={c} env={env} folded={starFolded} onFold={toggleStarFold} />)}</div>}
            </section>
          )}
          {sections.map((s) => (
            <ProjectSection
              key={s.project.id}
              project={s.project}
              sidebar={s.sidebar}
              waiting={waitingCount(s.cards.filter((c) => !starred.has(cardRef(c))))}
              ideas={parkedTopics(s.project.id, state.sessions)}
              hiding={hiding}
              empty={!s.cards.some((c) => !c.closed)}
              env={env}
              page={page?.projectId === s.project.id ? page.kind : null}
              onNewIn={(g) => onNewIn(s.project.id, g)}
              onOpenPage={(kind) => onOpenPage({ kind, projectId: s.project.id })}
            />
          ))}
          {showLoose && (
            <section className="colsection wlnoproject" aria-label="No project">
              <div className="wlgrp colhead">
                <button className={`wlgname${looseWaiting ? ' unread' : ''}`} aria-expanded={!looseClosed} onClick={() => setLooseClosed(!looseClosed)} title="Topics of this workspace without a project; put one into a project with its Project label">
                  <span aria-hidden><Caret open={!looseClosed} /></span> <span className="colname">No project</span>
                  {looseWaiting > 0 && <span className="colcount">{looseWaiting}</span>}
                </button>
                <button className="wlgbtn" aria-label="New topic without a project" title="A topic without a project, in this workspace" onClick={newLoose}><Icon name="plus" size={14} /></button>
              </div>
              {!looseClosed && <div className="colbody">{looseOpen.map((c) => <CardRow key={cardRef(c)} card={c} env={env} folded={looseFolded} onFold={toggleLooseFold} />)}</div>}
            </section>
          )}
          {closedRows.length > 0 && (
            <div className="wlclosed">
              <button className="wlfold" aria-expanded={showClosed} onClick={() => setShowClosed((d) => !d)}>
                <Caret open={showClosed} /> Archive · {closedRows.length}
              </button>
              {showClosed && closedRows.map((c) => <CardRow key={cardRef(c)} card={c} env={env} folded={closedFolded} onFold={toggleClosedFold} />)}
            </div>
          )}
        </div>
      </nav>
    </StarsContext.Provider>
  )
}
