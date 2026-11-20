// A review's archive, the window's side (review-v2-part-2-v1-2.3): the review window rendered static for review.html,
// each diagram drawn in the DOM (elkjs lays it out, the browser measures it) and kept as a self-contained SVG; the
// Export review button, and the banner of a review imported from an archive.
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { isImported, type ReviewPage, type Task } from '@mag/core'
import type { AppState } from '../../preload/api'
import css from './styles.css?inline'
import { DiagramView } from './diagrams/DiagramView'
import type { DiagramCanvas } from './DiffSetView'
import { ago } from './format'
import { ReviewWindow, hunkKey } from './ReviewWindow'
import { reviewWindowModel, type HunkLines } from './reviewWindowModel'
import { appStyles, reviewPage } from './reviewPage'

const mag = window.mag

/** What a static page changes of the app's layout: one long page, scrolled by the browser; diagrams scroll sideways. */
const STATIC_CSS = `
html, body { height: auto; overflow: auto; }
.reviewwindow, .reviewmain, .page { display: block; height: auto; min-height: 0; overflow: visible; }
.reviewmain > * + * { margin-top: 10px; }
.staticdiagram { margin: 8px 0 16px; }
.staticdiagram figcaption { margin-bottom: 4px; }
.staticsvg { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.staticsvg > svg { display: block; }
`

/** Resolves once the diagram in `host` has laid out: nothing changed for `quiet` ms and no "Laying out…" left. */
function settled(host: HTMLElement, quiet = 250, max = 10_000): Promise<void> {
  return new Promise((done) => {
    const deadline = Date.now() + max
    let timer: ReturnType<typeof setTimeout>
    const finish = () => {
      if (host.textContent?.includes('Laying out…') && Date.now() < deadline) return void (timer = setTimeout(finish, quiet))
      obs.disconnect()
      done()
    }
    const obs = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(finish, Date.now() < deadline ? quiet : 0)
    })
    obs.observe(host, { subtree: true, childList: true, attributes: true, characterData: true })
    timer = setTimeout(finish, quiet)
  })
}

/**
 * A diagram drawn off screen as the app draws it, then kept as SVG: its HTML in a foreignObject the size it measured.
 * `inline` goes into the page, which has the styles; `file` carries them itself (diagrams/*.svg opens alone).
 */
async function drawSvg(c: DiagramCanvas, set: DiagramCanvas[]): Promise<{ inline: string; file: string }> {
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1200px;pointer-events:none'
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<DiagramView diagram={c.diagram} siblings={set} />))
    await settled(host)
    const el = host.firstElementChild as HTMLElement | null
    if (!el) throw new Error(`${c.title}: nothing was drawn`)
    const w = Math.max(1, Math.ceil(el.scrollWidth))
    const h = Math.max(1, Math.ceil(el.scrollHeight))
    const body = `<foreignObject x="0" y="0" width="${w}" height="${h}">${new XMLSerializer().serializeToString(el)}</foreignObject>`
    const svg = (style: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${style}${body}</svg>`
    return { inline: svg(''), file: `<?xml version="1.0" encoding="UTF-8"?>\n${svg(`<style><![CDATA[${appStyles(css).replace(/]]>/g, ']]]]><![CDATA[>')}]]></style>`)}` }
  } finally {
    root.unmount()
    host.remove()
  }
}

/**
 * The review window of `taskId` rendered static (review-v2-part-2-v1-2.3): every hunk's lines and every diagram loaded
 * first, then the same page without buttons, drawer or IPC, its CSS inlined and its diagrams as inline SVG; and each
 * diagram as an SVG file of its own. main zips them with the PR.
 */
export async function renderReviewExport(state: AppState, taskId: string): Promise<ReviewPage> {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) throw new Error('The review is gone')
  const canvases = state.canvases.filter((c) => c.projectId === task.projectId)
  const view = await mag.stepFact(taskId).catch(() => null)
  const lines = new Map<string, HunkLines>()
  if (view) {
    await Promise.all(view.files.flatMap((f) => {
      const repo = view.repos.find((r) => r.name === f.repo)
      return f.hunks.map(async (h) => {
        const got = repo ? await mag.stepHunk(taskId, repo.repo, repo.baseSha, repo.headSha, { ...h, path: f.path }).catch((e) => String((e as Error).message ?? e)) : 'Not in the diff'
        lines.set(hunkKey(f, h), got)
      })
    }))
  }
  const model = reviewWindowModel(task, canvases, view)
  const inline: Record<string, string> = {}
  const files: Record<string, string> = {}
  for (const { set } of model.sets) {
    for (const c of set) {
      const svg = await drawSvg(c, set)
      inline[c.id] = svg.inline
      files[c.id] = svg.file
    }
  }
  const body = renderToStaticMarkup(<ReviewWindow state={state} taskId={taskId} still={{ view, lines, svgs: inline }} />)
  const html = reviewPage({ title: `Review · ${task.key} ${task.title}`, css, extra: STATIC_CSS, body })
  return { html, svgs: files }
}

/** This window renders a review's page for its archive when main asks (the button here, or a topic's export_review). */
export function useRenderReviewExport(state: AppState | null) {
  const latest = useRef(state)
  latest.current = state
  useEffect(
    () =>
      mag.onRenderReviewExport((taskId) => {
        if (!latest.current) return Promise.reject(new Error('The window has not loaded yet'))
        return renderReviewExport(latest.current, taskId)
      }),
    [],
  )
}

/** A review imported from an archive: where from and when; it is read only. */
export function ImportedBanner({ work }: { work: Task }) {
  const i = work.imported
  if (!i || !isImported(work)) return null
  return (
    <div className="banner">
      Imported from <b>{i.from}</b>, exported {ago(i.exportedAt, Date.now())}: read only, the PR as it was then (at {i.head.slice(0, 7)}). Nothing here runs, decides or publishes.
    </div>
  )
}
