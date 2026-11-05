// A review as one .zip (review-v2-part-2-v1-2.3, Decision 8): review.html (the review window, static), review.json,
// pr.diff, pr.json and diagrams/*.svg. Export packs a review of this machine; import opens such a zip on another one
// as a read-only review work, its hunks read from the bundled diff. It knows no Electron, git or store: the app passes
// what it reads and writes through.
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  bundleFileName, bundleOf, externalUrls, importedReview, offline, readBundle, remapCanvasIds,
  type BundleCanvas, type Canvas, type PrDetails, type ReviewBundle, type ReviewPage, type Task,
} from '@mag/core'

/** The bundled diff and the commits it is between. */
export interface PrDiff {
  text: string
  base: string
  head: string
}

export interface ExportDeps {
  /** The review, its doc and the project's canvases; `from`: the project's name. */
  review(taskId: string): { task: Task; doc: string; canvases: Canvas[]; from: string }
  /** The diff of the review's PR at the head its fact is of. */
  prDiff(task: Task): Promise<PrDiff>
  /** The PR as GitHub has it: title, body, files, commits, checks. */
  prDetails(task: Task): Promise<PrDetails>
  /** The review window, static, with its diagrams as SVGs (the project window renders it). */
  render(taskId: string): Promise<ReviewPage>
  /** Whether `path` is a directory: the archive goes into it under its own name. */
  isDir(path: string): boolean
  write(path: string, bytes: Uint8Array): void
}

export interface ImportDeps {
  read(path: string): Uint8Array
  /** A new canvas id. */
  newId(): string
  /** Keeps the bundled diff on this machine; returns where. */
  saveDiff(text: string): string
  /** Creates the review work, done, with its doc and its diagrams (their ids already new). */
  create(projectId: string, review: ReturnType<typeof importedReview>): Task
}

/** The archive's contents, unpacked and checked. */
export interface Unpacked {
  bundle: ReviewBundle
  html: string
  diff: string
  pr: PrDetails
  /** diagrams/<file>.svg → its SVG. */
  svgs: Record<string, string>
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'diagram'

/** A diagram's file in the archive: diagrams/<title>-<id>.svg. */
export const svgName = (c: Pick<BundleCanvas, 'id' | 'title'>) => `diagrams/${slug(c.title)}-${c.id}.svg`

const REQUIRED = ['review.html', 'review.json', 'pr.diff', 'pr.json'] as const

/** The zip of a review: the four files and its diagrams' SVGs; the page with nothing external left in it. */
export function packReview(bundle: ReviewBundle, page: ReviewPage, diff: string, pr: PrDetails): Uint8Array {
  const html = offline(page.html)
  const left = externalUrls(html)
  if (left.length) throw new Error(`review.html still reaches out: ${left[0]}`)
  const files: Record<string, Uint8Array> = {
    'review.html': strToU8(html),
    'review.json': strToU8(JSON.stringify(bundle, null, 2)),
    'pr.diff': strToU8(diff),
    'pr.json': strToU8(JSON.stringify(pr, null, 2)),
  }
  for (const c of bundle.canvases) if (page.svgs[c.id]) files[svgName(c)] = strToU8(offline(page.svgs[c.id]))
  return zipSync(files, { level: 6 })
}

/** A review's archive read back: exactly its four files and diagrams/*.svg, review.json of a version this mag reads. */
export function unpackReview(bytes: Uint8Array): Unpacked {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    throw new Error('Not a review archive: the file is not a .zip')
  }
  const names = Object.keys(entries).filter((n) => !n.endsWith('/'))
  const missing = REQUIRED.filter((n) => !entries[n])
  if (missing.length) throw new Error(`Not a review archive: ${missing.join(', ')} missing`)
  const other = names.filter((n) => !(REQUIRED as readonly string[]).includes(n) && !/^diagrams\/[^/]+\.svg$/.test(n))
  if (other.length) throw new Error(`Not a review archive: unexpected ${other.join(', ')}`)
  const json = (name: string) => {
    try {
      return JSON.parse(strFromU8(entries[name]))
    } catch {
      throw new Error(`Not a review archive: ${name} is not JSON`)
    }
  }
  const pr = json('pr.json')
  if (typeof pr?.url !== 'string') throw new Error('Not a review archive: pr.json has no PR')
  const svgs = Object.fromEntries(names.filter((n) => n.startsWith('diagrams/')).map((n) => [n, strFromU8(entries[n])]))
  return { bundle: readBundle(json('review.json')), html: strFromU8(entries['review.html']), diff: strFromU8(entries['pr.diff']), pr, svgs }
}

/**
 * Exports a review: its PR's diff and details, the review window rendered static with its diagrams, all in one .zip
 * at `dest` (a file, or a directory it goes into as <repo>-<n>-review.zip). Returns the file's path.
 */
export async function exportReview(deps: ExportDeps, taskId: string, dest: string): Promise<string> {
  const { task, doc, canvases, from } = deps.review(taskId)
  if (!task.prReview) throw new Error(`${task.key} is not a review of a PR`)
  const [diff, pr, page] = await Promise.all([deps.prDiff(task), deps.prDetails(task), deps.render(taskId)])
  const bundle = bundleOf(task, doc, canvases, from, { base: diff.base, head: diff.head })
  const file = deps.isDir(dest) ? join(dest, bundleFileName(task.prReview)) : dest
  deps.write(file, packReview(bundle, page, diff.text, pr))
  return file
}

/** Imports a review's archive into a project: a read-only review work, done, its diagrams with new ids. */
export function importReview(deps: ImportDeps, projectId: string, zipPath: string): Task {
  const { bundle, diff, pr } = unpackReview(deps.read(zipPath))
  const ids = Object.fromEntries(bundle.canvases.map((c) => [c.id, deps.newId()]))
  return deps.create(projectId, importedReview(remapCanvasIds(bundle, ids), pr, deps.saveDiff(diff)))
}
