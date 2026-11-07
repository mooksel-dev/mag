# Examples

## System view of a change: Finance Hub

The reference for describing an architecture change at the system level.

- `finance-hub-deployment.html`: the hand-drawn canvas an agent made after the component renderer drew every app in one
  row. It answers what the user asked: who calls whom, where each part runs (device, AWS OUs, VPC, outside), and the
  main flows numbered, with a table of steps. AWS account IDs are redacted.
- `finance-hub-architecture.json`: the same view as a `show_diagram` component diagram. `boundaries` become the frames,
  each use's `flow` and `step` number the arrows, and `async` arrows are dashed. `ftm-hub` holds its modules in
  `children`, so clicking it opens the app's level, drawn the same way. `system-view.test.ts` checks that it validates
  without warnings.

What makes it good:
1. One level per view: systems at the top, an app's modules one click down.
2. Boundaries show which infrastructure and accounts a change touches.
3. Numbered flows give the reading order; the step table spells out each call.
4. Diff marks show what is new or changed, with unchanged neighbours as context.
