// The files a PR changes (T-58): by path alone, whatever the language, each with the module that owns it.
import { moduleResolver } from './vocabulary.ts'
import type { FileChange, FileKind, GitSource, Repo, Vocabulary } from './types.ts'

// Mocks, fakes and test harnesses are tests too (povnyi-diff-nabir-pov-iazanykh.3, Decision 12): never on a diagram.
const TEST =
  /(^|\/)(__tests__|__mocks__|__snapshots__|tests?|spec|testdata|testutils?|fixtures|mocks?|fakes|[^/]*Tests)\/|\.(test|spec|stories|mock)\.[^./]+$|(^|\/)test_[^/]+\.py$|_(test|mock)\.(go|py)$|(^|\/)mocks?(_[^/]*)?\.go$|(^|\/)(Mock|Fake)[A-Z][^/]*\.swift$|\.snap$/
const STYLE = /\.(css|scss|sass|less|styl|pcss)$/i
const LOCK = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|Package\.resolved|Podfile\.lock|\.terraform\.lock\.hcl)$/
const GENERATED = /(^|\/)(dist|build|out|generated|__generated__)\/|\.(min\.(js|css)|generated\.[^./]+|pb\.go|map)$|_pb2(_grpc)?\.pyi?$|\.g\.dart$/
const DOCS = /\.(md|mdx|markdown|txt|rst|adoc|png|jpe?g|gif|svg|ico|webp|pdf)$|(^|\/)(docs?)\/|(^|\/)(LICENSE|CHANGELOG|NOTICE|AUTHORS)[^/]*$/i

/** What a file is by its path: code unless it is a test, a style, a lock file, generated or documentation. */
export function fileKind(path: string): FileKind {
  if (LOCK.test(path)) return 'lock'
  if (GENERATED.test(path)) return 'generated'
  if (TEST.test(path)) return 'test'
  if (STYLE.test(path)) return 'style'
  if (DOCS.test(path)) return 'docs'
  return 'code'
}

export const isCode = (path: string) => fileKind(path) === 'code'
export const isTest = (path: string) => fileKind(path) === 'test'

const repoOf = (repo: string | Repo): Repo => (typeof repo === 'string' ? { path: repo, name: repo.split('/').filter(Boolean).at(-1) ?? repo } : repo)

export function createDiff(git: GitSource) {
  /** The files changed between two commits, renames detected, each with its hunks, owner module and kind. */
  async function changedFiles(repoArg: string | Repo, baseSha: string, headSha: string, vocabulary: Vocabulary): Promise<FileChange[]> {
    const repo = repoOf(repoArg)
    const moduleOf = moduleResolver(vocabulary)
    const diffs = await git.diffHunks(repo.path, baseSha, headSha)
    return diffs.map((d) => ({ ...d, repo: repo.name, module: moduleOf(d.path), kind: fileKind(d.path) }))
  }
  return { changedFiles }
}

export type DiffEngine = ReturnType<typeof createDiff>
