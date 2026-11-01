// Models of the architecture diff (T-57, reworked in T-58). Types only.

/** A repository: where git runs, and the name refs start with. */
export interface Repo {
  path: string
  name: string
}

/** Modules of the project's architecture with the files they own (T-56 F2). */
export interface Vocabulary {
  modules: { id: string; paths: string[] }[]
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

/**
 * What a changed file is, by its path alone, whatever the language. Only code has to be on a fact diagram; the rest is
 * noise to coverage: tests, styles, lock files, generated code, documentation.
 */
export type FileKind = 'code' | 'test' | 'style' | 'lock' | 'generated' | 'docs'

/** A file a PR changes (T-58): its hunks and the module of the vocabulary that owns it. */
export interface FileChange extends FileDiff {
  /** The repository's name. */
  repo: string
  /** Vocabulary module id; null when no module owns the file. */
  module: string | null
  kind: FileKind
}

export type DiffMark = 'add' | 'mod' | 'del' | 'move'

export type Level = 'critical' | 'high' | 'medium' | 'low' | 'noise'

/** One change a Component diagram draws (a plan's or a fact's), over the ids of the vocabulary. */
export interface Change {
  /**
   * module: its id; element (an interface line): `<module>#<name>`; edge (a dependency): `<from> -> <to>`; call:
   * `<from> -> <to>#<name>`.
   */
  key: string
  kind: 'module' | 'element' | 'edge' | 'call'
  diff: DiffMark
  /** The module it is in; for an edge or call, `from`. */
  module: string
  /** element / call: the method, field or type the line names; edge: `to`; module: its name. */
  name: string
  /** The line as drawn; a changed signature is the del line (before) and the add line (after). */
  before?: string
  after?: string
  /** mod of an element: a changed signature (a del and an add line), else the line is marked mod. */
  part?: 'signature' | 'body'
  /** move: the module it moved from. */
  from?: string
  /** A new module: the code it will own. */
  path?: string
  /** The PR's files the line rests on (fact diagrams, T-58 Decision 9). */
  files?: string[]
  /** Set by significance. */
  level?: Level
}

/**
 * A plan change against the fact (T-57.4): match: done as planned; differs: done otherwise (another mark or line);
 * missing: planned, not on the fact; unplanned: on the fact, not on the plan.
 */
export type CompareStatus = 'match' | 'differs' | 'missing' | 'unplanned'

export interface CompareItem {
  status: CompareStatus
  /** The plan's change; none for unplanned. */
  plan?: Change
  /** The fact's change; none for missing. */
  fact?: Change
  /** The higher level of the two. */
  level: Level
  /** differs: how. */
  note?: string
}

export interface Comparison {
  items: CompareItem[]
}

/** Which changed code files of a PR a fact diagram shows (T-58 Decision 2). Files that are not code are left out. */
export interface Coverage {
  shown: FileChange[]
  unshown: FileChange[]
}

/** Why a changed line of a fact cannot be taken on its word: no files, files the PR does not change, of another module. */
export type UnverifiedReason = 'no-files' | 'not-in-pr' | 'other-module'

/** The changes of a fact diagram that rest on its PR's files, and those that do not (T-58 Decision 9). */
export interface Grounding {
  grounded: Change[]
  unverified: { change: Change; reason: UnverifiedReason; files: string[] }[]
}

/**
 * Where a plan diagram disagrees with the vocabulary (T-58 Decision 8): unknown-module: an id the architecture does
 * not have and the diagram does not add; no-path: an added module without the code it will own; exists: an add of a
 * module the architecture has already.
 */
export type PlanWarningCode = 'unknown-module' | 'no-path' | 'exists'

export interface PlanWarning {
  code: PlanWarningCode
  /** The diagram module it is about. */
  module: string
  message: string
}

/** The git operation the diff needs; the app's git client implements it. */
export interface GitSource {
  /** Changed files between two commits with zero-context hunks, renames detected. */
  diffHunks(repo: string, base: string, head: string): Promise<FileDiff[]>
}
