import { useState } from 'react'
import { chatCommands, ideaTitle, projectIdeas, resolveChoice, type AgentSession, type Attachment, type Idea, type Project } from '@mag/core'
import type { AppState } from '../../preload/api'
import { Chat, Composer, ModelChip } from './Chat'
import { ago } from './format'
import { useNow } from './Tasks'

const mag = window.mag

/** The idea's topic while it has a discussion: a deleted one leaves none. */
const ideaTopic = (idea: Idea, sessions: AgentSession[]) => (idea.topicId ? sessions.find((s) => s.id === idea.topicId) : undefined)

/**
 * The Ideas tab: the project's ideas (T-55.6), things worth doing that nobody works on yet. No status: a line per idea,
 * its page has the full text and its own discussion; a work starts from it.
 */
export function IdeasPage({ project, state, ideaId, onOpenIdea, onOpenKey, onOpenTopic }: {
  project: Project
  state: AppState
  /** The idea open on its page; the list when it is missing or gone (deleted, or a work now). */
  ideaId: string | null
  onOpenIdea: (id: string | null) => void
  onOpenKey: (key: string) => void
  /** Show the topic in the chat aside. */
  onOpenTopic: (id: string) => void
}) {
  const now = useNow(15_000)
  const ideas = projectIdeas(state.ideas, project.id)
  const open = ideas.find((i) => i.id === ideaId)
  if (open) return <IdeaView key={open.id} idea={open} project={project} state={state} now={now} onBack={() => onOpenIdea(null)} onOpenKey={onOpenKey} onOpenTopic={onOpenTopic} />
  return (
    <section className="page">
      <div className="tasksbar">
        <h1>Ideas</h1>
        <span className="grow" />
      </div>
      <NewIdea projectId={project.id} />
      {ideas.length ? (
        <div className="tree idealist">
          {ideas.map((i) => <IdeaRow key={i.id} idea={i} topic={ideaTopic(i, state.sessions)} now={now} onOpen={() => onOpenIdea(i.id)} onOpenKey={onOpenKey} />)}
        </div>
      ) : (
        <p className="muted">No ideas. Agents put findings outside their scope here too.</p>
      )}
    </section>
  )
}

function NewIdea({ projectId }: { projectId: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null) return <button className="ideanew" onClick={() => setDraft('')}>+ Idea</button>
  const add = () => {
    const t = draft.trim()
    if (t) void mag.addIdea(projectId, t).then(() => setDraft(null))
  }
  return (
    <form className="ideaadd" onSubmit={(e) => { e.preventDefault(); add() }}>
      <textarea
        autoFocus
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="An idea… The first line is its title."
        aria-label="New idea"
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add() }
          else if (e.key === 'Escape') setDraft(null)
        }}
      />
      <div className="ideaaddactions">
        <button type="submit" className="primary small" disabled={!draft.trim()}>Add</button>
        <button type="button" className="small" onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </form>
  )
}

/** Where an idea came from: the work or step whose agent found it, else the user's own. */
function Source({ idea, onOpenKey }: { idea: Idea; onOpenKey: (key: string) => void }) {
  if (!idea.source) return <>yours</>
  return <>from <button className="link key" onClick={(e) => { e.stopPropagation(); onOpenKey(idea.source!.replace(/\.\d+$/, '')) }}>{idea.source}</button></>
}

/** Messages in a discussion: the user's and the agent's replies. */
const messages = (topic: AgentSession) => topic.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').length

function IdeaRow({ idea, topic, now, onOpen, onOpenKey }: { idea: Idea; topic?: AgentSession; now: number; onOpen: () => void; onOpenKey: (key: string) => void }) {
  const said = topic ? messages(topic) : 0
  return (
    <div className="rowwrap">
      <div className="row idearow" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}>
        <div className="idealine">
          <div className="ideatitle">{ideaTitle(idea)}</div>
          <div className="muted small"><Source idea={idea} onOpenKey={onOpenKey} /> · {ago(idea.createdAt, now)}</div>
        </div>
        {said > 0 && <span className="muted small" title="Has a discussion">💬 {said}</span>}
      </div>
    </div>
  )
}

/** An idea's page: its full text, edit, delete, Start work, and its discussion in its own topic. */
function IdeaView({ idea, project, state, now, onBack, onOpenKey, onOpenTopic }: {
  idea: Idea
  project: Project
  state: AppState
  now: number
  onBack: () => void
  onOpenKey: (key: string) => void
  onOpenTopic: (id: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const topic = ideaTopic(idea, state.sessions)
  const busy = topic?.status === 'running'
  const save = () => {
    const t = draft?.trim()
    if (t && t !== idea.text) void mag.updateIdea(idea.id, t)
    setDraft(null)
  }
  const remove = () => {
    if (confirm('Delete this idea?')) void mag.deleteIdea(idea.id).then(onBack)
  }
  // Its topic owns the work from now on: the chat aside shows it once the idea has left the list.
  const start = () => {
    setError(null)
    mag.startIdea(idea.id).then(onOpenTopic, (e: Error) => setError(e.message))
  }
  // The topic is created by the first message, so opening an idea leaves no empty topics behind.
  const discuss = async (text: string, att: Attachment[]) => {
    const id = await mag.discussIdea(idea.id)
    await mag.send(id, text, att)
  }
  const chip = <ModelChip project={project} activeModel={topic?.activeModel} />
  return (
    <section className="taskview">
      <div className="taskmain">
        <div className="taskhead">
          <div className="taskrow">
            <button className="crumb" onClick={onBack}>Ideas ›</button>
            <span className="muted small"><Source idea={idea} onOpenKey={onOpenKey} /> · {ago(idea.createdAt, now)}</span>
            <div className="grow" />
            {draft === null && <button onClick={() => setDraft(idea.text)}>Edit</button>}
            <button onClick={remove}>Delete</button>
            <button
              className="primary"
              disabled={busy}
              title={topic ? 'Start a work from it in its topic, which then owns the work; it leaves the list once the work is created' : 'Start a work from it in a new topic; it leaves the list'}
              onClick={start}
            >
              ▶ Start work
            </button>
          </div>
          <h1>{ideaTitle(idea)}</h1>
          {error && <div className="banner">{error}</div>}
        </div>
        <div className="taskbody">
          {draft === null ? (
            <div className="ideatext">{idea.text}</div>
          ) : (
            <div className="ideaedit">
              <textarea
                autoFocus
                rows={12}
                value={draft}
                aria-label="Idea"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save() }
                  else if (e.key === 'Escape') setDraft(null)
                }}
              />
              <div className="ideaaddactions">
                <button className="primary small" disabled={!draft.trim()} onClick={save}>Save</button>
                <button className="small" onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="chatpanel">
        <div className="chathead"><span className="chatmodel">Discussion</span></div>
        {topic && topic.items.length > 0 ? (
          <Chat session={topic} sessions={state.sessions} onOpenTask={onOpenKey} placeholder="Message…" chip={chip} />
        ) : (
          <div className="chatbox">
            <div className="items">
              <p className="muted small">
                Talk this idea over with the agent: it sees the idea and reads the code. Start work plans it right here,
                and this topic owns the work.
              </p>
            </div>
            <Composer
              busy={false}
              placeholder="Message…"
              commands={chatCommands(topic ?? { projectId: project.id, agent: resolveChoice(project, 'chat').agent }, state.sessions)}
              onSend={discuss}
              chip={chip}
            />
          </div>
        )}
      </div>
    </section>
  )
}
