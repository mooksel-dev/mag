/** A Pill's tone: grey by default; amber = waits on you, green = working / as planned, red = failed, acc = primary, blue = info. */
export type Tone = 'grey' | 'acc' | 'amber' | 'green' | 'red' | 'blue'

export const TONES: readonly Tone[] = ['grey', 'acc', 'amber', 'green', 'red', 'blue']

/** The tone of a verdict or a card (good / warn / bad / neutral) as a Pill's. */
export const VERDICT_TONES = { good: 'green', warn: 'amber', bad: 'red', neutral: 'grey' } as const satisfies Record<string, Tone>
