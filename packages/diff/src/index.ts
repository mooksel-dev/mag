// Architecture diff (T-57): a deterministic skeleton of the code over the project's architecture, and what changed
// between two commits; a plan diagram against base (T-57.3); plan ↔ fact, coverage and significance (T-57.4).
// Adapters: TypeScript; SQL, Prisma, OpenAPI, proto, GraphQL, Terraform and k8s (T-57.6).
export { ADAPTERS, createDiff, isCode, isTest, type DiffEngine } from './engine.ts'
export { UNOWNED, compare, coverage, describe, formatComparison, mergeBlockers } from './compare.ts'
export { factDiagram } from './fact.ts'
export { LEVELS, SIGNIFICANT, isSignificant, parseSignificance, significance, withLevels, type SignificanceRule } from './significance.ts'
export { carryIds, sharedPaths, unowned } from './ownership.ts'
export { formatPlanWarnings, planChanges, planDrift } from './plan.ts'
export { formatChangeSet } from './format.ts'
export { moduleResolver, planVocabulary, vocabularyOf } from './vocabulary.ts'
export { graphql } from './graphql.ts'
export { manifest } from './manifest.ts'
export { prisma } from './prisma.ts'
export { proto } from './proto.ts'
export { sql } from './sql.ts'
export { terraform } from './terraform.ts'
export { typescript } from './typescript.ts'
export type * from './types.ts'
