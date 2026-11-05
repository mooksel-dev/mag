// A review as one archive (review-v2-part-2-v1-2.3, Decision 8): review.json is the review, its doc and its diagrams
// with the inventory, versioned; it travels with review.html (the review window, static), pr.diff, pr.json and the
// diagrams' SVGs. Imported on another machine, it is a read-only review work: no run, publish or direction call, its
// hunks read from the bundled diff.

import type { Canvas, StepFact, Task } from './index.ts'
import { isReview, parsePrUrl, type PrReview } from './pr-review.ts'

/** The PR as GitHub has it when the review is exported: pr.json. */
export interface PrDetails {
  url: string
  number: number
  title: string
  body: string
  author: string
  base: string
  head: string
  files: { path: string; additions: number; deletions: number }[]
  commits: { sha: string; message: string; author: string }[]
  checks: { name: string; bucket: string; link: string | null }[]
}

/** A diagram of the review as review.json carries it: without the machine's project and topic. */
export type BundleCanvas = Omit<Canvas, 'projectId' | 'sessionId' | 'taskId'>

/** The review window rendered static: its page, and each diagram as a self-contained SVG (canvas id → SVG). */
export interface ReviewPage {
  html: string
  svgs: Record<string, string>
}

export const BUNDLE_VERSION = 1

/** review.json. */
export interface ReviewBundle {
  version: typeof BUNDLE_VERSION
  exportedAt: number
  /** The project it was exported from, by name. */
  from: string
  review: {
    key: string
    title: string
    description: string
    prReview: PrReview
    fact: StepFact | null
    doc: string
  }
  /** The commits pr.diff is between. */
  diff: { base: string; head: string }
  canvases: BundleCanvas[]
}

/** An imported review (review-v2-part-2-v1-2.3): where it came from and the PR as it was then. */
export interface ImportedReview {
  /** The project it was exported from. */
  from: string
  /** When it was exported and when imported. */
  exportedAt: number
  at: number
  pr: PrDetails
  /** The commits of the bundled diff. */
  base: string
  head: string
  /** The bundled diff on this machine. */
  diffPath: string
}

/** Whether a review was imported from an archive: read only, its hunks from the bundled diff. */
export const isImported = (task: Pick<Task, 'imported'>): boolean => !!task.imported

/** Throws on an imported review: it has no repository and no agent to run or decide anything. */
export function assertNotImported(task: Pick<Task, 'imported' | 'key'>, what: string) {
  if (isImported(task)) throw new Error(`${task.key} was imported from an archive: it is read only, so it cannot ${what}`)
}

/** The review's diagrams that go into its archive: every diagram of the work. */
export const bundleCanvases = (canvases: Canvas[], taskId: string): Canvas[] => canvases.filter((c) => c.taskId === taskId && c.kind === 'diagram' && !!c.diagram)

/** review.json of a review: the review with both results and the direction call, its doc, its diagrams with the inventory. */
export function bundleOf(task: Task, doc: string, canvases: Canvas[], from: string, diff: { base: string; head: string }, at = Date.now()): ReviewBundle {
  if (!isReview(task) || !task.prReview) throw new Error(`${task.key} is not a review of a PR`)
  return {
    version: BUNDLE_VERSION,
    exportedAt: at,
    from,
    review: { key: task.key, title: task.title, description: task.description, prReview: task.prReview, fact: task.fact ?? null, doc },
    diff,
    canvases: bundleCanvases(canvases, task.id).map(({ projectId: _, sessionId: __, taskId: ___, ...c }) => c),
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** review.json read back: its version and shape checked. Throws on a file that is not one mag can open. */
export function readBundle(json: unknown): ReviewBundle {
  const bad = (why: string): never => {
    throw new Error(`Not a review archive mag can open: ${why}`)
  }
  if (!isObj(json)) return bad('review.json is not an object')
  if (json.version !== BUNDLE_VERSION) return bad(`review.json is version ${String(json.version)}, this mag reads version ${BUNDLE_VERSION}`)
  const r = json.review
  if (!isObj(r) || typeof r.key !== 'string' || typeof r.title !== 'string') return bad('no review in review.json')
  const pr = isObj(r.prReview) ? r.prReview : bad('the review has no PR')
  if (!isObj(pr.pr) || typeof pr.pr.url !== 'string' || typeof pr.pr.number !== 'number') bad('the review has no PR link')
  try {
    parsePrUrl(String((pr.pr as Record<string, unknown>).url))
  } catch {
    bad('the PR link is not a GitHub PR')
  }
  if (!isObj(pr.results)) bad('the review has no results')
  if (!isObj(json.diff) || typeof json.diff.base !== 'string' || typeof json.diff.head !== 'string') bad('no commits of pr.diff')
  if (!Array.isArray(json.canvases)) return bad('no diagrams list')
  for (const c of json.canvases) if (!isObj(c) || typeof c.id !== 'string' || c.kind !== 'diagram' || !isObj(c.diagram) || typeof c.diagram.type !== 'string') bad('a diagram without an id or data')
  return json as unknown as ReviewBundle
}

/**
 * The bundle with every canvas id replaced by its new one, wherever it is named: diagram links, claim views
 * (canvas:<id>#node), findings, the fact's root. Ids are random words, so a whole-word replace hits only them.
 */
export function remapCanvasIds<T>(value: T, ids: Record<string, string>): T {
  const old = Object.keys(ids)
  if (!old.length) return value
  const re = new RegExp(`\\b(${old.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g')
  return JSON.parse(JSON.stringify(value).replace(re, (m) => ids[m]))
}

/**
 * What an import creates from a bundle (canvas ids already new): the review work, done and read only, its PR as a
 * repository outside the project (no checkout here), its fact at the bundled diff's head; and its diagrams.
 */
export function importedReview(b: ReviewBundle, pr: PrDetails, diffPath: string, at = Date.now()): {
  task: { title: string; description: string; prReview: PrReview; fact: StepFact | null; imported: ImportedReview }
  doc: string
  canvases: BundleCanvas[]
} {
  const src = b.review.prReview
  const { owner, repo } = parsePrUrl(src.pr.url)
  const slug = `${owner}/${repo}`.toLowerCase()
  const prReview: PrReview = { ...src, pr: { ...src.pr, repo: slug, outside: true, head: b.diff.head } }
  const fact = b.review.fact ? { ...b.review.fact, heads: { [slug]: b.diff.head } } : null
  return {
    task: {
      title: b.review.title,
      description: b.review.description,
      prReview,
      fact,
      imported: { from: b.from, exportedAt: b.exportedAt, at, pr, base: b.diff.base, head: b.diff.head, diffPath },
    },
    doc: b.review.doc,
    canvases: b.canvases,
  }
}

// Attributes and CSS that load something from elsewhere, or link out: a static page must open offline and alone.
const EXTERNAL = [
  /\s(?:src|href|xlink:href|action|poster|srcset)\s*=\s*(["']?)\s*(?:[a-z][\w+.-]*:)?\/\/[^"'\s>]*\1/gi,
  /url\(\s*(["']?)\s*(?:[a-z][\w+.-]*:)?\/\/[^)]*\)/gi,
  /@import\s+[^;]+;/gi,
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  /<link\b[^>]*>/gi,
  /<(?:iframe|object|embed)\b[^>]*>(?:[\s\S]*?<\/(?:iframe|object|embed)>)?/gi,
]

/** What in a page would reach the network or open another page: the external URLs of its attributes and CSS, scripts. */
export function externalUrls(html: string): string[] {
  return EXTERNAL.flatMap((re) => html.match(re) ?? []).map((m) => m.trim())
}

/** The page with nothing external left: links out lose their target (their text stays), scripts and remote loads go. */
export function offline(html: string): string {
  return EXTERNAL.reduce((h, re) => h.replace(re, ''), html)
}

/** The archive's file name: <repo>-<n>-review.zip. */
export function bundleFileName(review: Pick<PrReview, 'pr'>): string {
  const { repo, number } = parsePrUrl(review.pr.url)
  return `${repo.replace(/[^\w.-]+/g, '_')}-${number}-review.zip`
}
