import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  FINDING_LEVEL_LABELS,
  findingsByLevel,
  hunksOf,
  isReview,
  markBlocks,
  prRepoName,
  reportLine,
  reviewRunning,
  type ChangeGroup,
  type ChangeInventory,
  type HunkPick,
  type HunkTarget,
  type PrHunk,
  type Task,
} from '@mag/core'
import type { FileChange } from '@mag/diff/types'
import type { AppState, FactView } from '../../preload/api'
import { Chat, Markdown } from './Chat'
import { ownerSession } from './Conversation'
import { DiffSetView, type DiagramCanvas } from './DiffSetView'
import { Comparison, useHunks } from './FactPanel'
import { ReportView } from './ReportView'
import { FormatSwitch } from './Reviews'
import { askHunk, hunkCacheFor, reviewWindowModel, shownHunks, type HunkCache, type HunkLines, type InlineSet } from './reviewWindowModel'

const mag = window.mag

/** What the window's inline hunks read: the fact's files and inventory, and the lines of the hunks opened so far. */
interface HunkSource {
  files: FileChange[]
  inventory: ChangeInventory | null
  lines: (file: FileChange, hunk: PrHunk) => HunkLines | undefined
  load: (file: FileChange, hunk: PrHunk) => void
}

const HunksContext = createContext<HunkSource | null>(null)

const hunkKey = (f: FileChange, h: PrHunk) => `${f.repo}\0${f.path}\0${h.id ?? `${h.newStart},${h.newLines}`}`

/**
 * The lines of the hunks of `stepId`'s PRs the page opened, each loaded once per fact view. The cache follows the view
 * in the same render, so a hunk open when the view refreshes loads again instead of waiting on the old one.
 */
function useHunkLines(stepId: string, view: FactView | null | undefined) {
  const store = useRef<HunkCache<FactView | null | undefined> | null>(null)
  store.current = hunkCacheFor(store.current, view)
  const [, loaded] = useState(0)
  const load = (f: FileChange, h: PrHunk) => {
    const cache = store.current!
    const repo = view?.repos.find((r) => r.name === f.repo)
    const key = hunkKey(f, h)
    if (!repo || !askHunk(cache, key)) return
    const done = (lines: HunkLines) => {
      cache.lines.set(key, lines)
      if (store.current === cache) loaded((n) => n + 1)
    }
    mag.stepHunk(stepId, repo.repo, repo.baseSha, repo.headSha, { ...h, path: f.path }).then(done, (e) => done(String((e as Error).message ?? e)))
  }
  return { load, lines: (f: FileChange, h: PrHunk) => store.current!.lines.get(hunkKey(f, h)) }
}

/** The fact of the task's PRs, loaded when the window opens and again when its heads or fact change. */
function useFactView(task: Task | undefined, key: string): FactView | null | undefined {
  const [view, setView] = useState<FactView | null | undefined>(undefined)
  useEffect(() => {
    if (!task) return
    let gone = false
    mag.stepFact(task.id).then((v) => !gone && setView(v), () => !gone && setView(null))
    return () => void (gone = true)
  }, [task?.id, key])
  return view
}

/** One hunk, loaded when it shows: its cited blocks marked, the rest of it muted. */
function HunkBlock({ pick, src }: { pick: HunkPick<FileChange>; src: HunkSource }) {
  const lines = src.lines(pick.file, pick.hunk)
  useEffect(() => src.load(pick.file, pick.hunk), [pick.file, pick.hunk])
  const h = pick.hunk
  return (
    <div className="hunkblock">
      <div className="small muted">
        <code>{h.id}{pick.blocks ? `.${pick.blocks.join(', .')}` : ''}</code> {pick.file.path}:{h.newStart}
      </div>
      {lines === null || lines === undefined ? <div className="muted small">Loading…</div>
        : typeof lines === 'string' ? <div className="muted small">{lines}</div>
        : (
          <pre className="facthunk">
            {markBlocks(lines, pick.blocks).map((l, i) => (
              <div key={i} className={`${l.line.startsWith('+') ? 'd-add' : l.line.startsWith('-') ? 'd-del' : 'muted'}${l.cited || !pick.blocks ? '' : ' uncited'}`}>{l.line}</div>
            ))}
          </pre>
        )}
    </div>
  )
}

/** The code a claim, a diagram node or a change row rests on, expanded in place (hunksOf). */
export function InlineHunks({ target }: { target: HunkTarget }) {
  const src = useContext(HunksContext)
  if (!src) return <p className="muted small">The fact of the PR is loading…</p>
  const picks = hunksOf(target, src.inventory, src.files)
  if (!picks.length) return <p className="muted small">No code behind it in the diff.</p>
  return <>{picks.map((p) => <HunkBlock key={hunkKey(p.file, p.hunk)} pick={p} src={src} />)}</>
}

/** A file of the full diff, folded: its hunks render, and so load, only once it is opened. */
function DiffFile({ file, hunks, src }: { file: FileChange; hunks: HunkPick<FileChange>[]; src: HunkSource }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="difffile" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <code>{file.path}</code> <span className="muted small">{hunks.length} hunk{hunks.length === 1 ? '' : 's'}</span>
      </summary>
      {shownHunks(hunks, open).map((p) => <HunkBlock key={hunkKey(p.file, p.hunk)} pick={p} src={src} />)}
    </details>
  )
}

/** The full diff at the bottom: the files under each change, folded until opened. */
export function FullDiff({ groups }: { groups: ChangeGroup<FileChange>[] }) {
  const src = useContext(HunksContext)
  if (!src) return <p className="muted small">Loading the diff…</p>
  if (!groups.length) return <p className="muted small">The PR changes no files.</p>
  return (
    <>
      {groups.map((g) => (
        <div key={`${g.kind}:${g.title}`} className={`diffgroup k-${g.kind}`}>
          <div className="cardhead">
            <b>{g.title}</b>
            <span className="muted small">{g.why}</span>
          </div>
          {g.files.length ? (
            g.files.map((f) => <DiffFile key={f.file.repo + f.file.path} file={f.file} hunks={f.hunks} src={src} />)
          ) : (
            <p className="muted small">No code behind it in the diff.</p>
          )}
        </div>
      ))}
    </>
  )
}

/** The review's (or the work's) conversation at the side of the window. */
export function ChatDrawer({ sessionId, state, onClose }: { sessionId: string | null; state: AppState; onClose: () => void }) {
  const session = state.sessions.find((s) => s.id === sessionId)
  return (
    <aside className="chatdrawer">
      <div className="cardhead">
        <b>Agent</b>
        <button className="link small" onClick={onClose}>close</button>
      </div>
      {session ? <Chat session={session} sessions={state.sessions} placeholder="Write to the agent…" /> : <p className="muted small">This review has no conversation yet.</p>}
    </aside>
  )
}

/** A set of diagrams on the page: a node click expands its hunks under the diagram. */
function InlineDiagrams({ entry, current, step }: { entry: InlineSet; current?: string; step: Task }) {
  const [node, setNode] = useState<{ diagram: DiagramCanvas; node: string } | null>(null)
  return (
    <div className="inlineset" data-set={entry.set.map((c) => c.id).join(' ')}>
      <div className="diffsub">{entry.title}</div>
      <DiffSetView
        key={entry.set[0].id}
        set={entry.set}
        current={current}
        step={entry.set[0].role === 'fact' ? step : undefined}
        inline
        onNode={(n, d) => setNode(n ? { diagram: d, node: n } : null)}
      />
      {node && (
        <div className="inlinehunks">
          <div className="small muted">Code of {node.node}</div>
          <InlineHunks target={{ kind: 'node', diagram: node.diagram.diagram, node: node.node }} />
        </div>
      )}
    </div>
  )
}

/**
 * The review window (review-v2-part-2-v1-2.2): one full-window page in a pop-out. A PR's review shows the shown result
 * (v1 | v2): verdict strip → direction card with its buttons → the four question cards → the changes table → the
 * diagrams inline → the full diff by change; a step shows its agent review, plan ↔ fact and its plan and fact diagrams
 * the same way. Every claim, diagram node and change row expands its hunks in place; no diagram opens a window. The
 * conversation is a drawer at the side; Discuss with agent opens it with the direction card.
 */
export function ReviewWindow({ state, taskId }: { state: AppState; taskId: string }) {
  const task = state.tasks.find((t) => t.id === taskId)
  const project = state.projects.find((p) => p.id === task?.projectId)
  const pr = task ? isReview(task) : false
  const canvases = useMemo(() => state.canvases.filter((c) => c.projectId === task?.projectId), [state.canvases, task?.projectId])
  const diagramsKey = canvases.filter((c) => c.taskId === taskId || c.stepId === taskId).map((c) => `${c.id}@${c.version}`).join(',')
  const view = useFactView(task, JSON.stringify([task?.prReview?.pr.head, task?.work?.repos.map((r) => r.prUrl), task?.fact?.at, diagramsKey]))
  const model = useMemo(() => (task ? reviewWindowModel(task, canvases, view) : null), [task, canvases, view])
  const hunkLines = useHunkLines(taskId, view)
  const hunks = useHunks(taskId, view)
  const [drawer, setDrawer] = useState(false)
  // The topic Discuss with agent went to; the owner conversation until then.
  const [discussed, setDiscussed] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deciding, setDeciding] = useState(false)
  // The diagram a claim's view asked for: its set opens on it and scrolls into sight.
  const [shown, setShown] = useState<string | undefined>(undefined)
  const diagramsAt = useRef<HTMLElement>(null)
  const parent = task?.parentId ? state.tasks.find((t) => t.id === task.parentId) : undefined
  const owner = task ? ownerSession(pr ? task : (parent ?? task), state.sessions) : null
  const title = task ? `Review · ${task.key} ${task.title}` : 'Not available'
  useEffect(() => void (document.title = title), [title])
  if (!task || !model) return <p className="muted page">Not available. It may have been deleted.</p>

  const src: HunkSource | null = view ? { files: view.files, inventory: model.inventory, lines: hunkLines.lines, load: hunkLines.load } : null
  const running = pr && reviewRunning(task, state.sessions)
  const act = (f: () => Promise<unknown>) => {
    setError(null)
    setDeciding(true)
    f().catch((e) => setError(String((e as Error).message ?? e))).finally(() => setDeciding(false))
  }
  const onView = (id: string) => {
    setShown(id)
    const at = diagramsAt.current?.querySelector(`[data-set~="${CSS.escape(id)}"]`) ?? diagramsAt.current
    at?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const review = task.prReview
  const r = model.result
  return (
    <HunksContext.Provider value={src}>
      <div className={`reviewwindow${drawer ? ' withdrawer' : ''}`}>
        <main className="reviewmain page">
          <div className="taskrow">
            <span className="key">{task.key}</span>
            {pr && review && project ? (
              <button className="link" title="Open the PR on GitHub" onClick={() => mag.open(review.pr.url)}>{prRepoName(project, review.pr)}#{review.pr.number} ↗</button>
            ) : (
              parent && <span className="muted small">step of {parent.key} {parent.title}</span>
            )}
            <div className="grow" />
            {model.report && <span className="muted small">{reportLine(model.report, model.kind)}</span>}
            <button className="small" title="The conversation with the agent, at the side" onClick={() => setDrawer(!drawer)}>{drawer ? 'Hide agent' : 'Agent'}</button>
          </div>
          <h1>{pr ? task.title.replace(/^[^:]*#\d+: /, '') : task.title}</h1>
          {error && <div className="banner">{error}</div>}
          {pr && review && <FormatSwitch work={task} review={review} running={running} onError={setError} />}
          {model.report && (
            <ReportView
              report={model.report}
              fact={task.fact}
              kind={model.kind}
              decisions={project?.directionDecisions}
              direction={pr ? {
                busy: running || deciding,
                discuss: () => act(async () => {
                  setDiscussed(await mag.discussDirection(task.id))
                  setDrawer(true)
                }),
                decide: (d) => act(() => mag.decideDirection(task.id, d)),
              } : undefined}
              onView={onView}
              expand={(target) => <InlineHunks target={target} />}
            />
          )}
          {model.blocks.includes('comparison') && (
            <section className="reportcard">
              <div className="cardhead"><h2>Plan ↔ fact</h2></div>
              {view ? <Comparison view={view} hunks={hunks} /> : <p className="muted small">{view === null ? 'No PR yet: nothing to compare.' : 'Comparing…'}</p>}
            </section>
          )}
          {model.blocks.includes('legacy') && r && (
            <section className="reportcard">
              {running && !r.verdict && <p className="muted">The agent is reviewing.</p>}
              {r.problem && <><h2>Problem</h2><Markdown text={r.problem} /></>}
              {r.approach && <><h2>Does it solve it</h2><Markdown text={r.approach} /></>}
              <h2>Findings</h2>
              {r.findings.length ? findingsByLevel(r.findings).map(({ level, findings }) => findings.map((f, i) => (
                <div key={`${level}${i}`} className="finding">
                  <span className="pill">{FINDING_LEVEL_LABELS[level]}</span>
                  <div className="grow">
                    <div>{f.text}</div>
                    {f.where && (
                      <div className="small">
                        <code>{f.where}</code>
                        <details className="inline"><summary className="link small">code</summary><InlineHunks target={{ kind: 'claim', cites: [f.where] }} /></details>
                      </div>
                    )}
                  </div>
                </div>
              ))) : <p className="muted small">{r.verdict ? 'No findings.' : 'None yet.'}</p>}
            </section>
          )}
          {model.blocks.includes('diagrams') && (
            <section ref={diagramsAt} className="reportcard">
              <div className="cardhead"><h2>Diagrams</h2><span className="muted small">click a node: its code here</span></div>
              {model.sets.map((s) => (
                <InlineDiagrams key={s.set[0].id} entry={s} step={task} current={s.set.some((c) => c.id === shown) ? shown : undefined} />
              ))}
            </section>
          )}
          <section className="reportcard">
            <div className="cardhead"><h2>Full diff</h2><span className="muted small">by change, files folded</span></div>
            {view === null ? <p className="muted small">No PR: no diff.</p> : <FullDiff groups={model.groups} />}
          </section>
        </main>
        {drawer && <ChatDrawer sessionId={discussed ?? owner?.id ?? null} state={state} onClose={() => setDrawer(false)} />}
      </div>
    </HunksContext.Provider>
  )
}
