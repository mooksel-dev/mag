import { useEffect, useState } from 'react'
import { prHeads, type Task } from '@mag/core'
import type { Change, FileChange, Level } from '@mag/diff/types'
import type { FactView } from '../../preload/api'
import { STATUS_ICON, STATUS_LABEL, fileKey, filesOf, hunksOf, mark, rows, statusCounts, unverified, what, type FactItem } from './factView'

const mag = window.mag

const short = (sha: string) => sha.slice(0, 7)

const LevelBadge = ({ level }: { level: Level }) => <span className={`factlevel lv-${level}`}>{level}</span>

/** The diffs of files the user opened, loaded from the step's PR on the first click. */
function useHunks(stepId: string, view: FactView | null | undefined) {
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

type Hunks = ReturnType<typeof useHunks>

/** A changed file: its path opens its diff inline. */
function FileLink({ f, hunks }: { f: FileChange; hunks: Hunks }) {
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

/** Which changed code files the step's fact diagram shows; those it does not, first. */
export function CoverageView({ view, hunks }: { view: FactView; hunks: Hunks }) {
  const [rest, setRest] = useState(false)
  const cover = view.coverage
  const other = view.files.filter((f) => f.kind !== 'code')
  return (
    <div className="factcoverage">
      <div className="diffsub">
        Coverage <span className="muted small">· {view.fact ? `which changed code files ${view.fact.title} (v${view.fact.version}) shows` : 'no fact diagram yet'}</span>
      </div>
      <div className="chips">
        {cover && <span className="diffchip">shown {cover.shown.length}</span>}
        {cover && <span className={`diffchip${cover.unshown.length ? ' s-missing' : ''}`}>not shown {cover.unshown.length}</span>}
        <span className={`diffchip${view.unverified.length ? ' s-missing' : ''}`}>unverified lines {view.unverified.length}</span>
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
    </div>
  )
}

function Body({ step, view }: { step: Task; view: FactView }) {
  const [all, setAll] = useState(false)
  const [matches, setMatches] = useState(false)
  const hunks = useHunks(step.id, view)
  const r = rows(view.items, all)
  return (
    <>
      <div className="muted small">
        {view.repos.map((x) => `${x.name} ${short(x.baseSha)}..${short(x.headSha)}`).join(' · ')}
        {view.plans.length ? ` · plan: ${view.plans.map((p) => `${p.title} v${p.version}`).join(', ')}` : ' · no plan diagram: nothing it changes is planned'}
      </div>
      <div className={view.blockers.length ? 'factthreshold warn' : 'factthreshold ok'}>
        {view.blockers.length ? (
          <>
            Merge is not allowed, look at most:
            <ul>{view.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
          </>
        ) : (
          'Merge is allowed: the fact shows every changed code file, rests on the PR and agrees with the plan.'
        )}
      </div>
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
      <CoverageView view={view} hunks={hunks} />
    </>
  )
}

/**
 * Plan ↔ fact of a step (T-57.5, T-58): its fact diagram, drawn by the reviewer from the diff, against its plan
 * diagrams; the threshold; which changed files the fact shows and which of its lines do not rest on the PR; the diff
 * behind each file. Open by default while a PR is open; computed when open.
 */
export function FactPanel({ step, diagramsKey }: { step: Task; diagramsKey: string }) {
  const live = Object.keys(prHeads(step.work)).length > 0
  const [open, setOpen] = useState(live)
  const [view, setView] = useState<FactView | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const key = JSON.stringify([prHeads(step.work), step.fact?.at ?? null, diagramsKey, nonce])
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
          {open ? '▾' : '▸'} Plan ↔ fact
        </button>
        {!open && counts && (
          <span className="muted small">
            {Object.entries(counts).filter(([, n]) => n > 0).map(([s, n]) => `${s in STATUS_LABEL ? STATUS_LABEL[s as keyof typeof STATUS_LABEL] : s.replace('unshown', 'not shown')} ${n}`).join(' · ')}
            {step.fact!.blockers.length > 0 && ' · merge not allowed'}
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
        : view === null ? <p className="muted small">No PR yet: the fact is drawn in the review once the step has one.</p>
        : <Body step={step} view={view} />
      )}
    </div>
  )
}
