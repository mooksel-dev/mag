import { inbox } from '@mag/core'
import type { Store } from './store'
import { createInbox, type Inbox } from './core/services/inbox/index.ts'

/** The workspace inbox over the store: items derived from its tasks and session headers, state kept in its rows. */
export function storeInbox(store: Store): Inbox {
  return createInbox({
    store: {
      states: () => store.data.inboxStates,
      putState: (s) => store.putInboxState(s),
      removeStates: (keys) => store.removeInboxStates(keys),
      added: () => store.data.inboxItems,
      putAdded: (i) => store.putInboxItem(i),
    },
    derived: () => inbox(store.data.tasks, store.sessionHeaders()),
    workspaceOf: (pid) => store.data.projects.find((p) => p.id === pid)?.workspaceId ?? null,
  })
}
