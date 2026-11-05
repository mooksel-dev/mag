import { useEffect, useState } from 'react'
import {
  REVIEW_FORMATS,
  byActivity,
  chatCommands,
  composerRoute,
  projectReviewFormat,
  resolveChoice,
  workCards,
  type Attachment,
  type Project,
  type ReviewFormat,
  type WorkCard,
} from '@mag/core'
import type { AppState } from '../../preload/api'
import { MoveButton } from './Cards'
import { Composer, ModelChip } from './Chat'
import { useNow } from './Tasks'
import { cardSelection, type HomeGroup, type Selection } from './WorkList'

const mag = window.mag

/**
 * Home (redesign-start-screen-big-composer.1), shown by ＋ New, ⌘N and when nothing is selected: one big composer whose
 * chip says what send will do (core composerRoute), then the cards waiting on the user with their action and the works
 * an agent runs. Opened by a group's + (`group`), what it creates goes first in that group (`onCreated`, its ref).
 */
export function HomeScreen({ project, state, group, onSelect, onCreated }: {
  project: Project
  state: AppState
  group?: HomeGroup | null
  onSelect: (s: Selection) => void
  /** Called with the sidebar ref (work:<id> | topic:<id>) of what send or import created. */
  onCreated?: (ref: string) => void
}) {
  const now = useNow(15_000)
  const tasks = state.tasks.filter((t) => t.projectId === project.id)
  const cards = workCards(project.id, tasks, state.sessions, now)
  const waiting = byActivity(cards.filter((c) => c.group === 'waiting'))
  const working = byActivity(cards.filter((c) => c.group === 'working'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The format a review of a PR starts with (review-v2-part-2-v1-2.1): the project's, unless the user picks the other.
  const [format, setFormat] = useState<ReviewFormat>(projectReviewFormat(project))
  useEffect(() => setFormat(projectReviewFormat(project)), [project.reviewFormat]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Runs one call that opens a work; its error stays under the composer and keeps the text (by throwing). */
  const run = async (call: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await call()
    } catch (err) {
      setError(String((err as Error).message ?? err))
      throw err
    } finally {
      setBusy(false)
    }
  }
  const opened = (r: { taskId: string } | { error: string } | null) => {
    if (r && 'error' in r) throw new Error(r.error)
    if (!r) return
    onCreated?.(`work:${r.taskId}`)
    onSelect({ kind: 'work', id: r.taskId })
  }
  // Import review (review-v2-part-2-v1-2.3): a review's .zip dropped on the composer, or picked; it opens read only.
  const importReview = (zipPath?: string) => run(async () => opened(await mag.importReview(project.id, zipPath))).catch(() => {})
  const onFiles = (files: File[]) => {
    const route = composerRoute('', files.map((f) => f.name))
    if (route.kind !== 'import') return false
    void importReview(mag.pathForFile(files.find((f) => f.name === route.file)!))
    return true
  }
  const send = (text: string, attachments: Attachment[]) => run(async () => {
    const route = composerRoute(text)
    switch (route.kind) {
      case 'review':
        return opened(await mag.startReview(project.id, route.url, format))
      case 'ticket':
        return opened(await mag.workFromTicket(project.id, route.url))
      case 'ask': {
        const id = await mag.newChat(project.id)
        onCreated?.(`topic:${id}`)
        onSelect({ kind: 'topic', id })
        return mag.send(id, route.text, attachments)
      }
      case 'none':
      case 'import':
        throw new Error('Write what to do: a question, a task, or a PR / ticket link.')
    }
  })
  const intent = (text: string) => {
    const route = composerRoute(text)
    if (route.kind === 'none') return null
    return (
      <span className="intent">
        → {route.label}
        {route.kind === 'review' && (
          <select value={format} aria-label="Review format" title="v1: findings by level and a verdict; v2: the questions and the direction for you to decide. The default is the project's setting." onChange={(e) => setFormat(e.target.value as ReviewFormat)}>
            {REVIEW_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        )}
      </span>
    )
  }

  return (
    <main className="home">
      <div className="homein">
        {group && <p className="homegroup small">New in <b>{group.name}</b></p>}
        <h2 className="hello">What are we doing in {project.name}?</h2>
        <div>
          <Composer
            busy={busy}
            placeholder="Ask anything, describe a task, or paste a PR / ticket link…"
            commands={chatCommands({ projectId: project.id, agent: resolveChoice(project, 'chat').agent }, state.sessions)}
            onSend={send}
            chip={<ModelChip project={project} />}
            intent={intent}
            onFiles={onFiles}
            autoFocus
          />
          {error && <p className="err small homeerr" role="alert">{error}</p>}
        </div>
        <div className="hints">
          <span>Words → discussion</span>
          <span>github.com/…/pull/N → review (v1 / v2)</span>
          <span>ticket link → work</span>
          <button type="button" disabled={busy} title="Open a review exported from another mag (.zip), read only; or drop the .zip on the composer" onClick={() => void importReview()}>
            drop a review .zip → import
          </button>
        </div>
        {waiting.length > 0 && (
          <section className="homesec">
            <h3>Waiting on you · {waiting.length}</h3>
            <div className="homecards">{waiting.map((c) => <HomeCard key={c.id} card={c} state={state} onSelect={onSelect} />)}</div>
          </section>
        )}
        {working.length > 0 && (
          <section className="homesec">
            <h3>Agents working · {working.length}</h3>
            <div className="homecards">{working.map((c) => <HomeCard key={c.id} card={c} state={state} onSelect={onSelect} />)}</div>
          </section>
        )}
      </div>
    </main>
  )
}

/** A card of Home: kind, stage and progress; the title; whose move; the move's button and Open. */
function HomeCard({ card: c, state, onSelect }: { card: WorkCard; state: AppState; onSelect: (s: Selection) => void }) {
  const open = () => onSelect(cardSelection(c))
  const meta = [c.kind, c.stage, c.progress].filter(Boolean).join(' · ')
  return (
    <div className="homecard">
      <span className="k">{meta}</span>
      <button className="t" onClick={open}>{c.title}</button>
      <span className={`w ${c.move.who}`}>{c.move.text}</span>
      <div className="acts">
        {c.move.action && c.task && <MoveButton action={c.move.action} work={c.task} state={state} onAnswer={open} />}
        <button className="small" onClick={open}>Open</button>
      </div>
    </div>
  )
}
