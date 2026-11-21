// The workspace's folder on disk (~/Documents/mag/<ws>/): deliverables as deliverables/<slug>/v<N>.md, readable with
// plain tools. The folder is the record of a deliverable's text; deleting it deletes the deliverable.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WorkspaceFiles {
  /** Makes <ws>/deliverables/<slug>/, else <slug>-2, -3… when taken; returns the slug it made. */
  createDeliverable(ws: string, slug: string): string
  /** Writes v<N>.md; throws when that version exists. Returns its path. */
  writeVersion(ws: string, slug: string, n: number, md: string): string
  /** Throws when the version is not there. */
  readVersion(ws: string, slug: string, n: number): string
  /** The version numbers on disk, ascending; [] when the folder is gone. */
  versions(ws: string, slug: string): number[]
  /** Whether the deliverable's folder is there. */
  exists(ws: string, slug: string): boolean
  /** The folder of a deliverable, whether it exists or not. */
  dirOf(ws: string, slug: string): string
  versionPath(ws: string, slug: string, n: number): string
  /** Shows the path in Finder. */
  reveal(path: string): void
}

/** A folder name: letters, digits and dashes; anything else (a path) is refused. */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N}-]*$/u
const VERSION = /^v([1-9]\d*)\.md$/

const named = (what: string, v: string) => {
  if (!NAME.test(v)) throw new Error(`Not a ${what} folder name: ${v}`)
  return v
}

const positive = (n: number) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Not a version: ${n}`)
  return n
}

/** `root`: ~/Documents/mag, read on every call. */
export function createWorkspaceFiles(root: () => string, open: (args: string[]) => void = (args) => void execFile('open', args)): WorkspaceFiles {
  const deliverables = (ws: string) => join(root(), named('workspace', ws), 'deliverables')
  const dirOf = (ws: string, slug: string) => join(deliverables(ws), named('deliverable', slug))
  const versionPath = (ws: string, slug: string, n: number) => join(dirOf(ws, slug), `v${positive(n)}.md`)
  return {
    dirOf,
    versionPath,
    createDeliverable(ws, slug) {
      const parent = deliverables(ws)
      named('deliverable', slug)
      mkdirSync(parent, { recursive: true })
      for (let n = 1; ; n++) {
        const taken = n === 1 ? slug : `${slug}-${n}`
        try {
          mkdirSync(join(parent, taken))
          return taken
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        }
      }
    },
    writeVersion(ws, slug, n, md) {
      const dir = dirOf(ws, slug)
      const path = versionPath(ws, slug, n)
      if (!existsSync(dir)) throw new Error(`No deliverable folder ${dir}`)
      if (existsSync(path)) throw new Error(`Version ${n} of ${slug} exists`)
      const tmp = join(dir, `.v${n}.md.tmp`)
      writeFileSync(tmp, md.endsWith('\n') ? md : `${md}\n`)
      renameSync(tmp, path)
      return path
    },
    readVersion(ws, slug, n) {
      const path = versionPath(ws, slug, n)
      if (!existsSync(path)) throw new Error(`No version ${n} of ${slug}: ${path} is not there`)
      return readFileSync(path, 'utf8')
    },
    versions(ws, slug) {
      try {
        return readdirSync(dirOf(ws, slug)).flatMap((f) => {
          const m = VERSION.exec(f)
          return m ? [Number(m[1])] : []
        }).sort((a, b) => a - b)
      } catch {
        return []
      }
    },
    exists: (ws, slug) => existsSync(dirOf(ws, slug)),
    reveal: (path) => open(['-R', path]),
  }
}
