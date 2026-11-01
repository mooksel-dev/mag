// Models of the architecture diff (T-57). Types only.

/** A repository: where git runs, and the name refs start with. */
export interface Repo {
  path: string
  name: string
}

/** Modules of the project's architecture with the files they own (T-56 F2). */
export interface Vocabulary {
  modules: { id: string; paths: string[] }[]
}

export type ElementKind = 'symbol' | 'entity' | 'field' | 'contract' | 'infra'

/** What a language calls the element: function, class, interface, method, tool… */
export type Decl = string

/** One deterministic element of a skeleton. */
export interface Element {
  /** `<repo>:<path>#<symbol>[.<member>]` */
  ref: string
  path: string
  /** `<symbol>[.<member>]` */
  name: string
  /** Vocabulary module id; null when no module owns the file. */
  module: string | null
  kind: ElementKind
  decl: Decl
  exported: boolean
  /** One line, as written: the part callers depend on. */
  signature: string
  /** Of the whole element as written; equal for a moved element. */
  bodyHash: string
  /** 1-based inclusive line ranges the element spans. */
  lines: [number, number][]
}

/** An import of a file, resolved to a file of the repo or to an outside package. */
export interface FileImport {
  path: string
  spec: string
  line: number
  /** A repo path, `ext:<package>` for an outside one, null when it does not resolve. */
  target: string | null
}

/** A module depending on another (or on an outside package, `ext:<package>`). */
export interface ModuleEdge {
  from: string
  to: string
  /** The files of `from` that import `to`. */
  files: string[]
}

export interface Skeleton {
  repo: string
  sha: string
  elements: Element[]
  imports: FileImport[]
  edges: ModuleEdge[]
  /** Source files no adapter reads: their elements are unknown. */
  unparsed: string[]
}

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

export interface FileDiff {
  /** Path at head; for a deleted file, at base. */
  path: string
  /** Path at base when renamed. */
  oldPath?: string
  status: 'add' | 'mod' | 'del' | 'rename'
  hunks: Hunk[]
}

export interface HunkRef extends Hunk {
  path: string
}

export type DiffMark = 'add' | 'mod' | 'del' | 'move'

export type Level = 'critical' | 'high' | 'medium' | 'low' | 'noise'

/** One change over the vocabulary. */
export interface Change {
  /**
   * element: its ref (at head; at base when deleted), or `<module>#<method>` for a planned one base does not have;
   * edge: `from -> to`; file: `<repo>:<path>`; module (plans only): its id.
   */
  key: string
  kind: 'element' | 'edge' | 'file' | 'module'
  diff: DiffMark
  /** The element's or file's module; for an edge, `from`. */
  module: string | null
  path?: string
  /** element: its first line (at base when deleted). */
  line?: number
  /** element: `<symbol>[.<member>]`; edge: `to`. */
  name?: string
  elementKind?: ElementKind
  decl?: Decl
  exported?: boolean
  /** Signatures; for an edge or file, absent. */
  before?: string
  after?: string
  /** mod: what changed. */
  part?: 'signature' | 'body'
  /** move: the old ref (element) or old path (file). */
  from?: string
  /** Test files only: they change no architecture by themselves. */
  test?: boolean
  hunks: HunkRef[]
  /** Set by significance (T-57.4). */
  level?: Level
}

export interface ChangeSet {
  repo: string
  baseSha: string
  headSha: string
  changes: Change[]
  /** false when a changed source file has no adapter: coverage is not guaranteed. */
  deterministic: boolean
  /** Changed source files no adapter reads. */
  unparsed: string[]
}

/**
 * Where a plan diagram disagrees with the code at base (T-57.3). unknown-module: an id the architecture does not have
 * and the diagram does not add; no-path: an added module without the code it will own; not-in-base: an unchanged,
 * changed or removed method, call or dependency that base does not have; exists: an add of what base has already.
 */
export type PlanWarningCode = 'unknown-module' | 'no-path' | 'not-in-base' | 'exists'

export interface PlanWarning {
  code: PlanWarningCode
  /** The diagram module it is about. */
  module: string
  /** The interface line, `-> <to>` for a dependency, or `-> <to>#<method>` for a call; none for the module itself. */
  item?: string
  message: string
}

/** A plan diagram over the code at base: the changes it plans and where it disagrees with base. */
export interface PlanCheck {
  /** The skeletons it was checked against. */
  base: { repo: string; sha: string }[]
  changes: Change[]
  warnings: PlanWarning[]
}

/**
 * A plan change against the fact of a PR (T-57.4). match: done as planned; differs: done otherwise (another mark, a
 * planned signature change that only touched the body); missing: planned, not in the code; unplanned: in the code, not
 * on the plan; unchecked: planned where the code cannot tell (a module without code, a changed call).
 */
export type CompareStatus = 'match' | 'differs' | 'missing' | 'unplanned' | 'unchecked'

export interface CompareItem {
  status: CompareStatus
  /** The plan's change; none for unplanned. */
  plan?: Change
  /** The fact's changes it stands for; [] for missing and unchecked. */
  fact: Change[]
  /** The highest level among its changes. */
  level: Level
  /** differs: how. */
  note?: string
}

export interface Comparison {
  items: CompareItem[]
}

/** What of a PR's fact a diagram shows (T-57.4). Test changes are left out. */
export interface Coverage {
  shown: Change[]
  unshown: Change[]
}

/** Language adapter: elements and imports of one file, whatever its module. */
export interface LangAdapter {
  lang: string
  matches(path: string): boolean
  elements(path: string, src: string): ParsedElement[]
  imports(path: string, src: string): { spec: string; line: number }[]
}

/** An element as an adapter sees it, before it gets a repo, path and module. */
export type ParsedElement = Omit<Element, 'ref' | 'path' | 'module'>

/** The git operations the diff needs; the app's git client implements them. */
export interface GitSource {
  /** Every file at `sha`: path and blob sha. */
  treeAt(repo: string, sha: string): Promise<{ path: string; blob: string }[]>
  /** Contents of blobs by sha. */
  blobs(repo: string, shas: string[]): Promise<Map<string, string>>
  /** Changed files between two commits with zero-context hunks, renames detected. */
  diffHunks(repo: string, base: string, head: string): Promise<FileDiff[]>
}
