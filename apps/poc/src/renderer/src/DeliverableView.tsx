import { useEffect, useState } from 'react'
import type { Deliverable } from '../../main/core/services/deliverables/types.ts'
import { Markdown } from './Chat'
import { DELIVERABLE_STATE_LABELS, DELIVERABLE_STATE_TONES, lineDiff } from './deliverableText'
import { Icon } from './ui/Icon'
import { Pill } from './ui/Pill'

const mag = window.mag

/** A version's text as read from its file; error: why it can't be (its file or folder was deleted). */
function useVersion(id: string, n: number | null, stamp: number) {
  const [text, setText] = useState<{ n: number; md: string } | { n: number; error: string } | null>(null)
  useEffect(() => {
    if (n === null) return setText(null)
    let live = true
    mag.readDeliverable(id, n).then(
      (md) => live && setText({ n, md }),
      (e: Error) => live && setText({ n, error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }),
    )
    return () => void (live = false)
  }, [id, n, stamp])
  return text
}

/**
 * A deliverable in the topic's drawer (deliverables-library-claims-review-and.1): its versions, the one shown as
 * markdown or as a diff with the one before, Mark final, Show in Finder and Publish (a final one: its topic posts it,
 * the Publish card's Allow marks it published).
 */
export function DeliverableView({ deliverable: d, onClose }: { deliverable: Deliverable; onClose: () => void }) {
  const last = d.versions.at(-1)?.n ?? null
  const [picked, setPicked] = useState<number | null>(null)
  const shown = picked !== null && d.versions.some((v) => v.n === picked) ? picked : last
  const [diff, setDiff] = useState(false)
  const before = shown === null ? null : (d.versions.filter((v) => v.n < shown).at(-1)?.n ?? null)
  const version = useVersion(d.id, shown, d.updatedAt)
  const prior = useVersion(d.id, diff ? before : null, d.updatedAt)
  const [busy, setBusy] = useState<string | null>(null)
  const act = (what: string, run: () => Promise<void>) => {
    setBusy(what)
    run().catch((e: Error) => alert(e.message)).finally(() => setBusy(null))
  }
  const isFinal = shown !== null && d.finalVersion === shown && (d.state === 'final' || d.state === 'published')
  return (
    <aside className="drawer" aria-label={`Deliverable: ${d.title}`}>
      <div className="drawerhead">
        <span className="title" title={d.title}>{d.title}</span>
        <span className="muted small">{d.kind}</span>
        <Pill tone={DELIVERABLE_STATE_TONES[d.state]}>{DELIVERABLE_STATE_LABELS[d.state]}</Pill>
        <button className="iconbtn" title="Close (Esc)" aria-label="Close the drawer" onClick={onClose}><Icon name="x" /></button>
      </div>
      <div className="drawerbody artbody">
        <div className="artline dlvbar">
          <span className="seg" role="tablist" aria-label="Versions">
            {d.versions.map((v) => (
              <button key={v.n} role="tab" aria-selected={v.n === shown} className={v.n === shown ? 'on' : ''} title={`v${v.n} · ${new Date(v.at).toLocaleString()} · by ${v.by}${v.n === d.finalVersion ? ' · marked final' : ''}`} onClick={() => setPicked(v.n)}>
                v{v.n}{v.n === d.finalVersion && <Icon name="check" size={12} />}
              </button>
            ))}
          </span>
          {before !== null && (
            <label className="small"><input type="checkbox" checked={diff} onChange={(e) => setDiff(e.target.checked)} /> Diff with v{before}</label>
          )}
          <div className="grow" />
          {shown !== null && !isFinal && <button className="small" disabled={!!busy} onClick={() => act('final', () => mag.markDeliverableFinal(d.id, shown))}>Mark v{shown} final</button>}
          <button className="small" disabled={!!busy} title="Show its file in Finder" onClick={() => act('reveal', () => mag.revealDeliverable(d.id))}>Show in Finder</button>
          <button
            className="small primary"
            disabled={!!busy || d.state !== 'final' || !d.topicId}
            title={d.state === 'published' ? `Published${d.destination ? ` to ${d.destination.label}` : ''}` : d.state === 'final' ? `Its topic posts v${d.finalVersion}${d.destination ? ` to ${d.destination.label}` : ''}; you allow it on the Publish card` : 'Mark a version final first'}
            onClick={() => act('publish', () => mag.publishDeliverable(d.id))}
          >
            {d.publishing ? 'Publishing…' : 'Publish'}
          </button>
        </div>
        {d.state === 'published' && d.publishedAt && <p className="muted small">Published{d.destination ? ` to ${d.destination.label}` : ''} on {new Date(d.publishedAt).toLocaleString()}.</p>}
        {!version ? (
          <p className="muted small">Loading…</p>
        ) : 'error' in version ? (
          <p className="muted">{version.error}</p>
        ) : diff && prior && 'md' in prior ? (
          <pre className="dlvdiff" aria-label={`Changes from v${prior.n} to v${version.n}`}>
            {lineDiff(prior.md, version.md).map((l, i) => (
              <div key={i} className={l.op}>{l.op === 'add' ? '+ ' : l.op === 'del' ? '- ' : '  '}{l.text}</div>
            ))}
          </pre>
        ) : diff && prior && 'error' in prior ? (
          <p className="muted">{prior.error}</p>
        ) : (
          <Markdown className="md docmd" text={version.md} />
        )}
      </div>
    </aside>
  )
}
