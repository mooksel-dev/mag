import { useEffect, useState } from 'react'
import { isReview, prHeads, type Task } from '@mag/core'
import type { Change, FileChange, Level, MissingUnit } from '@mag/diff/types'
import type { FactView } from '../../preload/api'
import { STATUS_ICON, STATUS_LABEL, fileKey, filesOf, hunksOf, mark, rows, statusCounts, unverified, what, type FactItem } from './factView'

const mag = window.mag

const short = (sha: string) => sha.slice(0, 7)

/** What a missing unit lacks on the fact set. */
const MISSING: Record<MissingUnit['rule'], string> = {
  method: 'no interface line, no note',
  logic: 'no flowchart, no trivialLogic, no note',
  model: 'no entity on a data diagram, no note',
  index: 'no changed index on a data diagram, no note',
  dependency: 'no use marked on the set, no note',
}

const LevelBadge = ({ level }: { level: Level }) => <span className={`factlevel lv-${level}`}>{level}</span>

/** The diffs of files the user opened, loaded from the step's PR on the first click. */
export function useHunks(stepId: string, view: FactView | null | undefined) {
  const [open, setOpen] = useState<Record<string, string[] | string | null>>({})
  useEffect(() => setOpen({}), [view])
  const toggle = (f: FileChange) => {
    const repo = view?.repos.find((r) => r.name === f.repo)
    if (!repo) return
    const key = fileKey(f)
    if (key in open) {
      setOpen(({ [key]: _, ...rest }) => rest)
      return
    }
    setOpen((o) => ({ ...o, [key]: null }))
    Promise.all(hunksOf(f).map((h) => mag.stepHunk(stepId, repo.repo, repo.baseSha, repo.headSha, h))).then(
      (hunks) => setOpen((o) => (key in o ? { ...o, [key]: hunks.flatMap((lines, i) => (i ? ['…', ...lines] : lines)) } : o)),
      (e) => setOpen((o) => (key in o ? { ...o, [key]: String((e as Error).message ?? e) } : o)),
    )
  }
  return { toggle, lines: (f: FileChange) => open[fileKey(f)] }
}

export type Hunks = ReturnType<typeof useHunks>

/** A changed file: its path opens its diff inline. */
export function FileLink({ f, hunks }: { f: FileChange; hunks: Hunks }) {
  const lines = hunks.lines(f)
  return (
    <div className="factline">
      <button className="link small" title="Show the diff of this file" onClick={() => hunks.toggle(f)}>
        {f.path} {lines !== undefined ? '▾' : '▸'}
      </button>
      {lines === null && <div className="muted small">Loading…</div>}
      {typeof lines === 'string' && <div className="muted small">{lines}</div>}
      {Array.isArray(lines) && (
        <pre className="facthunk">
          {lines.length ? lines.map((l, i) => <div key={i} className={l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : 'muted'}>{l}</div>) : <span className="muted">Not found in the diff.</span>}
        </pre>
      )}
    </div>
  )
}

/** One change of the fact diagram: mark, what, whether it rests on the PR, and the files it gives. */
function FactLine({ c, view, hunks }: { c: Change; view: FactView; hunks: Hunks }) {
  const why = unverified(c, view)
  return (
    <div className="factline">
      <span className={`d-${c.diff}`}>{mark(c)}</span> {what(c)}
      {why && <span className="diffchip s-missing small" title="mag cannot tie this line to the PR's files of its module">{why}</span>}
      {filesOf(c, view.files).map((f) => <FileLink key={fileKey(f)} f={f} hunks={hunks} />)}
    </div>
  )
}

function Row({ item, view, hunks }: { item: FactItem; view: FactView; hunks: Hunks }) {
  return (
    <tr>
      <td className={`factstatus s-${item.status}`} title={STATUS_LABEL[item.status]}>{STATUS_ICON[item.status]}</td>
      <td><LevelBadge level={item.level} /></td>
      <td>{item.plan ? <><span className={`d-${item.plan.diff}`}>{mark(item.plan)}</span> {what(item.plan)}</> : <span className="muted">—</span>}</td>
      <td>
        {item.fact ? <FactLine c={item.fact} view={view} hunks={hunks} /> : <span className="muted">not on the fact</span>}
        {item.note && <div className="muted small">{item.note}</div>}
      </td>
    </tr>
  )
}

/**
 * Which changed code files the step's fact set shows; those it does not, first. Then the changed methods, models,
 * logic and dependencies it neither shows nor explains: the sure ones block merge, the unsure ones only warn
 * (povnyi-diff-nabir-pov-iazanykh.1), and where the set does not hang together.
 */
export function CoverageView({ view, hunks }: { view: FactView; hunks: Hunks }) {
  const [rest, setRest] = useState(false)
  const cover = view.coverage
  const other = view.files.filter((f) => f.kind !== 'code')
  const sure = view.missing.filter((m) => m.unit.confidence === 'high')
  const unsure = view.missing.filter((m) => m.unit.confidence === 'low')
  const set = view.set.length > 1 ? ` and ${view.set.length - 1} more diagram${view.set.length > 2 ? 's' : ''} of its set` : ''
  return (
    <div className="factcoverage">
      <div className="diffsub">
        Coverage <span className="muted small">· {view.fact ? `which changed code files ${view.fact.title} (v${view.fact.version})${set} shows` : 'no fact diagram yet'}</span>
      </div>
      <div className="chips">
        {cover && <span className="diffchip">shown {cover.shown.length}</span>}
        {cover && <span className={`diffchip${cover.unshown.length ? ' s-missing' : ''}`}>not shown {cover.unshown.length}</span>}
        <span className={`diffchip${view.unverified.length ? ' s-missing' : ''}`}>unverified lines {view.unverified.length}</span>
        {view.fact && <span className={`diffchip${sure.length ? ' s-missing' : ''}`} title="Changed public methods, models, logic and dependencies the fact set neither shows nor explains">missing changes {sure.length}</span>}
        {unsure.length > 0 && <span className="diffchip" title="mag is not sure of these: a warning, not a blocker">maybe missing {unsure.length}</span>}
        {view.warnings.length > 0 && <span className="diffchip s-missing" title={view.warnings.join('\n')}>set warnings {view.warnings.length}</span>}
        {view.outside && <span className="diffchip" title="The repository is outside the project: its modules are its folders">without the project architecture</span>}
        {other.length > 0 && (
          <button className="diffchip link" onClick={() => setRest(!rest)}>
            {rest ? '▾' : '▸'} not code {other.length}
          </button>
        )}
      </div>
      {((cover?.unshown.length ?? 0) > 0 || rest) && (
        <table className="facttable">
          <tbody>
            {cover?.unshown.map((f) => (
              <tr key={fileKey(f)}>
                <td className="factstatus s-missing">✗</td>
                <td className="muted small">{f.module ?? 'no module'}</td>
                <td colSpan={2}><FileLink f={f} hunks={hunks} /></td>
              </tr>
            ))}
            {rest && other.map((f) => (
              <tr key={fileKey(f)}>
                <td />
                <td className="muted small">{f.kind}</td>
                <td colSpan={2}><FileLink f={f} hunks={hunks} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.missing.length > 0 && (
        <table className="facttable">
          <tbody>
            {[...sure, ...unsure].map((m, i) => (
              <tr key={i}>
                <td className={`factstatus${m.unit.confidence === 'high' ? ' s-missing' : ''}`}>{m.unit.confidence === 'high' ? '✗' : '?'}</td>
                <td className="muted small">{m.rule}</td>
                <td className="muted small">{m.unit.module ?? 'no module'}</td>
                <td>
                  {m.unit.kind === 'dependency' ? `${m.unit.diff === 'add' ? '+' : '−'} ${m.unit.module} → ${m.unit.name}` : `${m.unit.diff === 'add' ? '+' : m.unit.diff === 'del' ? '−' : '~'} ${m.unit.name || '(code under no named declaration)'}`}{' '}
                  <span className="muted small">{MISSING[m.rule]} · {m.unit.repo}:{m.unit.file}:{m.unit.line}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.warnings.length > 0 && <ul className="muted small">{view.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
    </div>
  )
}

function Body({ step, view }: { step: Task; view: FactView }) {
  const hunks = useHunks(step.id, view)
  // A review of a teammate's PR has no plan to compare and no merge of ours to allow: only the fact against its diff
  // (reviews-prybraty-spysok-pr-i.1).
  const review = isReview(step)
  return (
    <>
      <div className="muted small">
        {view.repos.map((x) => `${x.name} ${short(x.baseSha)}..${short(x.headSha)}`).join(' · ')}
        {review ? '' : view.plans.length ? ` · plan: ${view.plans.map((p) => `${p.title} v${p.version}`).join(', ')}` : ' · no plan diagram: nothing it changes is planned'}
      </div>
      <div className={view.blockers.length ? 'factthreshold warn' : 'factthreshold ok'}>
        {view.blockers.length ? (
          <>
            {review ? 'The fact does not cover the PR yet:' : 'Merge is not allowed, look at most:'}
            <ul>{view.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
          </>
        ) : review ? (
          'The fact shows every changed code file, method, model, logic and dependency and rests on the PR.'
        ) : (
          'Merge is allowed: the fact shows every changed code file, method, model, logic and dependency, rests on the PR and agrees with the plan.'
        )}
      </div>
      {!review && <Comparison view={view} hunks={hunks} />}
      <CoverageView view={view} hunks={hunks} />
    </>
  )
}

/** Plan ↔ fact of a step: the counts by status and the differences, the significant ones first. */
function Comparison({ view, hunks }: { view: FactView; hunks: ReturnType<typeof useHunks> }) {
  const [all, setAll] = useState(false)
  const [matches, setMatches] = useState(false)
  const r = rows(view.items, all)
  return (
    <>
      <div className="factbar">
        <div className="chips">
          {statusCounts(view.items).map((s) => (
            <span key={s.status} className={`diffchip s-${s.status}`}>{STATUS_ICON[s.status]} {STATUS_LABEL[s.status]} {s.count}</span>
          ))}
        </div>
        <div className="grow" />
        <span className="small">
          Show:{' '}
          <button className={`link${all ? '' : ' on'}`} onClick={() => setAll(false)}>critical · high · medium</button>|
          <button className={`link${all ? ' on' : ''}`} onClick={() => setAll(true)}>all</button>
        </span>
      </div>
      {view.items.length === 0 ? (
        <p className="muted small">Neither the plan nor the fact diagram draws a change.</p>
      ) : (
        <table className="facttable">
          <thead>
            <tr><th /><th>level</th><th>Plan</th><th>Fact</th></tr>
          </thead>
          <tbody>
            {r.shown.map((i, n) => <Row key={n} item={i} view={view} hunks={hunks} />)}
            {r.matches.length > 0 && !matches && (
              <tr>
                <td className="factstatus s-match">✓</td>
                <td colSpan={3} className="muted">
                  {r.matches.length} as planned: {r.matches.map((i) => what(i.plan!)).join('; ')}{' '}
                  <button className="link small" onClick={() => setMatches(true)}>show</button>
                </td>
              </tr>
            )}
            {matches && r.matches.map((i, n) => <Row key={`m${n}`} item={i} view={view} hunks={hunks} />)}
            {r.folded > 0 && (
              <tr>
                <td />
                <td colSpan={3}>
                  <button className="link small" onClick={() => setAll(true)}>▸ {r.folded} low / noise changes folded</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </>
  )
}

/**
 * Plan ↔ fact of a step (T-57.5, T-58): its fact diagram, drawn by the reviewer from the diff, against its plan
 * diagrams; the threshold; which changed files the fact shows and which of its lines do not rest on the PR; the diff
 * behind each file. Open by default while a PR is open; computed when open. A review of a teammate's PR (`step` is
 * the review) shows the fact of its PR the same way, without a plan.
 */
export function FactPanel({ step, diagramsKey }: { step: Task; diagramsKey: string }) {
  const review = isReview(step)
  const heads = review ? { pr: step.prReview?.pr.head ?? '' } : prHeads(step.work)
  const live = Object.keys(heads).length > 0
  const [open, setOpen] = useState(live)
  const [view, setView] = useState<FactView | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const key = JSON.stringify([heads, step.fact?.at ?? null, diagramsKey, nonce])
  useEffect(() => {
    if (!open) return
    let gone = false
    setError(null)
    mag.stepFact(step.id).then(
      (v) => !gone && setView(v),
      (e) => !gone && setError(String((e as Error).message ?? e)),
    )
    return () => void (gone = true)
  }, [open, key, step.id])
  const counts = step.fact?.counts
  return (
    <div className="factpanel">
      <div className="factbar">
        <button className="link diffsub" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} {review ? 'Fact' : 'Plan ↔ fact'}
        </button>
        {!open && counts && (
          <span className="muted small">
            {Object.entries(counts).filter(([, n]) => n > 0).map(([s, n]) => `${s in STATUS_LABEL ? STATUS_LABEL[s as keyof typeof STATUS_LABEL] : s.replace('unshown', 'not shown')} ${n}`).join(' · ')}
            {step.fact!.blockers.length > 0 && !review && ' · merge not allowed'}
          </span>
        )}
        <div className="grow" />
        {open && view && (
          <button className="link small" title="Check the fact again" onClick={() => setNonce(nonce + 1)}>↻</button>
        )}
      </div>
      {open && (
        error ? <p className="muted small">mag could not compare: {error}</p>
        : view === undefined ? <p className="muted small">Comparing…</p>
        : view === null ? <p className="muted small">{review ? 'No PR to compare.' : 'No PR yet: the fact is drawn in the review once the step has one.'}</p>
        : <Body step={step} view={view} />
      )}
    </div>
  )
}
