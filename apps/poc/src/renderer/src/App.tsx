import { useEffect, useState } from 'react'
import {
  DESTINATION_LABELS,
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
  type DestinationKind,
  type DestinationPattern,
  type SessionHeader,
  type Integration,
  type IntegrationMode,
  type PlaybookSection,
  type Project,
  type Workspace,
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
import { useTheme } from './useTheme'
import { type HomeGroup, type Selection } from './WorkList'
import { Rail } from './shell/Rail'
import { TopicsColumn, type OpenPage, type RailSection } from './shell/TopicsColumn'
import { allCards, columnCards, waitingCount } from './topicsColumn'
import { SearchPalette } from './SearchPalette'
import { DraftSubtopic } from './SessionTree'
import { useRenderReviewExport } from './ReviewExport'
import { MeetingView, MeetingsRootSetting } from './Meetings'
import { WorkspaceSettings } from './WorkspaceSettings'
import { Icon } from './ui/Icon'
import { Pill } from './ui/Pill'

const mag = window.mag
/** What opens in place of the conversation: a project's page (its section's ⋯) or the workspace's settings (the rail's profile). */
type Page = OpenPage | { kind: 'workspace' }
const PAGE_NAMES: Record<Page['kind'], string> = { architecture: 'Architecture', settings: 'Settings', workspace: 'Workspace' }
/** Home, creating in a project and, from a group's +, first in that group. */
interface HomeIn { projectId: string; group: HomeGroup | null }

/**
 * One project's window (ux-odna-rozmova-na-robotu.2), laid out as rail | topics column | the open screen
 * (slack-like-shell-rail-resizable.1): the rail picks what the column shows (Topics, Meetings); the column lists the
 * project's whole workspace, a section per project, and is resized by its edge; the open topic's screen (or Home) is in
 * the rest, what a topic made in its artifacts pane or drawer (topics-a-tree-of-agent.3).
 */
export function App({ projectId }: { projectId: string }) {
  const [state, setState] = useState<AppState | null>(null)
  const [page, setPage] = useState<Page | null>(null)
  // A meeting is workspace-wide; it opens in this window in place of the conversation.
  const [meetingId, setMeetingId] = useState<string | null>(null)
  const [meetingAt, setMeetingAt] = useState<string | undefined>(undefined)
  const [picker, setPicker] = useState<PickerMode | null>(null)
  const [searching, setSearching] = useState(false)
  // The open work or topic, per window.
  const selKey = `mag.selected.${projectId}`
  const [selected, setSelected] = useState<Selection | null>(() => {
    try { return JSON.parse(localStorage.getItem(selKey) ?? 'null') as Selection | null } catch { return null }
  })
  const railKey = `mag.rail.${projectId}`
  const [section, setSection] = useState<RailSection>(() => {
    const saved = localStorage.getItem(railKey)
    return saved === 'meetings' || saved === 'people' ? saved : 'topics'
  })
  const pickSection = (s: RailSection) => {
    setSection(s)
    try { localStorage.setItem(railKey, s) } catch { /* ignore */ }
  }
  const [theme, setTheme] = useTheme()
  const leftPane = usePaneWidth('left', projectId)
  const [homeIn, setHomeIn] = useState<HomeIn | null>(null)
  // This window renders a review's static page for its archive when main asks (review-v2-part-2-v1-2.3).
  useRenderReviewExport(state)
  const select = (s: Selection | null) => {
    setSelected(s)
    setHomeIn(null)
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
      if (s.projects.find((p) => p.id === projectId)?.repos.length === 0) setPage({ kind: 'settings', projectId })
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
  // ⌘N opens Home, as New does; ⌘K the search palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'n') {
        e.preventDefault()
        select(null)
      } else if (key === 'k') {
        e.preventDefault()
        setSearching(true)
      }
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
  const workspace = state.workspaces.find((w) => w.id === project.workspaceId) ?? null
  if (!workspace) return <div className="app"><main className="main empty">This project's workspace no longer exists.</main></div>
  // The column lists the whole workspace, so what is open can be in any of its projects or without one.
  const inWorkspace = new Set(state.projects.filter((p) => p.workspaceId === workspace.id).map((p) => p.id))
  const tasks = state.tasks.filter((t) => inWorkspace.has(t.projectId))
  const sessions = state.sessions.filter((s) => s.workspaceId === workspace.id)
  const openKey = (key: string) => {
    const t = taskByKey(tasks.filter((x) => x.projectId === project.id), key) ?? taskByKey(tasks, key)
    if (t) select({ kind: 'work', id: t.parentId ?? t.id })
  }
  // The selection, while it still exists; else Home. A work opens through its owner topic, with its card in the drawer;
  // a work whose owner is its groomer (or nobody) on a screen of its own (topics-a-tree-of-agent.3). A topic a review
  // shows through opens with the review. A session under a topic opens on its own page, as a topic does.
  const isTopic = (s: SessionHeader) => !s.taskId && (s.role === 'chat' || !!s.parentId)
  const pickedTopic = selected?.kind === 'topic' ? sessions.find((s) => s.id === selected.id && isTopic(s)) ?? null : null
  const work = selected?.kind === 'work' ? tasks.find((t) => t.id === selected.id && !t.parentId) ?? null : null
  const owner = work && ownerSession(work, sessions)
  const shownTopic = pickedTopic ?? (owner && isTopic(owner) ? owner : null)
  const shownReview = pickedTopic && reviewOfTopic(tasks, pickedTopic.id)
  const initial = work ? workTarget(work) : shownReview ? workTarget(shownReview) : null
  // A New subtopic draft under a topic or subtopic that still exists (topic-screen-one-new-compact.2).
  const draftParent = selected?.kind === 'draft' ? sessions.find((s) => s.id === selected.id && isTopic(s)) ?? null : null
  const current: Selection | null = draftParent ? { kind: 'draft', id: draftParent.id } : work ? { kind: 'work', id: work.id } : shownTopic ? { kind: 'topic', id: shownTopic.id } : null
  // A page of a project gone (deleted, moved to another workspace) shows nothing: Home.
  const pageProject = page && page.kind !== 'workspace' ? state.projects.find((p) => p.id === page.projectId && inWorkspace.has(p.id)) ?? null : null
  const shownPage = page && (page.kind === 'workspace' || pageProject) ? page : null
  const homeProject = (homeIn && state.projects.find((p) => p.id === homeIn.projectId && inWorkspace.has(p.id))) || project
  const homeGroup = homeIn && homeProject.id === homeIn.projectId ? homeIn.group : null
  const openPage = (p: Page | null) => {
    setMeetingId(null)
    setPage(p)
  }
  const openMeeting = (id: string, at?: string) => {
    setPage(null)
    setMeetingId(id)
    setMeetingAt(at)
  }
  const newIn = (pid: string, group: HomeGroup | null) => {
    select(null)
    setHomeIn({ projectId: pid, group })
  }
  const screen = meetingId ? 'Meeting' : shownPage ? PAGE_NAMES[shownPage.kind] : draftParent ? 'New subtopic' : work ? `Work ${work.key}` : shownTopic ? 'Topic' : 'Home'
  const topicsWaiting = waitingCount(allCards(columnCards(workspace.id, state.projects, state.tasks, state.sessions, Date.now())))

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand"><Logo size={16} />mag <span>PoC</span></span>
        <div className="grow" />
        <AgentCounter state={state} />
        {!state.claudeBin && <span className="clawarn" role="img" aria-label="Warning" title="Claude Code CLI not found. Set MAG_CLAUDE_BIN or install claude."><Icon name="alert" size={14} /> Claude CLI not found</span>}
      </div>
      <div className="layout" style={leftPane.style}>
        <Rail
          section={section}
          onSection={pickSection}
          badges={{ topics: topicsWaiting }}
          onSearch={() => setSearching(true)}
          onNew={() => select(null)}
          theme={theme}
          onTheme={setTheme}
          workspace={workspace}
          profileOn={shownPage?.kind === 'workspace'}
          onProfile={() => openPage({ kind: 'workspace' })}
        />
        <ErrorBoundary key={`${project.id}:list`} screen="Topics column" appVersion={state.appVersion}>
          <TopicsColumn
            workspace={workspace}
            project={project}
            state={state}
            section={section}
            selected={shownPage || meetingId ? null : current}
            home={!shownPage && !meetingId && !current}
            page={shownPage && shownPage.kind !== 'workspace' ? shownPage : null}
            picker={picker}
            onPicker={setPicker}
            onSelect={select}
            onNew={() => select(null)}
            onNewIn={newIn}
            onOpenPage={openPage}
            onSearch={() => setSearching(true)}
            meetingId={meetingId}
            onOpenMeeting={openMeeting}
          />
        </ErrorBoundary>
        <PaneHandle side="left" onResize={leftPane.set} />
        <ErrorBoundary key={`${project.id}:${screen}`} screen={screen} appVersion={state.appVersion} onHome={() => select(null)}>
          {meetingId ? (
            <MeetingView key={meetingId} id={meetingId} at={meetingAt} state={state} project={project} onClose={() => setMeetingId(null)} onSelect={select} />
          ) : shownPage ? (
            <main className="pagewrap">
              <div className="pagehead">
                <span>{PAGE_NAMES[shownPage.kind]}{pageProject && pageProject.id !== project.id ? ` · ${pageProject.name}` : ''}</span>
                <div className="grow" />
                <button className="small" onClick={() => openPage(null)}><Icon name="x" size={14} /> Close</button>
              </div>
              {shownPage.kind === 'workspace' ? (
                <WorkspaceSettings key={workspace.id} workspace={workspace} projects={state.projects} state={state} />
              ) : shownPage.kind === 'architecture' ? (
                <Architecture key={pageProject!.id} project={pageProject!} />
              ) : (
                <Settings key={pageProject!.id} project={pageProject!} integrations={state.integrations} workspaces={state.workspaces} projects={state.projects} state={state} />
              )}
            </main>
          ) : draftParent ? (
            <DraftSubtopic key={`draft:${draftParent.id}`} parent={draftParent} onSelect={select} />
          ) : shownTopic || work ? (
            <TopicConversation key={`${shownTopic?.id ?? ''}:${work?.id ?? ''}`} topic={shownTopic} work={work} initial={initial} state={state} onOpenKey={openKey} onSelect={select} onDeleted={() => select(null)} />
          ) : (
            <HomeScreen
              key={`${homeProject.id}:${homeGroup?.id ?? ''}`}
              project={homeProject}
              state={state}
              group={homeGroup}
              onSelect={select}
              onCreated={(ref) => { if (homeGroup) void mag.updateProject(homeProject.id, { sidebar: placeNew(homeProject.sidebar ?? [], ref, homeGroup.id) }) }}
            />
          )}
        </ErrorBoundary>
      </div>
      {searching && (
        <SearchPalette
          projectId={project.id}
          onPick={(ref) => select({ kind: ref.kind === 'topic' ? 'topic' : 'work', id: ref.id })}
          onClose={() => setSearching(false)}
        />
      )}
    </div>
  )
}

/** Agents running now across all projects; there is no limit on how many. */
function AgentCounter({ state }: { state: AppState }) {
  const running = runningAgents(state.sessions)
  if (!running.length) return null
  const line = (s: SessionHeader) => {
    const project = state.projects.find((p) => p.id === s.projectId)?.name ?? '?'
    const key = s.taskId ? state.tasks.find((t) => t.id === s.taskId)?.key ?? '?' : 'chat'
    return `${project} · ${key} · ${s.role}`
  }
  return (
    <span className="agentcount" title={running.map(line).join('\n')}>
      <span className="pdot" aria-hidden /> {running.length} {running.length === 1 ? 'agent' : 'agents'}
    </span>
  )
}

function RepoStatus({ path }: { path: string }) {
  const [info, setInfo] = useState<{ git: boolean; origin: string | null } | null>(null)
  useEffect(() => {
    mag.repoInfo(path).then(setInfo)
  }, [path])
  if (!info) return null
  if (!info.git) return <Pill tone="amber">not a git repo</Pill>
  if (!info.origin) return <Pill tone="amber">no origin remote</Pill>
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
      <span className="muted small">Off hides the integration from the agent; Ask each waits for your Allow on every call; Reads auto runs reads and waits for your Allow on posts and changes; Auto lets it run. Not set: Reads auto for Project chat and Groomer, Off for the others. Reviewer uses the Developer setting; the architect cannot ask.</span>
    </div>
  )
}

const DESTINATION_KINDS = Object.keys(DESTINATION_LABELS) as DestinationKind[]

/**
 * The destinations whose writes publish without the card (publish-gate-for-every-outbound.1): a kind, and optionally
 * one target (a channel, an issue or project key, a repo). Every other write of a chat, owner or groomer asks.
 */
function PublishSettings({ project }: { project: Project }) {
  const auto = project.publish?.auto ?? []
  const save = (next: DestinationPattern[]) => mag.updateProject(project.id, { publish: { ...project.publish, auto: next } })
  const change = (n: number, p: DestinationPattern) => save(auto.map((a, i) => (i === n ? p : a)))
  return (
    <div className="field">
      Publish without asking
      {auto.length > 0 && (
        <div className="publishauto">
          {auto.map((p, n) => (
            <div key={n} className="publishrow">
              <select value={p.kind} aria-label="Destination" onChange={(e) => change(n, { ...p, kind: e.target.value as DestinationKind })}>
                {DESTINATION_KINDS.map((k) => <option key={k} value={k}>{DESTINATION_LABELS[k]}</option>)}
              </select>
              <input
                key={`${n}:${p.target ?? ''}`}
                defaultValue={p.target ?? ''}
                placeholder="every target"
                aria-label="Target"
                onBlur={(e) => {
                  const target = e.target.value.trim()
                  if (target !== (p.target ?? '')) change(n, target ? { kind: p.kind, target } : { kind: p.kind })
                }}
              />
              <button className="small" aria-label="Remove" onClick={() => save(auto.filter((_, i) => i !== n))}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <div><button className="small" onClick={() => save([...auto, { kind: 'slack' }])}>Add destination</button></div>
      <span className="muted small">Writes of chats, owners and groomers (Slack, Jira, Confluence, GitHub, Google Docs, through integrations or CLIs like acli and gh) wait for your Allow, except to these. A target is a channel (#name or id), an issue or project key, or a repo (owner/name); empty means every target.</span>
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

function Settings({ project, integrations, workspaces, projects, state }: { project: Project; integrations: Integration[]; workspaces: Workspace[]; projects: Project[]; state: AppState }) {
  const update = (patch: Partial<Project>) => mag.updateProject(project.id, patch)
  const [showWorkspace, setShowWorkspace] = useState(false)
  const workspace = workspaces.find((w) => w.id === project.workspaceId)
  if (showWorkspace && workspace) {
    return (
      <>
        <div className="pad"><button className="small" onClick={() => setShowWorkspace(false)}>← Project settings</button></div>
        <WorkspaceSettings key={workspace.id} workspace={workspace} projects={projects} state={state} />
      </>
    )
  }
  return (
    <section className="page">
      <h1>Settings</h1>
      <label className="field">Name<input defaultValue={project.name} onChange={(e) => update({ name: e.target.value })} /></label>
      <div className="field">
        Workspace
        <div className="repo">
          <select value={project.workspaceId} aria-label="Workspace" onChange={(e) => update({ workspaceId: e.target.value })}>
            {!workspace && <option value={project.workspaceId}>none</option>}
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          {workspace && <button className="small" onClick={() => setShowWorkspace(true)}>Workspace settings</button>}
        </div>
        <span className="muted small">Moving the project adds its repositories to the new workspace.</span>
      </div>
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
      <PublishSettings project={project} />
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
