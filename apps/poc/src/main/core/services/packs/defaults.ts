// The packs mag seeds in every workspace (deliverables-library-claims-review-and.3); the user edits them as files.
import type { PackFileName } from '../../clients/workspace-files/index.ts'

export const RULES_HEADER = '# Rules\n\nLearned from the user\'s corrections (propose_rule). One per line; edit or delete freely.\n'

const SOURCES = 'Back every statement a reader would check with a link (PR, ticket, message, meeting time), not pasted raw text; record them with set_claims.'

export const DEFAULT_PACKS: Record<string, Record<PackFileName, string>> = {
  report: {
    prompt: `# Report\n\nA report tells its readers what happened and what it means for them. Lead with the outcome, then the evidence. ${SOURCES} Compare with the previous issue (lastFinal) when there is one.\n`,
    template: '# <Title> · <period>\n\n## Summary\nThree lines at most: the outcome and what needs attention.\n\n## Highlights\n## Risks and blockers\n## Next\n## Sources\n',
    rubric: '# Rubric\n\n- The summary stands alone: a reader who stops there knows the outcome.\n- Every number has its query, every fact its link.\n- Nothing the previous issue raised is silently dropped.\n- No filler; one line over a paragraph.\n',
    rules: RULES_HEADER,
  },
  assessment: {
    prompt: `# Assessment\n\nAn assessment judges a person's work; it is people-sensitive. Read the primary sources yourself (PRs, tickets, messages, transcripts) before you judge, and judge by the rubric. ${SOURCES} Every claim about the person needs a primary source.\n`,
    template: '# <Person> · <period>\n\n## Verdict\nOne paragraph: impact, with the two or three facts that carry it.\n\n## Outcomes\nWhat they delivered: the problem, the result, who adopted it.\n\n## Cost to others\n## Growth areas\n## Sources\n',
    rubric:
      "# Impact rubric\n\nJudge an engineer's impact by outcome and by cost to others, not by process metrics.\n\n" +
      '- Self-merge, big PRs and follow-up fixes are not negatives on their own. They count only when the change had no value, solved no real problem, or put cost on others: review load on another team\'s code, incidents in systems others own, decisions pushed back to owners.\n' +
      '- Score the outcome: a real problem, solved, adopted, durable.\n' +
      '- Score the cost to others.\n' +
      '- Read the ownership context first (their own or greenfield area vs another team\'s repository) before treating self-merge or size as a signal.\n\n' +
      'Why: a solo greenfield R&D project is self-reviewed, large and followed by fixes, and can still unblock several teams; judging it by process metrics is wrong.\n',
    rules: RULES_HEADER,
  },
  proposal: {
    prompt: `# Proposal\n\nA proposal asks its readers for a decision. State the problem with the evidence that it is real, the options with their costs and trade-offs, your recommendation and why the others lose, and the ask. ${SOURCES}\n`,
    template: '# <Title>\n\n## Problem\n## Options\n## Recommendation\n## The ask\nWho decides what, by when.\n\n## Sources\n',
    rubric: '# Rubric\n\n- The problem is shown real, not asserted.\n- Every sensible option is there, each with its cost.\n- The recommendation says why the others lose.\n- The ask is one line a reader can answer.\n',
    rules: RULES_HEADER,
  },
  reply: {
    prompt: '# Reply\n\nA reply answers one message or thread in the user\'s voice. Answer first, then only what the reader needs to act. Match the thread\'s language and tone; link instead of pasting.\n',
    template: '<The answer, one or two lines.>\n\n<What the reader does next, if anything.>\n',
    rubric: '# Rubric\n\n- It answers what was asked, in the first line.\n- Nothing the reader cannot act on.\n- Facts are linked, not pasted.\n',
    rules: RULES_HEADER,
  },
}
