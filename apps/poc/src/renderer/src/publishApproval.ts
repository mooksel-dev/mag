import { DESTINATION_LABELS, type Destination, type DestinationKind } from '@mag/core'
import { check, preview } from '../../main/core/lib/destinations/index.ts'
import type { IconName } from './ui/icons'
import type { PublishDestination, PublishRule } from './ui/publish'

const ICONS: Record<DestinationKind, IconName> = { slack: 'hash', jira: 'ticket', confluence: 'docs', github: 'pr', gdocs: 'doc', other: 'send' }

/** The Publish card of an approval to `destination`: where it goes, its preview's HTML (unsanitized, null without text) and rules. */
export function publishView(destination: Destination, input: unknown): { dest: PublishDestination; html: string | null; rules: PublishRule[] } {
  const service = DESTINATION_LABELS[destination.kind]
  const name = destination.label.startsWith(`${service} `) ? destination.label.slice(service.length + 1) : destination.label === service ? 'target not named' : destination.label
  const all = check(destination, input)
  return {
    dest: { icon: ICONS[destination.kind], service: destination.kind === 'other' ? undefined : service, name, final: all.some((r) => r.id === 'final') },
    html: preview(destination, input),
    rules: all.filter((r) => r.id !== 'final').map(({ text, met }) => (met === undefined ? { text } : { text, met })),
  }
}
