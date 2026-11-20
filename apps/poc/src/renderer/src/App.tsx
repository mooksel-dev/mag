import { useEffect, useState } from 'react'
import {
  PLAYBOOK_SECTIONS,
  PROJECT_COLORS,
  SETTABLE_ROLES,
  integrationMode,
  playbookOf,
  placeNew,
  projectColor,
  storedPlaybook,
  resolveChoice,
  reviewOfTopic,
  runningAgents,
  taskByKey,
  agentAllowed,
  type AgentRole,
  type AgentSession,
  type Integration,
  type IntegrationMode,
  type PlaybookSection,
  type Project,
} from '@mag/core'
import type { AppState, PickerMode } from '../../preload/api'
import { ChoiceChip, ModelPopover, useAgents } from './Agents'
import { choiceLabel } from './modelChoice'
import { Architecture } from './Architecture'
import { workTarget } from './artifacts'
import { ownerSession, TopicConversation } from './Conversation'
import { ErrorBoundary } from './ErrorBoundary'
import { HomeScreen } from './Home'
import { Logo } from './Logo'
import { PaneHandle, usePaneWidth } from './PaneHandle'
import { useTheme, type ThemeMode } from './useTheme'
import { WorkList, type HomeGroup, type ListPage, type Selection } from './WorkList'
import { DraftSubtopic } from './SessionTree'
import { useRenderReviewExport } from './ReviewExport'
import { MeetingView, MeetingsRootSetting } from './Meetings'

const mag = window.mag
/** Pages the list's footer opens; they take the place of the conversation. */
type Page = ListPage
const PAGE_NAMES: Record<Page, string> = { architecture: 'Architecture', settings: 'Settings' }

/**
 * One project's window; the project is fixed for the window's lifetime (ux-odna-rozmova-na-robotu.2): the work list on
 * the left, the open topic's screen (or Home) in the rest; what a topic made is in its artifacts list and opens in a
 * drawer (topics-a-tree-of-agent.3). Architecture and Settings open from the list's footer.
 */
export function App({ projectId }: { projectId: string }) {
  const [state, setState] = useState<AppState | null>(null)
  const [page, setPage] = useState<Page | null>(null)
  // A meeting is workspace-wide; it opens in this window in place of the conversation.
  const [meetingId, setMeetingId] = useState<string | null>(null)
  const [meetingAt, setMeetingAt] = useState<string | undefined>(undefined)
  const [picker, setPicker] = useState<PickerMode | null>(null)
  // The open work or topic, per project.
  const selKey = `mag.selected.${projectId}`
  const [selected, setSelected] = useState<Selection | null>(() => {
    try { return JSON.parse(localStorage.getItem(selKey) ?? 'null') as Selection | null } catch { return null }
  })
  const [theme, setTheme] = useTheme()
  const leftPane = usePaneWidth('left')
  // A group's + opened Home: what it creates goes first in that group.
  const [homeGroup, setHomeGroup] = useState<HomeGroup | null>(null)
  // This window renders a review's static page for its archive when main asks (review-v2-part-2-v1-2.3).
  useRenderReviewExport(state)
  const select = (s: Selection | null) => {
    setSelected(s)
    setHomeGroup(null)
    setPage(null)
    setMeetingId(null)
    // A New subtopic draft is this window's state only: reopened, its topic shows.
    const kept = s?.kind === 'draft' ? { kind: 'topic', id: s.id } : s
    try { localStorage.setItem(selKey, JSON.stringify(kept)) } catch { /* ignore */ }
  }

  useEffect(() => {
    mag.getState().then((s) => {
      setState(s)
      // A new project has nothing to show until it has repositories.
      if (s.projects.find((p) => p.id === projectId)?.repos.length === 0) setPage('settings')
    })
    return mag.onState(setState)
  }, [projectId])

  // A pop-out or a notification asked to show a task (a step shows its work); main sends it to this project's window only.
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  useEffect(() => mag.onOpenTask((_, tid) => setOpenTaskId(tid)), [])
  useEffect(() => {
    const t = state?.tasks.find((x) => x.id === openTaskId)
    if (!t) return
    select({ kind: 'work', id: t.parentId ?? t.id })
    setOpenTaskId(null)
  }, [openTaskId, state]) // eslint-disable-line react-hooks/exhaustive-deps
  // ⌘O, File → Open Project… / New Project…, the dock menu.
  useEffect(() => mag.onOpenPicker(setPicker), [])
  // ⌘N opens Home, as ＋ New does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'n') return
      e.preventDefault()
      select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const project = state?.projects.find((p) => p.id === projectId) ?? null
  useEffect(() => {
    document.title = project?.name ?? 'mag'
  }, [project?.name])

  if (!state) return null
  if (!project) return <div className="app"><main className="main empty">This project no longer exists.</main></div>
  const tasks = state.tasks.filter((t) => t.projectId === project.id)
  const openKey = (key: string) => {
    const t = taskByKey(tasks, key)
    if (t) select({ kind: 'work', id: t.parentId ?? t.id })
  }
  // The selection, while it still exists; else Home. A work opens through its owner topic, with its card in the drawer;
  // a work whose owner is its groomer (or nobody) on a screen of its own (topics-a-tree-of-agent.3). A topic a review
  // shows through opens with the review. A session under a topic opens on its own page, as a topic does.
  const sessions = state.sessions.filter((s) => s.projectId === project.id)
  const isTopic = (s: AgentSession) => !s.taskId && (s.role === 'chat' || !!s.parentId)
  const pickedTopic = selected?.kind === 'topic' ? sessions.find((s) => s.id === selected.id && isTopic(s)) ?? null : null
  const work = selected?.kind === 'work' ? tasks.find((t) => t.id === selected.id && !t.parentId) ?? null : null
  const owner = work && ownerSession(work, sessions)
  const shownTopic = pickedTopic ?? (owner && isTopic(owner) ? owner : null)
  const shownReview = pickedTopic && reviewOfTopic(tasks, pickedTopic.id)
  const initial = work ? workTarget(work) : shownReview ? workTarget(shownReview) : null
  // A New subtopic draft under a topic or subtopic that still exists (topic-screen-one-new-compact.2).
  const draftParent = selected?.kind === 'draft' ? sessions.find((s) => s.id === selected.id && isTopic(s)) ?? null : null
  const current: Selection | null = draftParent ? { kind: 'draft', id: draftParent.id } : work ? { kind: 'work', id: work.id } : shownTopic ? { kind: 'topic', id: shownTopic.id } : null
  const openPage = (p: Page | null) => {
    setMeetingId(null)
    setPage(p)
  }
  const openMeeting = (id: string, at?: string) => {
    setPage(null)
    setMeetingId(id)
    setMeetingAt(at)
  }
  const screen = meetingId ? 'Meeting' : page ? PAGE_NAMES[page] : draftParent ? 'New subtopic' : work ? `Work ${work.key}` : shownTopic ? 'Topic' : 'Home'

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand"><Logo size={16} />mag <span>PoC</span></span>
        <div className="grow" />
        <AgentCounter state={state} />
        {!state.claudeBin && <span className="clawarn" role="img" aria-label="Warning" title="Claude Code CLI not found. Set MAG_CLAUDE_BIN or install claude.">⚠ Claude CLI not found</span>}
        <ThemeSwitch mode={theme} onChange={setTheme} />
      </div>
      <div className="layout" style={leftPane.style}>
        <ErrorBoundary key={`${project.id}:list`} screen="Work list" appVersion={state.appVersion}>
          <WorkList project={project} state={state} selected={page || meetingId ? null : current} home={!page && !meetingId && !current} page={page} picker={picker} onPicker={setPicker} onSelect={select} onNew={() => select(null)} onNewIn={(g) => { select(null); setHomeGroup(g) }} onOpenPage={openPage} meetingId={meetingId} onOpenMeeting={openMeeting} />
        </ErrorBoundary>
        <PaneHandle side="left" onResize={leftPane.set} />
        <ErrorBoundary key={`${project.id}:${screen}`} screen={screen} appVersion={state.appVersion} onHome={() => select(null)}>
          {meetingId ? (
            <MeetingView key={meetingId} id={meetingId} at={meetingAt} state={state} project={project} onClose={() => setMeetingId(null)} onSelect={select} />
          ) : page ? (
            <main className="pagewrap">
              <div className="pagehead">
                <span>{PAGE_NAMES[page]}</span>
                <div className="grow" />
                <button className="small" onClick={() => openPage(null)}>✕ Close</button>
              </div>
              {page === 'architecture' ? (
                <Architecture key={project.id} project={project} />
              ) : (
                <Settings project={project} integrations={state.integrations} />
              )}
            </main>
          ) : draftParent ? (
            <DraftSubtopic key={`draft:${draftParent.id}`} parent={draftParent} onSelect={select} />
          ) : shownTopic || work ? (
            <TopicConversation key={`${shownTopic?.id ?? ''}:${work?.id ?? ''}`} topic={shownTopic} work={work} initial={initial} state={state} onOpenKey={openKey} onSelect={select} onDeleted={() => select(null)} />
          ) : (
            <HomeScreen
              key={homeGroup?.id ?? ''}
              project={project}
              state={state}
              group={homeGroup}
              onSelect={select}
              onCreated={(ref) => { if (homeGroup) void mag.updateProject(project.id, { sidebar: placeNew(project.sidebar ?? [], ref, homeGroup.id) }) }}
            />
          )}
        </ErrorBoundary>
      </div>
    </div>
  )
}

const THEMES: [ThemeMode, string, string][] = [['light', '☀︎', 'Light'], ['dark', '☾', 'Dark'], ['system', 'Auto', 'Follow the system']]

/** Agents running now across all projects; there is no limit on how many. */
function AgentCounter({ state }: { state: AppState }) {
  const running = runningAgents(state.sessions)
  if (!running.length) return null
  const line = (s: AgentSession) => {
    const project = state.projects.find((p) => p.id === s.projectId)?.name ?? '?'
    const key = s.taskId ? state.tasks.find((t) => t.id === s.taskId)?.key ?? '?' : 'chat'
    return `${project} · ${key} · ${s.role}`
  }
  return (
    <span className="agentcount" title={running.map(line).join('\n')}>
      ● {running.length} {running.length === 1 ? 'agent' : 'agents'}
    </span>
  )
}

function ThemeSwitch({ mode, onChange }: { mode: ThemeMode; onChange: (m: ThemeMode) => void }) {
  return (
    <div className="seg" role="group" aria-label="Theme">
      {THEMES.map(([m, label, title]) => (
        <button key={m} className={m === mode ? 'on' : ''} aria-pressed={m === mode} title={title} onClick={() => onChange(m)}>{label}</button>
      ))}
    </div>
  )
}

function RepoStatus({ path }: { path: string }) {
  const [info, setInfo] = useState<{ git: boolean; origin: string | null } | null>(null)
  useEffect(() => {
    mag.repoInfo(path).then(setInfo)
  }, [path])
  if (!info) return null
  if (!info.git) return <span className="pill amber">not a git repo</span>
  if (!info.origin) return <span className="pill amber">no origin remote</span>
  return <span className="muted small">{info.origin}</span>
}

const ROLE_LABELS: Record<string, string> = { chat: 'Project chat', groomer: 'Groomer', developer: 'Developer', architect: 'Architect' }

/** What a role on Codex gives up, and why: Codex has a sandbox, not deny rules (see agentAllowed). */
const CODEX_NOTES: Partial<Record<AgentRole, string>> = {
  developer: `${agentAllowed('reviewer', 'codex').why} Its PRs are reviewed on Claude Code.`,
  chat: "Codex runs it read-only without network, so its Bash can't push or write to a PR; it can't read tickets with gh or review teammates' PRs.",
  groomer: "Codex runs it read-only without network, so its Bash can't push or write to a PR.",
  architect: 'Codex runs it read-only without network.',
}

function AgentSettings({ project }: { project: Project }) {
  const agents = useAgents()
  return (
    <div className="field">
      Agents
      <div className="agentroles">
        {SETTABLE_ROLES.map((role) => (
          <div key={role} className="agentrole">
            <span>{ROLE_LABELS[role] ?? role}</span>
            <ChoiceChip label={choiceLabel(agents, resolveChoice(project, role))} title={`Agent, model and effort of the ${ROLE_LABELS[role] ?? role}`}>
              <ModelPopover agents={agents} choice={resolveChoice(project, role)} job={role} onChange={(c) => c && void mag.updateProject(project.id, { agents: { ...project.agents, [role]: c } })} />
            </ChoiceChip>
            {resolveChoice(project, role).agent === 'codex' && CODEX_NOTES[role] && <span className="muted small agentnote">{CODEX_NOTES[role]}</span>}
          </div>
        ))}
      </div>
      <span className="muted small">Reviewer uses the Developer choice, except Codex: reviews run on Claude Code. Changes apply to the next agent turn; switching the provider starts a fresh agent session.</span>
    </div>
  )
}

const MODES: [IntegrationMode, string][] = [['off', 'Off'], ['ask', 'Ask each'], ['reads', 'Reads auto'], ['auto', 'Auto']]

/** Roles integration modes apply to. */
const INTEGRATION_ROLES = SETTABLE_ROLES

/** Off / Ask / Auto per integration and role. Codex has no integrations; the architect has no chat to ask in. */
function IntegrationSettings({ project, integrations }: { project: Project; integrations: Integration[] }) {
  const set = (role: AgentRole, id: string, mode: IntegrationMode) =>
    mag.updateProject(project.id, { integrations: { ...project.integrations, [role]: { ...project.integrations[role], [id]: mode } } })
  return (
    <div className="field">
      Integrations
      {integrations.length ? (
        <div className="integrations" style={{ gridTemplateColumns: `minmax(0, max-content) repeat(${INTEGRATION_ROLES.length}, max-content)` }}>
          <span />
          {INTEGRATION_ROLES.map((role) => <span key={role} className="muted small">{ROLE_LABELS[role] ?? role}</span>)}
          {integrations.map((i) => (
            <div key={i.id} style={{ display: 'contents' }}>
              <span title={i.id}>{i.name}</span>
              {INTEGRATION_ROLES.map((role) =>
                resolveChoice(project, role).agent !== 'claude-code' ? (
                  <span key={role} className="muted small" title="Only Claude Code agents use integrations">n/a</span>
                ) : (
                  <select key={role} value={integrationMode(project, role, i.id)} aria-label={`${i.name} for ${ROLE_LABELS[role] ?? role}`} onChange={(e) => set(role, i.id, e.target.value as IntegrationMode)}>
                    {MODES.map(([m, label]) => (
                      <option key={m} value={m} disabled={(m === 'ask' || m === 'reads') && role === 'architect'}>{label}</option>
                    ))}
                  </select>
                ),
              )}
            </div>
          ))}
        </div>
      ) : (
        <span className="muted small">Run any Claude Code agent to detect integrations.</span>
      )}
      <span className="muted small">Off hides the integration from the agent; Ask each waits for your Allow on every call; Reads auto runs reads and waits for your Allow on posts and changes; Auto lets it run. Reviewer uses the Developer setting; the architect cannot ask.</span>
    </div>
  )
}

const PLAYBOOK_HINTS: Record<PlaybookSection, string> = {
  stance: 'How every agent leads the work: its own position, disagreement with a reason, the next move. Tune the tone and how hard they push back here.',
  plan: 'How the owner (the chat that started the work, or its groomer) plans it: problem, options with diagrams, checkpoint, steps.',
  step: 'How a developer does a step: tests, self-review, the PR (draft or not) and its description.',
  review: 'What the first reviewer checks a step\'s PRs against.',
  prReview: 'How the agent reviews a teammate\'s PR in the v2 format (a PR link in the work list): the fact first, the direction and its options before the author\'s description, then problem, conventions, risks and CI as a report; the direction is your call. It never writes to the PR.',
  prReviewV1: 'How the agent reviews a teammate\'s PR in the v1 format: PR and ticket, problem, fact, then the change against the problem and the project\'s agreements (decisions, conventions, architecture), bugs, CI; findings by level and a verdict. It never writes to the PR.',
  fact: 'How a reviewer draws the fact of a diff (a revision of a step\'s plan; a teammate\'s PR has none); every review that reads a diff follows it.',
  tracker: 'How agents read tickets and what they may do in a tracker (comments, "what is on me?"); mag knows a ticket only as its link.',
  significance: 'Rules mag levels code changes by when it compares a PR with its plan. Every plan-level deviation keeps the review from merge; critical marks an external contract, a deviation even inside a planned module.',
}

/**
 * The project's playbook (T-55.2): mag's default process, editable per section. A section left as the default (or
 * emptied) follows mag's default; decisions in a task's doc override it for that task.
 */
function PlaybookSettings({ project, update }: { project: Project; update: (patch: Partial<Project>) => void }) {
  const playbook = playbookOf(project)
  const set = (patch: Partial<typeof playbook>) => update({ playbook: storedPlaybook({ ...playbookOf(project), ...patch }) })
  return (
    <>
      <h2>Playbook</h2>
      <span className="muted small">The process agents follow. mag keeps what it enforces (never merge, never push to base, steps only after the checkpoint); a task's §Decisions override the playbook.</span>
      {PLAYBOOK_SECTIONS.map((s) => (
        <label key={s} className="field">{s}
          <textarea rows={8} defaultValue={playbook[s]} onChange={(e) => set({ [s]: e.target.value })} />
          <span className="muted small">{PLAYBOOK_HINTS[s]}</span>
        </label>
      ))}
      <label className="field">
        Agent review rounds
        <input type="number" min={0} style={{ width: 100 }} defaultValue={playbook.reviewRounds} onChange={(e) => { const n = Math.floor(Number(e.target.value)); if (e.target.value !== '' && n >= 0) set({ reviewRounds: n }) }} />
        <span className="muted small">How many agent reviews in a row may send changes back to the developer before you decide; 0 sends every review to you.</span>
      </label>
    </>
  )
}

function Settings({ project, integrations }: { project: Project; integrations: Integration[] }) {
  const update = (patch: Partial<Project>) => mag.updateProject(project.id, patch)
  return (
    <section className="page">
      <h1>Settings</h1>
      <label className="field">Name<input defaultValue={project.name} onChange={(e) => update({ name: e.target.value })} /></label>
      <div className="field">
        Color
        <div className="swatches" role="radiogroup" aria-label="Project color">
          <button role="radio" aria-checked={!project.color} className={`swatch auto ${!project.color ? 'on' : ''}`} title="Auto: picked from the project id" onClick={() => update({ color: null })}>
            <span style={{ background: projectColor({ id: project.id }) }} />Auto
          </button>
          {PROJECT_COLORS.map((c) => (
            <button key={c} role="radio" aria-checked={project.color === c} aria-label={c} className={`swatch ${project.color === c ? 'on' : ''}`} onClick={() => update({ color: c })}>
              <span style={{ background: c }} />
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        Repositories
        {project.repos.map((r) => (
          <div key={r} className="repo">
            <code>{r}</code>
            <RepoStatus path={r} />
            <button className="link" onClick={() => update({ repos: project.repos.filter((x) => x !== r) })}>remove</button>
          </div>
        ))}
        <button onClick={async () => { const d = await mag.pickDir(); if (d && !project.repos.includes(d)) update({ repos: [...project.repos, d] }) }}>+ Add repository</button>
        <form onSubmit={(e) => { e.preventDefault(); const input = e.currentTarget.elements.namedItem('repoPath') as HTMLInputElement; const d = input.value.trim(); if (d && !project.repos.includes(d)) update({ repos: [...project.repos, d] }); input.value = '' }}>
          <input name="repoPath" placeholder="…or paste an absolute path and press Enter" aria-label="Repository path" style={{ width: '100%' }} />
        </form>
        <span className="muted small">The first repository is the agent's working directory; the rest are added with --add-dir.</span>
      </div>
      <label className="check">
        <input type="checkbox" checked={project.enforceArchitecture} onChange={(e) => update({ enforceArchitecture: e.target.checked })} />
        Enforce core architecture (lib / clients / services) for agents
      </label>
      <AgentSettings project={project} />
      <MeetingsRootSetting />
      <IntegrationSettings project={project} integrations={integrations} />
      <label className="field">Notes for agents<textarea defaultValue={project.notes} rows={4} onChange={(e) => update({ notes: e.target.value })} /></label>
      <details className="advanced">
        <summary>Advanced: the playbook agents follow</summary>
        <PlaybookSettings project={project} update={update} />
      </details>
      <h2>Diagnostics</h2>
      <div className="field">
        <div><button onClick={() => mag.openLogs()}>Open logs folder</button></div>
        <span className="muted small">mag's logs and crash reports. The project chat can read them: ask it to look at the last crash.</span>
      </div>
    </section>
  )
}
