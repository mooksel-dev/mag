import { useEffect, useState } from 'react'
import { prHeads, type Task } from '@mag/core'
import type { Level } from '@mag/diff/types'
import type { FactChange, FactView } from '../../preload/api'
import { STATUS_ICON, STATUS_LABEL, hunkKey, isSignificant, mark, rows, statusCounts, what, where, type FactItem } from './factView'

const mag = window.mag

const short = (sha: string) => sha.slice(0, 7)

const LevelBadge = ({ level }: { level: Level }) => <span className={`factlevel lv-${level}`}>{level}</span>

/** The hunks the user opened, loaded from the step's PR on the first click. */
function useHunks(stepId: string, view: FactView | null | undefined) {
  const [open, setOpen] = useState<Record<string, string[] | string | null>>({})
  useEffect(() => setOpen({}), [view])
  const toggle = (c: FactChange) => {
    const at = where(c)
    const repo = view?.repos.find((r) => r.repo === c.repo)
    if (!at || !repo) return
    const key = hunkKey(c.repo, at.hunk)
    if (key in open) {
      setOpen(({ [key]: _, ...rest }) => rest)
      return
    }
    setOpen((o) => ({ ...o, [key]: null }))
    mag.stepHunk(stepId, c.repo, repo.baseSha, repo.headSha, at.hunk).then(
      (lines) => setOpen((o) => (key in o ? { ...o, [key]: lines } : o)),
      (e) => setOpen((o) => (key in o ? { ...o, [key]: String((e as Error).message ?? e) } : o)),
    )
  }
  const lines = (c: FactChange) => {
    const at = where(c)
    return at ? open[hunkKey(c.repo, at.hunk)] : undefined
  }
  return { toggle, lines }
}

type Hunks = ReturnType<typeof useHunks>

/** One change of the code: mark, what, and a `path:line` that opens its hunk inline. */
function FactLine({ c, hunks }: { c: FactChange; hunks: Hunks }) {
  const at = where(c)
  const lines = hunks.lines(c)
  return (
    <div className="factline">
      <span className={`d-${c.diff}`}>{mark(c)}</span> {what(c)}{' '}
      {at && (
        <button className="link small" title="Show this hunk" onClick={() => hunks.toggle(c)}>
          {at.label} {lines !== undefined ? '▾' : '▸'}
        </button>
      )}
      {lines === null && <div className="muted small">Loading…</div>}
      {typeof lines === 'string' && <div className="muted small">{lines}</div>}
      {Array.isArray(lines) && (
        <pre className="facthunk">
          {lines.length ? lines.map((l, i) => <div key={i} className={l.startsWith('+') ? 'd-add' : 'd-del'}>{l}</div>) : <span className="muted">Not found in the diff.</span>}
        </pre>
      )}
    </div>
  )
}

function Row({ item, hunks }: { item: FactItem; hunks: Hunks }) {
  return (
    <tr>
      <td className={`factstatus s-${item.status}`} title={STATUS_LABEL[item.status]}>{STATUS_ICON[item.status]}</td>
      <td><LevelBadge level={item.level} /></td>
      <td>{item.plan ? <><span className={`d-${item.plan.diff}`}>{mark(item.plan)}</span> {what(item.plan)}</> : <span className="muted">—</span>}</td>
      <td>
        {item.fact.map((c, i) => <FactLine key={i} c={c} hunks={hunks} />)}
        {!item.fact.length && <span className="muted">{item.status === 'unchecked' ? 'the code cannot tell: read it' : 'not in the code'}</span>}
        {item.note && <div className="muted small">{item.note}</div>}
      </td>
    </tr>
  )
}

/** What of the PR's code the step's fact diagram shows; significant changes it leaves out first. */
export function CoverageView({ coverage, hunks }: { coverage: NonNullable<FactView['coverage']>; hunks: Hunks }) {
  const [rest, setRest] = useState(false)
  const significant = coverage.unshown.filter((c) => isSignificant(c.level))
  const other = coverage.unshown.filter((c) => !significant.includes(c))
  return (
    <div className="factcoverage">
      <div className="diffsub">
        Coverage <span className="muted small">· what {coverage.canvas.title} (v{coverage.canvas.version}) shows</span>
      </div>
      <div className="chips">
        <span className="diffchip">shown {coverage.shown.length}</span>
        <span className={`diffchip${significant.length ? ' s-missing' : ''}`}>significant not shown {significant.length}</span>
        {other.length > 0 && (
          <button className="diffchip link" onClick={() => setRest(!rest)}>
            {rest ? '▾' : '▸'} other not shown {other.length}
          </button>
        )}
      </div>
      {(significant.length > 0 || rest) && (
        <table className="facttable">
          <tbody>
            {[...significant, ...(rest ? other : [])].map((c, i) => (
              <tr key={i}>
                <td className="factstatus s-missing">✗</td>
                <td>{c.level && <LevelBadge level={c.level} />}</td>
                <td colSpan={2}><FactLine c={c} hunks={hunks} /></td>
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
          'Merge is allowed: every significant change is on the plan, all changed code is read by an adapter.'
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
        <p className="muted small">The code changes nothing the plan or the architecture can tell.</p>
      ) : (
        <table className="facttable">
          <thead>
            <tr><th /><th>level</th><th>Plan</th><th>Fact (code)</th></tr>
          </thead>
          <tbody>
            {r.shown.map((i, n) => <Row key={n} item={i} hunks={hunks} />)}
            {r.matches.length > 0 && !matches && (
              <tr>
                <td className="factstatus s-match">✓</td>
                <td colSpan={3} className="muted">
                  {r.matches.length} as planned: {r.matches.map((i) => what(i.plan!)).join('; ')}{' '}
                  <button className="link small" onClick={() => setMatches(true)}>show</button>
                </td>
              </tr>
            )}
            {matches && r.matches.map((i, n) => <Row key={`m${n}`} item={i} hunks={hunks} />)}
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
      {view.coverage && <CoverageView coverage={view.coverage} hunks={hunks} />}
    </>
  )
}

/**
 * Plan ↔ fact of a step (T-57.5), from the code: its PRs against its plan diagrams, the threshold, what its fact
 * diagram shows, and the hunks behind each change. Open by default while a PR is open; computed when open.
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
            {Object.entries(counts).filter(([, n]) => n > 0).map(([s, n]) => `${STATUS_LABEL[s as keyof typeof counts]} ${n}`).join(' · ')}
            {step.fact!.blockers.length > 0 && ' · merge not allowed'}
          </span>
        )}
        <div className="grow" />
        {open && view && (
          <button className="link small" title="Compare with the code again" onClick={() => setNonce(nonce + 1)}>↻</button>
        )}
      </div>
      {open && (
        error ? <p className="muted small">mag could not compare: {error}</p>
        : view === undefined ? <p className="muted small">Comparing with the code…</p>
        : view === null ? <p className="muted small">No PR yet: the fact comes from the code once the step has one.</p>
        : <Body step={step} view={view} />
      )}
    </div>
  )
}
