// Follow-ups from windows (routines-scheduled-drafts-and-a.3): added from an Inbox item or a meeting's action item,
// closed by the Done of their Inbox item.
import type { Inbox } from './core/services/inbox/index.ts'
import type { FollowUp, FollowUpInput, Routines } from './core/services/routines/index.ts'
import { followUpOfKey } from './core/services/routines/refs.ts'

/** Adds a follow-up; the Inbox item it was made from (`fromKey`) is Done: the follow-up brings it back when due. */
export function addFollowUp(deps: { routines: Pick<Routines, 'addFollowUp'>; inbox: Pick<Inbox, 'done'> }, input: FollowUpInput & { fromKey?: string }): FollowUp {
  const { fromKey, ...f } = input
  const { followUp } = deps.routines.addFollowUp(f)
  if (fromKey) deps.inbox.done(fromKey)
  return followUp
}

/** The Inbox's Done: a due follow-up's closes it and resolves its item; any other item is hidden until new activity. */
export function doneInboxItem(deps: { routines?: Pick<Routines, 'closeFollowUp'>; inbox: Pick<Inbox, 'done' | 'resolve'> }, key: string) {
  const id = followUpOfKey(key)
  if (id && deps.routines?.closeFollowUp(id)) return deps.inbox.resolve(key)
  deps.inbox.done(key)
}
