import { useEffect, useState } from 'react'
import { isReview, prHeads, staleFact, type StepFact, type Task } from '@mag/core'
import type { Change, FileChange } from '@mag/diff/types'
import type { FactView } from '../../preload/api'
import { ComponentView } from './diagrams/Component'
import { STATUS_ICON, fileKey, filesOf, hunksOf, mark, summary, what, type FactItem } from './factView'
import { FACT_TAG, factCard } from './conversationCards'
import { StructuredCard } from './Cards'

const mag = window.mag

const short = (sha: string) => sha.slice(0, 7)

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

/** One change of the fact: mark, what, and the files of its hunks. */
function FactLine({ c, view, hunks }: { c: Change; view: FactView; hunks: Hunks }) {
  return (
    <div className="factline">
      <span className={`d-${c.diff}`}>{mark(c)}</span> {what(c)}
      {filesOf(c, view.files).map((f) => <FileLink key={fileKey(f)} f={f} hunks={hunks} />)}
    </div>
  )
}

/** One deviation in words; the files of its fact and the changes folded under it below. */
function Deviation({ item, view, hunks }: { item: FactItem; view: FactView; hunks: Hunks }) {
  const inner = item.folded ?? []
  return (
    <li>
      <span className={`tag t-${FACT_TAG[item.status].replace(/ /g, '-')}`}>{FACT_TAG[item.status]}</span> {item.phrase}
      {item.note && <div className="muted small">{item.note}</div>}
      {item.fact && filesOf(item.fact, view.files).map((f) => <FileLink key={fileKey(f)} f={f} hunks={hunks} />)}
      {inner.length > 0 && <Folded line={`${inner.length} change${inner.length > 1 ? 's' : ''} in it`} changes={inner} view={view} hunks={hunks} />}
    </li>
  )
}

/** Changes folded under one line: it opens to their names and files. */
function Folded({ line, changes, view, hunks }: { line: string; changes: Change[]; view: FactView; hunks: Hunks }) {
  return (
    <details className="factfolded small">
      <summary>{line}</summary>
      {changes.map((c, i) => <FactLine key={i} c={c} view={view} hunks={hunks} />)}
    </details>
  )
}

/**
 * The fact's inventory against the PR's hunks (diff-iak-inventar-zmin-ai.1): the blocks of changed code in no unit and
 * the units their hunks do not bear out first, as they block merge; then the warnings the reviewer answers.
 */
export function InventoryView({ view, hunks }: { view: FactView; hunks: Hunks }) {
  const [rest, setRest] = useState(false)
  const check = view.check
  const other = view.files.filter((f) => f.kind !== 'code')
  const fileOf = (repo: string, path: string) => view.files.find((f) => f.repo === repo && f.path === path)
  const ungrounded = check ? [...check.unknown.map((u) => `${u.by} cites ${u.id}, no hunk of the PRs`), ...check.ungrounded.map((u) => `${u.unit} ${u.name}: ${u.why}`), ...check.otherModule.map((u) => `${u.unit} ${u.name}: on ${u.module}, its hunks of ${u.hunkModules.join(', ') || 'no module'}`)] : []
  const code = view.files.some((f) => f.kind === 'code')
  const set = view.set.length > 1 ? ` and ${view.set.length - 1} more diagram${view.set.length > 2 ? 's' : ''} of its set` : ''
  const what = view.inventory
    ? `${view.inventory.units} units over ${check?.codeBlocks ?? 0} blocks of changed code; ${view.fact ? `${view.fact.title} (v${view.fact.version})${set} generated from it` : ''}`
    : !code ? 'the PRs change no code' : view.set.length ? 'no inventory: the fact set was drawn before inventories; restart the review' : 'no inventory yet: the review writes it'
  return (
    <div className="factcoverage">
      <div className="diffsub">
        Inventory <span className="muted small">· {what}</span>
      </div>
      {!!view.inventory?.summary.length && <ul className="small">{view.inventory.summary.map((b, i) => <li key={i}>{b}</li>)}</ul>}
      <div className="chips">
        {check && <span className={`diffchip${check.unaccounted.length ? ' s-missing' : ''}`} title="Blocks of changed code in no unit and not in noise">in no unit {check.unaccounted.length}</span>}
        {check && <span className={`diffchip${ungrounded.length ? ' s-missing' : ''}`} title="Units their hunks do not bear out (the name is not there, the module owns none, the id is no hunk, a call to no module) or that break a rule (several names, a changed method without before, after and note)">ungrounded {ungrounded.length}</span>}
        {!!check?.noiseClaims.length && <span className="diffchip" title="Code blocks called noise that change real lines: a warning">code called noise {check.noiseClaims.length}</span>}
        {!!check?.undeclared.length && <span className="diffchip" title="Declarations in changed lines no unit of their module names: a hint">unnamed declarations {check.undeclared.length}</span>}
        {view.warnings.length > 0 && <span className="diffchip s-missing" title={view.warnings.join('\n')}>set warnings {view.warnings.length}</span>}
        {view.outside && <span className="diffchip" title="The repository is outside the project: its modules are its folders">without the project architecture</span>}
        {other.length > 0 && (
          <button className="diffchip link" onClick={() => setRest(!rest)}>
            {rest ? '▾' : '▸'} not code {other.length}
          </button>
        )}
      </div>
      {(!!check?.unaccounted.length || rest) && (
        <table className="facttable">
          <tbody>
            {check?.unaccounted.map((b) => {
              const f = fileOf(b.repo, b.path)
              return (
                <tr key={b.id}>
                  <td className="factstatus s-missing">✗</td>
                  <td className="muted small">{b.id}</td>
                  <td className="muted small">{b.module ?? 'no module'}</td>
                  <td>{f ? <FileLink f={f} hunks={hunks} /> : `${b.repo}:${b.path}`}</td>
                </tr>
              )
            })}
            {rest && other.map((f) => (
              <tr key={fileKey(f)}>
                <td />
                <td />
                <td className="muted small">{f.kind}</td>
                <td><FileLink f={f} hunks={hunks} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {ungrounded.length > 0 && <ul className="small s-missing">{ungrounded.map((u, i) => <li key={i}>{u}</li>)}</ul>}
      {!!check?.noiseClaims.length && (
        <details className="small">
          <summary>Code blocks called noise</summary>
          <ul className="muted">{check.noiseClaims.map((n) => <li key={n.block}>{n.block}: {n.lines} line(s), “{n.reason}”</li>)}</ul>
        </details>
      )}
      {!!check?.undeclared.length && (
        <details className="small">
          <summary>Declarations no unit names</summary>
          <ul className="muted">{check.undeclared.map((d, i) => <li key={i}>{d.block} <code>{d.name}</code>: <code>{d.line}</code></li>)}</ul>
        </details>
      )}
      {view.warnings.length > 0 && <ul className="muted small">{view.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
    </div>
  )
}

function Body({ step, view, merged }: { step: Task; view: FactView; merged: boolean }) {
  const hunks = useHunks(step.id, view)
  // A review of a teammate's PR has no plan to compare and no merge of ours to allow: only the fact against its diff
  // (reviews-prybraty-spysok-pr-i.1).
  const review = isReview(step)
  // The threshold as a card (redesign-start-screen-big-composer.4): a verdict chip and tagged rows, no raw blocker text.
  const card = factCard({ key: step.key, title: step.title, review }, view, merged)
  return (
    <>
      <div className="muted small">
        {view.repos.map((x) => `${x.name} ${short(x.baseSha)}..${short(x.headSha)}`).join(' · ')}
        {review ? '' : view.plans.length ? ` · plan: ${view.plans.map((p) => `${p.title} v${p.version}`).join(', ')}` : ' · no plan diagram: nothing it changes is planned'}
      </div>
      <StructuredCard card={card} />
      {!review && <Comparison view={view} hunks={hunks} foldDeviations />}
      <InventoryView view={view} hunks={hunks} />
    </>
  )
}

/**
 * Plan ↔ fact of a step at plan level (plan-fact-porivniannia-na-rivni.1): its plan Component diagram painted with the
 * comparison, the deviations in words, then what folds: additions per module, changes outside the plan, the matches.
 */
export function Comparison({ view, hunks, foldDeviations }: {
  view: FactView
  hunks: Hunks
  /** The card above already says them: the list with their files folds. */
  foldDeviations?: boolean
}) {
  const deviations = view.items.filter((i) => i.status !== 'match')
  const matches = view.items.filter((i) => i.status === 'match')
  const plan = view.planDiagram
  return (
    <>
      {plan && (
        <div className="factplan">
          <div className="muted small">{plan.title} (v{plan.version}) against the fact</div>
          <ComponentView key={plan.id} modules={plan.diagram.modules} diff summary={plan.diagram.summary} overlay={plan.overlay} />
        </div>
      )}
      {deviations.length > 0 && foldDeviations ? (
        <details className="factfolded small">
          <summary>{deviations.length} deviation{deviations.length > 1 ? 's' : ''} with their files</summary>
          <ul className="factdeviations">{deviations.map((i, n) => <Deviation key={n} item={i} view={view} hunks={hunks} />)}</ul>
        </details>
      ) : deviations.length > 0 ? (
        <ul className="factdeviations">{deviations.map((i, n) => <Deviation key={n} item={i} view={view} hunks={hunks} />)}</ul>
      ) : foldDeviations ? null : (
        <p className="small">{view.items.length || view.additions.length ? 'No deviations from the plan.' : 'Neither the plan nor the fact diagram draws a change.'}</p>
      )}
      {view.additions.map((a) => <Folded key={a.module} line={a.line} changes={a.changes} view={view} hunks={hunks} />)}
      {view.outsidePlan.modules.length > 0 && (
        <details className="factfolded small">
          <summary>{view.outsidePlan.line}</summary>
          {view.outsidePlan.modules.map((a) => (
            <div key={a.module}>
              <b>{a.module}</b>
              {a.changes.map((c, i) => <FactLine key={i} c={c} view={view} hunks={hunks} />)}
            </div>
          ))}
        </details>
      )}
      {matches.length > 0 && (
        <details className="factfolded small">
          <summary>{STATUS_ICON.match} {matches.length} as planned</summary>
          {matches.map((i, n) => (
            <div key={n} className="factline">
              <span className={`d-${i.plan!.diff}`}>{mark(i.plan!)}</span> {what(i.plan!)}
              {i.note && <div className="muted small">{i.note}</div>}
            </div>
          ))}
        </details>
      )}
    </>
  )
}

/** A review's recorded fact in one line: what its inventory leaves out, else that it covers the PR. */
const reviewSummary = (f: StepFact) =>
  [f.counts.unaccounted && `in no unit ${f.counts.unaccounted}`, f.counts.ungrounded && `ungrounded ${f.counts.ungrounded}`].filter(Boolean).join(' · ') ||
  (f.blockers.length ? 'the fact does not cover the PR yet' : 'the fact covers the PR')

/**
 * Plan ↔ fact of a step (T-57.5, T-58): its fact, generated from the reviewer's inventory, against its plan diagrams;
 * the threshold from its deviations; the inventory against the hunks (diff-iak-inventar-zmin-ai.1); the diff behind each file. Open by default while a PR is open; computed when open. A review of a teammate's PR (`step` is
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
  // A merged step keeps its fact folded to one line; one recorded by an older compare is recorded again in main.
  const merged = !review && !live && !!step.work?.repos.some((r) => r.prState === 'merged')
  useEffect(() => {
    if (!open && !review && staleFact(step.fact)) mag.stepFact(step.id).catch(() => {})
  }, [open, review, step.id, step.fact?.at])
  return (
    <div className="factpanel">
      <div className="factbar">
        <button className="link diffsub" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} {review ? 'Fact' : 'Plan ↔ fact'}
        </button>
        {!open && step.fact && <span className="muted small">{review ? reviewSummary(step.fact) : summary(step.fact, merged)}</span>}
        <div className="grow" />
        {open && view && (
          <button className="link small" title="Check the fact again" onClick={() => setNonce(nonce + 1)}>↻</button>
        )}
      </div>
      {open && (
        error ? <p className="muted small">mag could not compare: {error}</p>
        : view === undefined ? <p className="muted small">Comparing…</p>
        : view === null ? <p className="muted small">{review ? 'No PR to compare.' : 'No PR yet: the fact is drawn in the review once the step has one.'}</p>
        : <Body step={step} view={view} merged={merged} />
      )}
    </div>
  )
}
