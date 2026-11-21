/** What the Follow up form starts with (routines-scheduled-drafts-and-a.3): a meeting's action items and a default due day. */

export interface ActionItem {
  who: string
  what: string
}

/** The lines under a summary's "## Action items" ("- **who**: what"); "None." and lines without a who are left out. */
export function actionItems(summary: string): ActionItem[] {
  const section = /^## Action items\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(summary)?.[1] ?? ''
  return section.split('\n').flatMap((l) => {
    const m = /^\s*[-*]\s+\*\*(.+?)\*\*\s*:?\s*(.+?)\s*$/.exec(l)
    return m ? [{ who: m[1].replace(/:$/, '').trim(), what: m[2] }] : []
  })
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Tomorrow as YYYY-MM-DD, local. */
export function defaultDue(now: number): string {
  const d = new Date(now)
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}
