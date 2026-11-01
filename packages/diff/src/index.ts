// Architecture diff (T-57): a deterministic skeleton of the code over the project's architecture, and what changed
// between two commits. planChanges, compare, coverage and significance come with T-57.3 and T-57.4.
export { ADAPTERS, createDiff, isCode, isTest, type DiffEngine } from './engine.ts'
export { carryIds, sharedPaths, unowned } from './ownership.ts'
export { formatChangeSet } from './format.ts'
export { moduleResolver, vocabularyOf } from './vocabulary.ts'
export { typescript } from './typescript.ts'
export type * from './types.ts'
