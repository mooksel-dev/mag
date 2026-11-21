// Tools the MCP server exposes to agents. Schemas only; handlers live in tools.ts.
// scope: 'task' = runs bound to a task (groomer, developer, reviewer), 'project' = project chat and architect, 'any' = both.
// reviewer: it sees only tools marked 'only' (its own) or 'also' for it; the other roles all but 'only'.
// OWNER_TOOLS: a project chat plans the works it owns with them too, passing work (see toolsFor).

import { CANVAS_CLASSES, EMBED_TAG, type AgentRole } from '@mag/core'

/** One module of set_architecture. `children` items are described in words, not by $ref: not every agent follows it. */
const ARCH_MODULE = {
  type: 'object',
  required: ['id', 'name', 'description', 'uses'],
  properties: {
    id: { type: 'string', description: 'kebab-case, unique in the whole tree, stable across runs: the previous id from get_architecture for a module that still exists' },
    name: { type: 'string' },
    kind: { type: 'string', description: 'Top level: Electron app, React web, HTTP API, worker, database, 3rd-party API, CLI…' },
    level: { type: 'string', enum: ['system', 'module'], description: 'system: an app, an outside runtime or a 3rd-party service (the top level); module: a part of one. Default by depth.' },
    layer: { type: 'string', enum: ['app', 'service', 'client', 'lib'], description: 'Modules inside an app.' },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'The code it owns: folders, files or globs relative to the repository, e.g. "apps/web", "src/billing/*.ts". A file belongs to the most specific match, so an app gives its folder and its inner modules their parts of it. Every code file must be in exactly one module; never give one path to two modules. None for outside runtimes.',
    },
    description: { type: 'string', description: 'One or two sentences of responsibility.' },
    interface: {
      type: 'array',
      items: { type: 'string' },
      description: 'Public methods, one per line: "name(args): Result - what it does". Never several in one line ("get / set", "a, b") and no prose. Key for services and clients.',
    },
    uses: {
      type: 'array',
      description: 'Real dependencies on any module of the tree.',
      items: {
        type: 'object',
        required: ['to', 'calls'],
        properties: {
          to: { type: 'string', description: 'Id of the module it uses.' },
          calls: { type: 'array', items: { type: 'string' }, description: 'Methods of `to` it calls, one per item, e.g. "groom(taskId)".' },
        },
      },
    },
    concern: { type: 'string', description: 'One line if it breaks the layering or smells.' },
    children: { type: 'array', items: { type: 'object', description: 'An inner module with the same fields, children included.' }, description: 'Inner modules of a big module.' },
  },
}

/** The agents a project chat writes to (message_agent). */
export const MESSAGED_ROLES = ['developer', 'reviewer', 'groomer'] as const
export type MessagedRole = (typeof MESSAGED_ROLES)[number]

/** The control tools of a project chat act only on the user's word, as cancel_task does. */
/** What a tool that reads a topic or work takes (workspaces-and-labels-project-as.3). */
const REF_ARG = 'A ref from list_chats (topic:<id>, work:<key>; another workspace\'s prefixed, e.g. aura:work:ABC-12), a topic id, a work\'s, review\'s or step\'s key (e.g. ABC-12, ABC-12.3) or a task id. A bare id or key is looked for in this project, then this workspace, then everywhere.'

const ASKED = 'Only when the user has asked for exactly this in this conversation ("approve", "start it", "tell the developer…"); never on your own. Then say in one line what you did, not "press the button".'

const STEP_REPOS = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Project repositories the step changes: names (folder names) or paths from get_task project.repos; [] for a step without code. Only they get a worktree; leave it out and the step gets every repository.',
}

const DIFF = { type: 'string', enum: ['add', 'mod', 'del'], description: 'Change: add, mod or del. Leave it out for unchanged context.' }
const DATA_DIFF = {
  type: 'string',
  enum: ['add', 'mod', 'del', 'move'],
  description: 'Change: add, mod, del, or move (it moved here; from says where from). Leave it out for unchanged context.',
}
const ONE_PER_LINE = 'One per line, never several joined by "/", "," or "+"; a plain string is an unchanged line; a changed one is the old line del and the new line add.'
/** On a fact diagram (T-58): the PR's files a changed element rests on. */
const FILES = { type: 'array', items: { type: 'string' }, description: "Fact diagrams only: the PR's files (repo-relative paths as get_pr_changes lists them; <repo>:<path> when several repos change that path) this change rests on, of this module. Required on every changed line, use and call of a fact: only files given here count as shown." }
/** Explicit links to other diagrams of the set (povnyi-diff-nabir-pov-iazanykh.1, Decision 2). */
const LINKS = {
  type: 'array',
  description:
    'Links to other diagrams of the same set (an option, a step\'s plan or fact): detail = its inner modules, data = the tables or types it owns, scenario = a sequence it takes part in, logic = the flowchart of a method. Every diagram of a set is reached from its root through links.',
  items: {
    type: 'object',
    required: ['to', 'kind'],
    properties: {
      to: { type: 'string', description: 'The id of a diagram of the same set.' },
      node: { type: 'string', description: 'A node of that diagram to open at: a module, entity, participant, state or flowchart node id.' },
      kind: { type: 'string', enum: ['detail', 'data', 'scenario', 'logic'] },
    },
  },
}
const LINES = (what: string) => ({
  type: 'array',
  description: `${what}. ${ONE_PER_LINE}`,
  items: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, diff: DIFF, files: FILES } },
})
const INTERFACE = {
  type: 'array',
  description: `Public methods with signatures "name(args): Result - what it does", not prose. ${ONE_PER_LINE} A method moved here from another module is move with from.`,
  items: {
    type: 'object',
    required: ['text'],
    properties: {
      text: { type: 'string' },
      diff: { ...DATA_DIFF, description: 'Change: add, mod, del, or move (it moved here; from says from which module). Leave it out for unchanged context.' },
      from: { type: 'string', description: 'With move: the id of the module it moved from, another module of this diagram; a renamed method (here or on the way) is "<module>#<old name>", one line, not a del and an add.' },
      files: FILES,
      links: LINKS,
    },
  },
}

/** Where a diagram stands in its task (T-55.3): show_diagram and place_diagram. */
const PLACEMENT = {
  role: {
    type: 'string',
    enum: ['option', 'plan', 'review', 'none'],
    description: "option: sketches an option of §Options; plan: the planned change of one step; review: an essential diagram of a review of a teammate's PR, shown on its page above the issues; none: unplaced. Omitted on a revision: the diagram keeps its place.",
  },
  option: { type: 'string', description: 'role option: the option\'s name as in §Options, e.g. "A".' },
  step: { type: 'string', description: 'role plan: the key of the step, e.g. ABC-12.2.' },
  repo: { type: 'string', description: 'role plan: the repository it changes (name or path); omit when the diagram spans the step.' },
} as const

/** The data of show_diagram; one shape per type, fields of the other types are left out. */
const DIAGRAM = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['component', 'sequence', 'state', 'flowchart', 'data'] },
    summary: {
      type: 'string',
      description: 'component, required: one or two sentences on what changes in substance; shown above the diagram. flowchart with of: what changes in the logic of the method, short.',
    },
    of: {
      type: 'string',
      description: 'flowchart: "<moduleId>#<method>", the method of a module on this task\'s component diagram whose logic the flow shows (method name without arguments); opens from that method. One flowchart per method; revise it by id.',
    },
    replaces: { type: 'string', description: 'flowchart: "<moduleId>#<method>" for a new method, the one it replaces (usually removed, with a flow of its own).' },
    changes: { type: 'array', items: { type: 'string' }, description: 'flowchart with of: the changes of the logic, one per item.' },
    modules: {
      type: 'array',
      description: 'component: modules as in get_architecture (same ids), with diff marks.',
      items: {
        type: 'object',
        required: ['id', 'name', 'uses'],
        properties: {
          id: { type: 'string', description: 'Unique in the whole diagram; the id from get_architecture for an existing module.' },
          name: { type: 'string' },
          kind: { type: 'string' },
          layer: { type: 'string', enum: ['app', 'service', 'client', 'lib'] },
          path: { type: 'string' },
          description: { type: 'string' },
          diff: DIFF,
          interface: INTERFACE,
          uses: {
            type: 'array',
            items: {
              type: 'object',
              required: ['to', 'calls'],
              properties: {
                to: { type: 'string' },
                calls: LINES('Methods of `to` it calls'),
                diff: DIFF,
                files: FILES,
                links: LINKS,
                flow: { type: 'string', description: 'The id of a flow (flows) this use is a step of.' },
                step: { type: 'string', description: 'With flow: its label in the flow, in order ("1", "2", "A"); drawn on the arrow and listed under the diagram.' },
                async: { type: 'boolean', description: 'Fire and forget: an event, a queue, a webhook; drawn dashed.' },
              },
            },
          },
          links: LINKS,
          boundary: { type: 'string', description: 'The id of the boundary (boundaries) it runs in: a cloud account, a VPC, a runtime, a SaaS, the device.' },
          children: { type: 'array', items: { type: 'object', description: 'An inner module with the same fields.' }, description: 'Inner modules: the user clicks the module to see its level, drawn the same way.' },
        },
      },
    },
    boundaries: {
      type: 'array',
      description:
        'component: where modules run, drawn as nested frames around them: AWS accounts or OUs, VPCs, clusters, runtimes, runners, a SaaS, the user\'s device. Take them from the project\'s architecture with its names, never ours / not ours or a team; none without an architecture. Give them on the system level, so the user sees which infra and accounts a change touches.',
      items: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string', description: 'e.g. "AWS · Identity OU".' },
          kind: { type: 'string', description: 'AWS account, VPC, runner, SaaS, device…; app: a deployable app drawn expanded on the system level, its changed modules inside it with layers.' },
          note: { type: 'string', description: 'One line: environments, owner, where it is defined (e.g. its Terraform repo).' },
          parent: { type: 'string', description: 'The id of the boundary it sits in.' },
          diff: DIFF,
        },
      },
    },
    flows: {
      type: 'array',
      description: 'component: the main scenarios across modules (a request path, an ingest path, alerts), each numbered by the uses that carry its flow and step; listed under the level as tables. A detailed scenario goes on a sequence diagram.',
      items: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' }, note: { type: 'string' }, diff: DIFF } },
    },
    participants: {
      type: 'array',
      description: 'sequence: lifelines, left to right.',
      items: { type: 'object', required: ['id', 'label'], properties: { id: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string', description: 'service, database, queue, 3rd-party API, CLI…' }, diff: DIFF } },
    },
    messages: {
      type: 'array',
      description: 'sequence: in order. call opens an activation on `to`, reply (from the callee back) closes it, async is fire and forget.',
      items: {
        type: 'object',
        required: ['from', 'to', 'text', 'kind'],
        properties: { from: { type: 'string' }, to: { type: 'string' }, text: { type: 'string' }, kind: { type: 'string', enum: ['call', 'reply', 'async'] }, diff: DIFF },
      },
    },
    entity: { type: 'string', description: 'state: whose states, e.g. "Task status".' },
    states: {
      type: 'array',
      items: { type: 'object', required: ['id', 'label'], properties: { id: { type: 'string' }, label: { type: 'string' }, initial: { type: 'boolean' }, final: { type: 'boolean' }, diff: DIFF } },
    },
    transitions: {
      type: 'array',
      items: { type: 'object', required: ['from', 'to', 'event'], properties: { from: { type: 'string' }, to: { type: 'string' }, event: { type: 'string' }, guard: { type: 'string' }, diff: DIFF } },
    },
    nodes: {
      type: 'array',
      description: 'flowchart: steps.',
      items: {
        type: 'object',
        required: ['id', 'label', 'shape'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          shape: { type: 'string', enum: ['start', 'step', 'decision', 'end'] },
          diff: DIFF,
          links: { ...LINKS, description: 'A step that calls another method: kind logic to the flowchart of that method (private methods have no interface line, so their flowchart is reached from here).' },
        },
      },
    },
    edges: {
      type: 'array',
      description: 'flowchart: arrows; label the branches of a decision.',
      items: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' }, diff: DIFF } },
    },
    entities: {
      type: 'array',
      description:
        'data: stored data only (collections, tables, the documents they embed) with their fields, indexes and unique keys, each in the module that owns it; unchanged neighbours without a mark give context. Never the arguments of a call, interfaces, clients or mocks: those go in the signature of an interface line on the component diagram.',
      items: {
        type: 'object',
        required: ['id', 'name', 'fields'],
        properties: {
          id: { type: 'string', description: 'Unique in the diagram, e.g. the collection name.' },
          name: { type: 'string' },
          kind: { type: 'string', enum: ['collection', 'table', 'struct', 'type'], description: 'Default collection.' },
          note: { type: 'string' },
          diff: DATA_DIFF,
          from: { type: 'string', description: 'With move: the old id of a renamed or moved entity.' },
          module: { type: 'string', description: 'The module that owns it (an id of get_architecture), or the id of the outside system whose data it is (e.g. phalcon); entities are drawn by module.' },
          indexes: {
            type: 'array',
            description: 'Its indexes and unique keys, changed ones marked, the unique key an upsert relies on included.',
            items: { type: 'object', required: ['fields'], properties: { fields: { type: 'array', items: { type: 'string' }, description: 'Fields of this entity, in order.' }, unique: { type: 'boolean' }, diff: DIFF } },
          },
          links: LINKS,
          fields: {
            type: 'array',
            description: 'One field per item, never several in one name ("a / b", "a, b"). A changed type is the old one del and the new one add; a renamed field is one line, move with from "<this entity>.<old name>"; a field moved from another entity is move with from.',
            items: {
              type: 'object',
              required: ['name', 'type'],
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                note: { type: 'string' },
                diff: DATA_DIFF,
                from: { type: 'string', description: 'With move: "<entity id>.<field>" it moved from, a field of another entity of this diagram, or "<this entity id>.<old name>" when renamed.' },
              },
            },
          },
        },
      },
    },
    relations: {
      type: 'array',
      description: 'data: links between entities: every reference field (user_id, *_id, a composite key) of a changed entity has one, to an unchanged entity too. A relation pointed elsewhere is the old one del and the new one add.',
      items: {
        type: 'object',
        required: ['from', 'to', 'kind'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          kind: { type: 'string', enum: ['1:1', '1:N', 'N:1', 'N:M', 'ref'] },
          field: { type: 'string', description: 'The field of `from` that holds the link.' },
          label: { type: 'string' },
          diff: DIFF,
          cross: { type: 'boolean', description: 'Between modules or systems: no foreign key, it holds by value only (drawn dashed).' },
        },
      },
    },
  },
}

const FINDING = {
  type: 'object',
  required: ['text', 'summary'],
  properties: {
    text: { type: 'string', description: 'The comment on the PR: short, to the author, what to change and why.' },
    summary: { type: 'string', description: 'The essence for the user, one short line (≤ 15 words) that alone says what is wrong; text is the comment for the PR.' },
    where: { type: 'string', description: 'file:line, a module or a PR, when it applies.' },
    level: {
      type: 'string',
      enum: ['blocker', 'should_fix', 'question', 'nit'],
      description: "blocker: must not merge; should_fix: fix before merge unless argued; question: needs the author's answer; nit: optional.",
    },
    node: { type: 'string', description: 'The node of a diagram it is about: canvas:<id>#<node-id>, e.g. on the fact diagram.' },
  },
}

/** A claim of a review report: text, its source and what it cites. checked is mag's to give. */
const claim = () => ({
  type: 'object',
  required: ['text', 'cites'],
  properties: {
    text: { type: 'string' },
    source: { type: 'string', enum: ['agent', 'user'], description: "agent: your reading, with code refs; user: the user's own words (PR comments, notes, decisions). mag itself gives checked to a mechanical fact whose cites are all units it verified; never give it." },
    cites: { type: 'array', items: { type: 'string' }, description: 'file:line or inventory unit ids; a PR comment, decision:<id> or a note for the user\'s words. At least one.' },
  },
})

/** The review report (review-v3-concise-design-first.1): issues and evidence; mag checks it before it stores it. */
const REPORT = {
  type: 'object',
  description: 'Issues and evidence, in the order the user reads them: intent, issues, acceptance, verified and not checked, the direction when open, the conclusion.',
  required: ['intent', 'verdict', 'why', 'issues', 'acceptance', 'verified', 'notChecked', 'conclusion'],
  properties: {
    intent: { type: 'string', description: 'Shown first: one concise paragraph for a human on what the change does and why, not how; no blank lines or lists, up to 600 characters.' },
    verdict: {
      type: 'string',
      enum: ['approve', 'approve_with_comments', 'look', 'request_changes'],
      description:
        'approve: you would merge it yourself, no issues of your own; approve_with_comments: mergeable, its issues are should, nit or note; look: the user must decide something first (an issue they or the PO own); request_changes: a blocker or should issue must be fixed first. Never approve with a blocker. mag keeps its own floor where it has the facts: a failed CI check or architecture rule makes it request_changes; it attaches those blockers itself, so they need no issue of yours. Plan ↔ fact is no floor: the user reads it as one line.',
    },
    why: { type: 'string', description: 'One line on why this verdict.' },
    delta: {
      type: 'array',
      description: "A re-review only, required there: the table against the previous round the user reads first. Each issue of the previous round once, fixed or open; each issue of this report once, open or new. mag counts them against both rounds' issues.",
      items: {
        type: 'object',
        required: ['title', 'status'],
        properties: { title: { type: 'string', description: "The issue's title as its round gave it." }, status: { type: 'string', enum: ['fixed', 'open', 'new'] } },
      },
    },
    issues: {
      type: 'array',
      description: 'Only what is wrong, each problem exactly once, ranked by impact (the user reads the first 5; the rest fold). No list of what passes. None is a fine answer.',
      items: {
        type: 'object',
        required: ['title', 'impact', 'kind', 'severity', 'owner', 'comment'],
        properties: {
          title: { type: 'string', description: 'Its essence, one short line (≤ 15 words) that alone says what is wrong.' },
          impact: { type: 'string', description: 'What goes wrong and for whom, concretely (an input, a user, a record).' },
          kind: { type: 'string', enum: ['bug', 'data', 'security', 'ops', 'acceptance', 'design', 'scope', 'tests', 'convention', 'naming', 'docs', 'question'] },
          severity: {
            type: 'string',
            enum: ['blocker', 'should', 'nit', 'note'],
            description: 'By impact, not by kind of check. blocker: must not merge; only a bug, data, security or production-ops problem, or acceptance (criteria missing on a change of behaviour, or one not met); never conventions, naming, docs or ticket wording. should: fix before merge unless argued. nit: optional. note: no action.',
          },
          owner: { type: 'string', enum: ['author', 'po', 'user'], description: 'Who decides it: the author (the code), the PO (scope, the ticket), the user.' },
          comment: { type: 'string', description: 'The PR comment, ready to post as it is: to the author, what to change and why; short.' },
          where: { type: 'string', description: 'file:line or file:line-line of the PR\'s side (repo:file:line across repos); never an inventory unit id. Leave it out for an issue of the whole change.' },
          raisedBy: { type: 'string', description: 'When a PR thread already raised it: who (@login). It is not counted as new and not published by default.' },
        },
      },
    },
    acceptance: {
      type: 'array',
      description: 'Each acceptance criterion → its evidence. Criteria from the PR first, then its ticket, then the design (the doc, a step\'s plan); none: you inferred it.',
      items: {
        type: 'object',
        required: ['criterion', 'source', 'evidence', 'status'],
        properties: {
          criterion: { type: 'string' },
          source: { type: 'string', enum: ['pr', 'ticket', 'design', 'none'] },
          evidence: { type: 'string', description: 'A test by name, a CI check, a check you ran; for unverified, what would verify it. Not a retelling of the code.' },
          status: { type: 'string', enum: ['met', 'partly', 'not', 'unverified'] },
        },
      },
    },
    trivial: { type: 'boolean', description: 'A config, version or typo change that changes no behaviour: it needs no criteria. Otherwise a change without criteria in the PR, ticket or design gets a blocker issue of kind acceptance.' },
    verified: { type: 'array', items: { type: 'string' }, description: 'What you verified, one line each: earlier PR threads (fixed / still open, with who), CI checks, tests you ran.' },
    notChecked: { type: 'array', items: { type: 'string' }, description: 'What the verdict does not cover, one line each.' },
    follows: { type: 'string', description: 'When a design or decision settles the direction: what, one line (a step: "the approved plan"; a decision:<id>; the ticket\'s design). Either follows or direction.' },
    direction: {
      type: 'object',
      description: 'Only when no design or decision settles the direction: the design decision(s) the change makes and its options; the call is the user\'s, your own leaning goes in view.',
      required: ['decisions', 'options', 'facts', 'references'],
      properties: {
        decisions: { type: 'array', items: claim(), description: 'One sentence each.' },
        options: {
          type: 'array',
          description: 'Every sensible way to make the decision, as many as there really are; exactly one with pr: true, the change\'s own.',
          items: { type: 'object', required: ['name', 'tradeoffs'], properties: { name: { type: 'string' }, tradeoffs: { type: 'string' }, pr: { type: 'boolean' } } },
        },
        only: { type: 'string', description: 'With a single option: why it is the only sensible one ("only one, because…").' },
        facts: { type: 'array', items: claim(), description: 'Mechanical facts about the change\'s option.' },
        references: { type: 'array', items: claim(), description: 'Notes, ADRs, CLAUDE.md rules, earlier decisions of the user, PR threads.' },
        view: {
          type: 'object',
          description: 'Optional: your own leaning on the direction; it never affects the verdict, and the user sees it folded after the options.',
          required: ['leaning', 'why', 'confidence'],
          properties: {
            leaning: { type: 'string', description: 'The name of the option you lean to.' },
            why: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
      },
    },
    diagram: { type: 'string', description: 'canvas:<id> of the single diagram the review page shows (the system view or a scenario); leave it out when none adds to the issues.' },
    conclusion: { type: 'string', description: 'Shown last: one concise paragraph with your conclusion and advice: what to publish, whom to ask; no blank lines or lists, up to 600 characters.' },
  },
}

export const TOOL_DEFS = [
  {
    name: 'get_task',
    reviewer: 'also',
    scope: 'task',
    description:
      'Get the current task: title, type, status, description, subtasks (its steps in order, with status, startManually, repos (missing = every repository), PRs and current: true on the step being worked on), project repos, the work (your step\'s dir and per repo: worktree, branch, PR) and the doc template for this task type.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_doc',
    reviewer: 'also',
    scope: 'task',
    description: 'Read the current task document (markdown).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_diagrams',
    reviewer: 'also',
    scope: 'task',
    description:
      'The diagrams of this task with their data: the target picture of the change (component, sequence, state, flowchart, data) with diff marks; component marks moved interface methods, data moved entities and fields, with move and from. Each says where it stands: role option (with option), plan (with step and repo); of names the task that owns a diagram the doc links. With step: only that step\'s diagrams.',
    inputSchema: { type: 'object', properties: { step: { type: 'string', description: 'Key of a step, e.g. ABC-12.2: only its diagrams.' } } },
  },
  {
    name: 'place_diagram',
    scope: 'task',
    description:
      'Say where a diagram stands in this task, without redrawing it: role option with option (the option it sketches), role plan with step and repo (the step and repository it changes), role none to unplace. A diagram drawn in the project chat moves into the task; one of another task is copied in (link the copy in the doc instead).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...PLACEMENT }, required: ['id', 'role'] },
  },
  {
    name: 'update_doc',
    scope: 'task',
    description: 'Replace the task document with new markdown. Keep it concise. Mermaid code blocks are allowed.',
    inputSchema: {
      type: 'object',
      properties: { markdown: { type: 'string' } },
      required: ['markdown'],
    },
  },
  {
    name: 'set_needs_input',
    scope: 'task',
    description:
      "Tell the user you need them: a one-line ask that says what they must do or decide (\"Review the changes in ftm, then say go\"), never a status (\"Changes ready\"); null when nothing is pending anymore. The user's next message in your chat clears it. Details belong in the doc. When the user has to decide something, pass each decision in questions with your recommendation: the user sees them on a card under your reply and can accept all recommendations with one click (your chat then gets them as the user's answer). Write them in the user's language; the card is where they are read, so your reply does not list them again: say what the card cannot (the evidence, why), or only that they are on the card. A step's developer asks the work's owner first: it answers in the developer's chat or asks the user.",
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: ['string', 'null'] },
        questions: {
          type: 'array',
          description: 'The decisions the user has to make, each a short question and your recommendation (one line: what and why).',
          items: { type: 'object', properties: { text: { type: 'string' }, recommendation: { type: 'string' } }, required: ['text', 'recommendation'] },
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'answer_developer',
    scope: 'task',
    description:
      "The owner of the work: answer the question a step's developer asked with set_needs_input. The text goes into the developer's chat (the answer and why) and it goes on; the work no longer needs the user.",
    inputSchema: {
      type: 'object',
      properties: { step: { type: 'string', description: 'The step key, e.g. ABC-12.2.' }, text: { type: 'string' } },
      required: ['step', 'text'],
    },
  },
  {
    name: 'create_subtask',
    scope: 'task',
    description:
      'The owner of the work (its groomer after the user has answered the checkpoint in chat, or the topic that created it): add an execution step to the work: a short title and an optional one-line note saying what ships in it. Each step runs in its own developer session from fresh base, with at most one PR per changed repo; steps run in order, kept in creation order.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        note: { type: 'string', description: 'Optional one line; the task doc carries the details.' },
        start_manually: { type: 'boolean', description: 'The step waits for the user to press Start instead of starting when the previous one is done (releases in parts).' },
        repos: STEP_REPOS,
      },
      required: ['title'],
    },
  },
  {
    name: 'update_subtask',
    scope: 'task',
    description: 'The owner of the work: change the title, note, start_manually or repos of a step while planning.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        title: { type: 'string' },
        note: { type: 'string' },
        start_manually: { type: 'boolean' },
        repos: STEP_REPOS,
      },
      required: ['key'],
    },
  },
  {
    name: 'delete_subtask',
    scope: 'task',
    description: 'The owner of the work: remove a step that is no longer needed.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'reorder_subtasks',
    scope: 'task',
    description: 'The owner of the work: set the order of the steps. Pass every step key of the work, in the new order.',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'array', items: { type: 'string' } } },
      required: ['keys'],
    },
  },
  {
    name: 'set_subtask_status',
    scope: 'task',
    description:
      'Legacy tasks only (started before steps): set the status of a checklist subtask: in_progress, done or todo. Steps of other tasks follow their lifecycle; use complete_step for a step without code.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, status: { type: 'string', enum: ['todo', 'in_progress', 'done'] } },
      required: ['key', 'status'],
    },
  },
  {
    name: 'check_subtask',
    scope: 'task',
    description: 'Deprecated, legacy tasks only: use set_subtask_status. Tick a subtask of the current task as done (done: false sets it back to todo).',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, done: { type: 'boolean' } },
      required: ['key', 'done'],
    },
  },
  {
    name: 'complete_step',
    scope: 'task',
    description: 'Developer only: close your step when it needs no code change. Fails if any repo of the step has commits of its own; those go through a PR.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_repo',
    scope: 'task',
    description:
      'Developer only: you need to change a project repository your step has no worktree of (the plan missed it). Creates its worktree on the step branch in your step dir and returns its path; then it is a repo of your step like the others. If the task works on that repository locally, it puts the main checkout on the step branch instead, or fails with what is in the way (uncommitted changes, another branch, another step there): then ask the user. Also call it for a local repository of your step once the user has settled such a problem with you.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name (its folder name, as in get_task) or path.' },
        worktree: { type: 'boolean', description: 'A worktree even if the task works on this repository locally. Only when the user said so.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'set_pr',
    scope: 'task',
    description:
      'Developer only: record the pull request you opened for one repository of your step. One PR per changed repo per step; once every repo with commits has one, the step waits for the user to merge.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        repo: { type: 'string', description: 'Repo name as get_task lists it (work.repos[].name) or its path. Optional when the task has one repo.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'set_inventory',
    scope: 'task',
    reviewer: 'also',
    description:
      "The fact of the PRs under review (a step's reviewer; the topic that owns a review of a teammate's PR): their change inventory, a flat list of what changed at the level a reviewer designs at, written from the hunks get_pr_changes lists. For TS and JS files get_pr_changes also lists draft units (d1…) mag parsed: a unit with a draft id gives only the fields it adds or changes, the rest are the draft's; a unit of your own with a draft unit's module, kind and name (or a rename's from) takes its place; the other draft units stay as drafted. mag checks it against the hunks (blockers: a block of changed code in no unit and not in noise, an id that is no block, a unit whose name its hunks do not bear out, a unit on a module that owns none of its blocks, a call to a target that is no module and not external, a unit with several names, a changed method without before, after and note; warnings: code called noise, declarations no unit of their module names), generates the fact's Component and Data diagrams from it (the root of the fact set, replacing those drawn before; a method is a line 'signature - note', a call a marked line on the use of its caller to its target) and answers with the check and plan ↔ fact. Call it again with the whole inventory to fix it.",
    inputSchema: {
      type: 'object',
      properties: {
        inventory: {
          type: 'object',
          required: ['summary', 'units', 'noise'],
          properties: {
            summary: { type: 'array', items: { type: 'string' }, description: '3–6 short bullets: what the change does, by meaning.' },
            units: {
              type: 'array',
              description: 'One per change. method: every function or method added, removed or changed, public and private. model / field: types of data and their fields; stored only for persisted data. index: DB indexes and unique keys. dependency: a module starts or stops using another module or system, not imports inside a module. call: a call between modules added, removed or with changed arguments, one per target method. config / template: prompts, templates, config entries whose change alters behaviour, one per constant. Mocks, fakes and test helpers are never units; a rename is one unit, change rename with from, never a del and an add; one name per unit, never "a, b" or "a / b". A unit of your own needs kind, module, name, change and hunks.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'u1, u2…; filled in when left out. A draft unit\'s id (d1…) builds on that unit: then only kind, module, name, change and hunks you change are needed, none of them required.' },
                  drop: { type: 'boolean', description: 'With a draft id: leave that draft unit out, as no change of the design or replaced by a rename unit of yours.' },
                  kind: { type: 'string', enum: ['method', 'model', 'field', 'index', 'dependency', 'call', 'config', 'template'] },
                  module: { type: 'string', description: 'The module of its hunks, as the listing names it; call: the module that calls.' },
                  owner: { type: 'string', description: 'method: the type, class or file it belongs to; field / index: its model.' },
                  name: { type: 'string', description: 'Copied from the diff. method / model: its name; field: "<model>.<field>"; index: its name; dependency: the module id or package used; call: "<target module id>#<method>" ("<package>#<func>" outside the project, with external); config: the constant, e.g. DEFAULT_PLAYBOOK.fact.' },
                  change: { type: 'string', enum: ['add', 'mod', 'del', 'rename'], description: 'call: add, del, or mod when its arguments change.' },
                  visibility: { type: 'string', enum: ['public', 'private'] },
                  before: { type: 'string', description: 'The old signature (field type, definition; a call as the code made it), one line; none for add. Required for a changed method, also when only its body changes.' },
                  after: { type: 'string', description: 'The new one; none for del. Required for a changed method.' },
                  from: { type: 'string', description: 'rename: the old name.' },
                  logic: { type: 'string', enum: ['none', 'trivial', 'nontrivial'], description: 'method: nontrivial when branches, loops, error handling, external calls or data access change; trivial for wiring, renames, one-liners; none when only the signature changes.' },
                  stored: { type: 'boolean', description: 'model / field: true only for persisted data (a table, collection, document, cache entry); never arguments, options or DTOs.' },
                  external: { type: 'boolean', description: 'call: its target is outside the project (a package, an outside system), no module of the architecture.' },
                  hunks: { type: 'array', items: { type: 'string' }, description: 'The blocks that change it, e.g. ["H3.1", "H4.2"]; not the other blocks of their hunks. "H3" stands for every block of H3.' },
                  note: { type: 'string', description: 'One line: what it does now or what changes in its meaning; shown after the signature. Required for a changed method.' },
                },
              },
            },
            noise: {
              type: 'array',
              description: 'Blocks of code that are no change of the design, with why: formatting, comments, generated code. Every block of changed code is in a unit or here. Tests, docs, styles and lock files need not be cited.',
              items: { type: 'object', required: ['hunks', 'reason'], properties: { hunks: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } } },
            },
          },
        },
      },
      required: ['inventory'],
    },
  },
  {
    name: 'set_review',
    scope: 'task',
    reviewer: 'only',
    description:
      'Reviewer only: your review of the PRs of the step under review, once per review: the report (mag checks it; its issues are the findings; your verdict, raised to mag\'s floor where that is stricter, routes it: request_changes → changes, look → look, approve and approve_with_comments → merge). changes: the findings go to the developer, not GitHub; merge: ready, nothing for the user to check; look: the user should decide or check something. Without a report (older form): verdict and findings.',
    inputSchema: {
      type: 'object',
      properties: {
        report: REPORT,
        verdict: { type: 'string', enum: ['changes', 'merge', 'look'], description: "Only without a report; with one it must match the report's verdict." },
        findings: { type: 'array', description: 'Only without a report: one finding per item, each with its level; none for a clean merge.', items: FINDING },
      },
    },
  },
  {
    name: 'set_pr_review',
    scope: 'task',
    description:
      "A topic that runs a review of a teammate's PR: record it into the result of its format, once you have it and again when it changes; the other format's result stays. v2 (your job says which): the report; mag checks it, takes your verdict (raised to request_changes when CI fails, with that blocker attached), and its issues are the findings the user may publish, each comment as it is. v1: verdict and findings, no report. It shows in the review's pane beside its conversation; nothing goes to GitHub.",
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'What the PR fixes and why it is real, with evidence (ticket, code path, logs); short.' },
        approach: { type: 'string', description: 'How the PR solves the problem and whether it does; short.' },
        report: REPORT,
        verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'], description: 'v1 only: request_changes with any blocker, approve when you would merge it yourself, comment otherwise.' },
        findings: { type: 'array', description: 'v1 only: one finding per item, each with level, where (file:line) and node when they apply.', items: FINDING },
      },
      required: ['problem', 'approach'],
    },
  },
  {
    name: 'decide_direction',
    scope: 'task',
    description:
      "The topic that owns a review of a teammate's PR: record the user's call on the direction of its report, once they made it here (after you argued the options with them): ok (the direction is fine), prefer (another option; option: its name as the report has it), or discuss (ask the author first). mag records it on the review, in the project's direction decisions and as one line of its notes; later reviews cite it as the user's. Only the user decides: never call it on your own judgement. Nothing goes to GitHub.",
    inputSchema: {
      type: 'object',
      properties: {
        choice: { type: 'string', enum: ['ok', 'prefer', 'discuss'] },
        option: { type: 'string', description: "With prefer: the option's name, one of the report's options other than the PR's." },
        principle: { type: 'string', description: "The principle behind the call in the user's words, when they gave one; one line." },
        draft: { type: 'string', description: 'With prefer or discuss: the comment to the author, as worded with the user here (markdown). Without it mag drafts one from the report.' },
      },
      required: ['choice'],
    },
  },
  {
    name: 'review_pr',
    scope: 'project',
    description:
      "Review a teammate's PR of a project repository, by its GitHub link: mag starts (or reopens) its review, run by this topic in one format, fetches the PR and answers with the job. Do it right here, in this turn. A review keeps one result per format; the other one stays. Run only one format of a PR in this topic: a second one here has seen what the first read (v2 must reach its options before the author's description); the user gets the other format in its own topic with Run v1 / Run v2 on the review's page.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'https://github.com/<owner>/<repo>/pull/<n>' },
        format: { type: 'string', enum: ['v1', 'v2'], description: "v1: findings by level and a verdict; v2: the report of questions with the direction for the user. Without it: the project's setting (v2 by default)." },
        again: { type: 'boolean', description: 'Review it again at a head this format has reviewed already; only when the user asks for another look at the same commits. Without it mag answers with the recorded review.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'export_review',
    scope: 'project',
    description:
      "Export a review of a teammate's PR as one .zip, when the user asks (e.g. to take it to another machine): review.html (the review window, static, opens offline), review.json (the review with both results, the direction call, its doc and diagrams with the inventory), pr.diff, pr.json (title, body, files, commits, checks) and diagrams/*.svg. mag renders the page in the project window, which must be open. Answers with the file's path. The user imports it on another mag with Import review in the work list's PR field.",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The key of the review work.' },
        path: { type: 'string', description: 'A .zip file or a directory to write it into; default: the Downloads directory.' },
      },
      required: ['key'],
    },
  },
  // The session tree (topics-a-tree-of-agent.2): a topic and the sessions under it.
  {
    name: 'start_session',
    scope: 'project',
    reviewer: 'also',
    description:
      "Start a child session of yours for a part of the job worth its own session (a long run, research, a prototype, work in parallel): it works on the brief on its own as one of this topic's agents (the user sees its state and log, and talks to you about it, not to it), and it reports back to you with message_session. subtopic: true only when the user asked for a new subtopic or to branch this topic: then it is a conversation of the user's under this topic. role: none for a general session with a topic's tools; developer to change code (in a worktree, no GitHub writes); reviewer to read and report only. Pass a role only when the user named it; otherwise ask which role to use, or start with none. fork: true starts it with all of this conversation (Claude Code only; the user's \"branch this topic\"). Answers with its session id.",
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'What it does, standing on its own: the goal, where, what to report. Empty only with fork, for a branch the user goes on in.' },
        role: { type: 'string', enum: ['developer', 'reviewer'], description: 'A preset; leave it out for a general session.' },
        fork: { type: 'boolean', description: 'Start with all of this conversation instead of only the brief.' },
        subtopic: { type: 'boolean', description: 'true only when the user asked for a subtopic or a branch: the user talks in it. Leave it out for a job of yours.' },
      },
      required: ['brief'],
    },
  },
  {
    name: 'message_session',
    scope: 'project',
    reviewer: 'also',
    description:
      'Write to a session of this topic\'s tree (the topic, a child, the session that started you), as the user writes in its chat: it resumes with the text, or gets it in its turn. Its reply comes back only if it writes to you. Answers whether it was sent.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session: an id start_session answered with, or the one your brief names.' },
        text: { type: 'string', description: 'The message, standing on its own.' },
      },
      required: ['session_id', 'text'],
    },
  },
  {
    name: 'stop_session',
    scope: 'project',
    description: "Stop the turn of a session of this topic's tree, as the user's Stop; it stays and resumes when written to. Never your own.",
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  },
  {
    name: 'get_pr_changes',
    scope: 'task',
    reviewer: 'also',
    description:
      "The files the step's branches change against the base, any language: per module of the project's architecture that owns them, each changed code file with its hunk ids (H1…, old → new lines); tests, styles, lock files, generated code and docs listed apart. Then every hunk of code with its id, owner module, git's header and lines (three lines of context), each block of changed lines marked [H<n>.<k>]: what set_inventory cites. Before the hunks, for TS and JS files of a module, the draft units mag parsed (d1…: functions, methods and types the blocks touch, with signatures and blocks) and the blocks of comments only, which set_inventory takes as drafted. The reviewer gets the heads under review, numbered as mag checks them. A review of a teammate's PR: its fact at the PR's head, without a plan.",
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Repo name as get_task lists it (work.repos[].name) or its path. Default: every repo of the step.' } },
    },
  },
  {
    name: 'check_architecture',
    reviewer: 'also',
    scope: 'any',
    description: 'Analyze the code in your working copy: layers (app, services, clients, lib), service/client interfaces and import rule violations. Developers must have zero violations before opening a PR.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_architecture',
    reviewer: 'also',
    scope: 'any',
    description: 'Get the recorded architecture of this project, if any: a tree of modules (apps and outside runtimes on top, layered modules inside) with interfaces and the calls between them.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_architecture',
    scope: 'project',
    description:
      'Record the architecture of the project as a tree of modules. Replaces the previous one. Top level: apps and outside runtimes (database, 3rd-party API, agent CLI…); inside an app: modules by layer (app, service, client, lib), nested as deep as it helps. A new id for a module that owns the same code as a previous one is changed back to the previous id. The answer lists code files no module owns: add them and call again.',
    inputSchema: {
      type: 'object',
      required: ['summary', 'modules'],
      properties: {
        summary: { type: 'string', description: 'Two or three sentences about the whole system.' },
        modules: { type: 'array', items: ARCH_MODULE, description: 'Top-level modules.' },
      },
    },
  },
  {
    name: 'search_workspace',
    scope: 'any',
    reviewer: 'also',
    description:
      "Search everything the user has in mag: topics (their messages and final replies, summaries), works' docs per section, decisions (lines of a doc's Decisions), recorded meetings (summaries and transcript lines). This workspace by default; scope \"all\" or another workspace when the user asks. All words must match, as prefixes, any case and accents; there is no stemming (Ukrainian, Russian), so pass word stems, e.g. \"реліз\" for релізу/релізом. One hit per source, best first: ref, kind, title, time, labels and the matched snippet; open one with read(ref). Rows about people and of the Personal workspace (outside its own scope) only with people: true, when the user asks about them.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words (or stems) to find, e.g. "DBR queue".' },
        scope: { type: 'string', description: '"all", or a workspace\'s name or id; the workspace you are in by default.' },
        kinds: { type: 'array', items: { type: 'string', enum: ['topic', 'doc', 'decision', 'meeting', 'deliverable', 'person'] }, description: 'Only these kinds.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Only hits with every one of these labels (names or ids; a project\'s name is its label).' },
        people: { type: 'boolean', description: 'Include rows about people and of the Personal workspace; only when the user asks.' },
        from: { type: 'string', description: 'On or after: ISO date (YYYY-MM-DD, the local day) or time.' },
        to: { type: 'string', description: 'On or before: ISO date (the whole local day) or time.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read',
    scope: 'any',
    reviewer: 'also',
    description:
      'The text of a ref mag gave you, in any project or workspace: a hit of search_workspace (a topic from that message on, a work with its doc and owner topic, a doc section, a work\'s Decisions, a meeting from that line), paged at ~40k characters (pass the answer\'s offset for the next page); a deliverable (<workspace>:dlv:<slug> or dlv:<slug>): its final version when it is final or published, else its latest; version picks one; its claims follow the text when set_claims recorded them.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from search_workspace, e.g. ws1:topic:ab12cd34#7, ws1:doc:5f1e2a3b#decisions, mtg:2026-11-20-1430-sync@00:00:09.' },
        offset: { type: 'number', description: 'Where the page starts, in characters from the ref; 0 by default.' },
        version: { type: 'number', description: 'A deliverable: this version.' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'search_meetings',
    scope: 'any',
    reviewer: 'also',
    description:
      "search_workspace over meetings only, with their filters. Search the user's recorded calls (workspace-wide, not only this project): their transcripts and summaries, when the user asks about a meeting or what was said or decided on a call. All words must match, as prefixes, any case. One hit per meeting, best first, with the meeting id, title, start, part and [hh:mm:ss] of a transcript line.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to find, e.g. "release date".' },
        from: { type: 'string', description: 'Meetings started on or after: ISO date (YYYY-MM-DD, the local day) or time.' },
        to: { type: 'string', description: 'Meetings started on or before: ISO date (the whole local day) or time.' },
        people: { type: 'array', items: { type: 'string' }, description: 'Only meetings with any of them among the participants (a part of a name).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_meeting',
    scope: 'any',
    reviewer: 'also',
    description:
      "One of the user's meetings by id (from search_meetings): title, times, participants, then its summary and transcript (lines \"[hh:mm:ss] me|others: text\"; me is the user). Pages of ~40k characters: pass the answer's next as offset.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Meeting id, e.g. 2026-11-20-1430-dbo-sync.' },
        part: { type: 'string', enum: ['summary', 'transcript'], description: 'Only this part; both by default.' },
        offset: { type: 'number', description: 'Where the page starts, in characters; 0 by default.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'save_deliverable',
    scope: 'any',
    description:
      'Save a non-code result for the user (a report, an assessment, a proposal, a reply, an agenda…) as a deliverable: a new one, or with ref the next version of one. Each version is a markdown file in the workspace folder (~/Documents/mag/<workspace>/deliverables/<slug>/v<N>.md); the user reads the versions and their diff in the topic\'s panel, marks one final and publishes it. A new version of a final one is a draft again. Use it instead of loose files or a canvas for a result the user will keep or send; follow the pack of its kind (get_pack). Returns the ref (<workspace>:dlv:<slug>) and the file.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The deliverable to add a version to: <workspace>:dlv:<slug>, or dlv:<slug> in this workspace. Omit for a new one.' },
        kind: { type: 'string', enum: ['report', 'assessment', 'proposal', 'decision', 'reply', 'ticket', 'agenda', 'other'], description: 'Required for a new one; a version keeps its kind.' },
        title: { type: 'string', description: 'Required for a new one; given with ref, renames it.' },
        md: { type: 'string', description: 'The whole version as markdown.' },
        file: { type: 'string', description: 'Instead of md: an absolute path of a markdown file to take the version from.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to find it by, e.g. a team or a series ("weekly-dbo"); replaces the old ones.' },
        destination: {
          type: 'object',
          description: 'Where it will be published, when known.',
          required: ['kind'],
          properties: { kind: { type: 'string', enum: ['slack', 'jira', 'confluence', 'github', 'gdocs', 'other'] }, target: { type: 'string', description: 'The channel, issue, page, repo or doc.' } },
        },
      },
    },
  },
  {
    name: 'list_deliverables',
    scope: 'any',
    description: "The workspace's deliverables, newest first: ref, kind, title, state, versions and the final one, labels. Read one with read.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['report', 'assessment', 'proposal', 'decision', 'reply', 'ticket', 'agenda', 'other'] },
        state: { type: 'array', items: { type: 'string', enum: ['draft', 'in_review', 'final', 'published'] } },
        labels: { type: 'array', items: { type: 'string' }, description: 'Only those with every one of them.' },
        topic: { type: 'boolean', description: 'true: only those made in this topic.' },
      },
    },
  },
  {
    name: 'set_claims',
    scope: 'any',
    description:
      "Record the claims of a deliverable's version: every statement a reader would check (a count, a fact about work or a person, an inference, an opinion) with its exact span in the markdown and what backs it. Replaces the version's claims. mag checks them and returns what fails: a claim without refs, a count without its query, a ref that does not resolve, and a claim about a person without a primary source (a PR, a ticket, a message, a transcript time); in an assessment every claim is about a person. Fix the version or the refs and call again; the user sees each claim underlined, red when it fails. Then verify_deliverable.",
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The deliverable: <workspace>:dlv:<slug> or dlv:<slug>.' },
        version: { type: 'number', description: 'Its version; the latest by default.' },
        claims: {
          type: 'array',
          description: '[] when the version states nothing to check.',
          items: {
            type: 'object',
            required: ['text', 'kind', 'refs'],
            properties: {
              id: { type: 'string', description: 'Stable id, e.g. c1; by default c<position>.' },
              text: { type: 'string', description: 'The exact span in the version\'s markdown, as written there.' },
              kind: { type: 'string', enum: ['count', 'fact', 'inference', 'opinion'] },
              refs: {
                type: 'array',
                items: { type: 'string' },
                description: 'What backs it: URLs (a PR, ticket or Slack message URL counts as primary), owner/repo#N, ABC-12, dlv:<slug>, mtg:<meeting id>@<hh:mm:ss> (a transcript time, primary) or mtg:<id> (its summary), topic:<id>, absolute file paths.',
              },
              query: { type: 'string', description: 'For a count: the command or JQL that produced it, so the verifier re-runs it.' },
              person: { type: 'string', description: 'The person it is about, if any.' },
            },
          },
        },
      },
      required: ['ref', 'claims'],
    },
  },
  {
    name: 'verify_deliverable',
    scope: 'any',
    description:
      "Have a verifier review a deliverable's version before the user marks it final: a read-only session that re-checks every claim against its sources, re-runs the recorded queries and ends with a verdict (publish, changes or look) the user sees on the document. It is a fork of the deliverable's topic, or for people-sensitive ones (an assessment) a fresh session with only the deliverable, its claims and the sources. Record the claims with set_claims first. Returns the verifier's session; it reports back to the topic.",
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The deliverable: <workspace>:dlv:<slug> or dlv:<slug>.' },
        version: { type: 'number', description: 'Its version; the latest by default.' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'set_verdict',
    scope: 'any',
    reviewer: 'only',
    description:
      "The verifier's verdict on the deliverable version mag asked it to verify: publish (every claim holds), changes (the author fixes the findings first) or look (the user decides; say why in a finding). One finding per problem, tied to its claim when it is about one. The user sees it on the document; the deliverable goes in review.",
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        version: { type: 'number' },
        verdict: { type: 'string', enum: ['publish', 'changes', 'look'] },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['text', 'level'],
            properties: {
              claimId: { type: 'string', description: 'The claim it is about, from set_claims.' },
              text: { type: 'string', description: 'What is wrong and what backs that, in one or two sentences.' },
              level: { type: 'string', enum: ['blocker', 'should_fix', 'question', 'nit', 'note'] },
            },
          },
        },
      },
      required: ['ref', 'version', 'verdict', 'findings'],
    },
  },
  {
    name: 'get_pack',
    scope: 'any',
    reviewer: 'also',
    description:
      "The workflow pack of a deliverable kind: how the user wants one done (prompt), its structure (template), what it is judged by (rubric) and the rules learned from the user's corrections, the project's overrides applied. Read it before the first version of a deliverable; a topic gets the packs of its deliverables' kinds with its next message anyway. The files are in ~/Documents/mag/<workspace>/packs/<kind>/ (a project's in projects/<project>/packs/<kind>/).",
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['report', 'assessment', 'proposal', 'decision', 'reply', 'ticket', 'agenda', 'other'] } },
      required: ['kind'],
    },
  },
  {
    name: 'propose_rule',
    scope: 'any',
    description:
      "When the user corrects how a kind of deliverable is done (\"use links, not raw text\"), propose it as a rule for that kind's pack, so it holds next time without being said again. The user sees a card; Accept appends it to the pack's rules.md, Reject writes nothing. It does not wait: go on, and mag tells you the answer with your next message.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['report', 'assessment', 'proposal', 'decision', 'reply', 'ticket', 'agenda', 'other'] },
        rule: { type: 'string', description: 'One line, as an instruction to follow, e.g. "Link PRs and tickets instead of pasting their text".' },
        why: { type: 'string', description: 'What the user said or corrected, in a few words.' },
        scope: { type: 'string', enum: ['workspace', 'project'], description: "workspace (default): every project of the workspace; project: only this topic's project." },
      },
      required: ['kind', 'rule'],
    },
  },
  {
    name: 'who',
    scope: 'any',
    reviewer: 'also',
    description:
      "Who a handle is in this workspace's people (Slack, Jira and GitHub directories joined, with the user's corrections): a Slack member id, Atlassian accountId, GitHub login, email, person id or a name said on a call. Answers the person with their name, email, title and every handle, not a person (a bot), or unknown with a suggestion the user has not confirmed. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'e.g. bezpaluy89, U02ABC123, 712020:…, a name.' },
        system: { type: 'string', enum: ['slack', 'atlassian', 'github', 'meeting'], description: 'Only this system; any by default.' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'people',
    scope: 'any',
    reviewer: 'also',
    description: "Persons of this workspace whose name, email, title or a handle matches q (or whose name is close to it), best first, with their handles. Read-only.",
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'A part of a name, email, title or handle, e.g. Ihor.' } }, required: ['q'] },
  },
  {
    name: 'where_works',
    scope: 'any',
    reviewer: 'also',
    description:
      "Where a person of this workspace works, derived from their activity (never declared): per Project label, the PRs they opened, others' PRs they reviewed, Jira work items they are assignee or reporter of, and linked meetings they took part in, over the last days (60 by default). PRs and tickets are fetched once a day. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: 'A person id, handle, email or name, e.g. bezpaluy89 or Ihor Koval.' },
        days: { type: 'number', description: 'The window in days, 1 to 365; 60 by default.' },
      },
      required: ['person'],
    },
  },
  {
    name: 'pr_stats',
    scope: 'any',
    reviewer: 'also',
    description:
      "PRs and reviews of this workspace's repositories by person and Project label: PRs opened and merged, and others' PRs reviewed (each PR once), between two dates. A person's GitHub logins are folded into one row; a login without a person gets its own row; bots are left out. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD (the local day\'s start) or an ISO time.' },
        to: { type: 'string', description: 'YYYY-MM-DD (the local day\'s end) or an ISO time.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Only these Project labels (names or ids); every label and repo by default.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'read_chat',
    scope: 'any',
    reviewer: 'also',
    description:
      'The full history of another chat, of this project or any other project or workspace, e.g. one the user references (its id is in <referenced-chats>) or one list_chats found: a topic\'s messages, a work\'s or review\'s title, doc and its owner topic\'s messages; tool calls on one line, with times. Archived chats too. A chat of another project starts with where it is. Pages of ~40k characters: pass the answer\'s next as offset for the next one.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: REF_ARG },
        offset: { type: 'number', description: 'Where the page starts, in characters; 0 by default.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_tasks',
    scope: 'any',
    description:
      'Works of the project: in progress, then ready, planning and finished (done, canceled; newest first); subtasks (execution steps: todo, in_progress, done) follow their task. Key, title, type, status, parent, needs_input, PRs with their state, tickets (links), cancel reason; then the project\'s ideas (text, source: where an agent found it).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_task',
    scope: 'any',
    reviewer: 'also',
    description: 'One work or step with its document, of this project or any other project or workspace; one elsewhere comes with its ref and project.',
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: `The work or step: ${REF_ARG}` } }, required: ['key'] },
  },
  {
    name: 'list_workspaces',
    scope: 'any',
    reviewer: 'also',
    description: "The user's workspaces: id, name, prefix (of their refs, e.g. aura:work:ABC-12), the user's profile there, and their projects; this: true on yours.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_work',
    scope: 'project',
    description:
      'Start a work: what the user and you discussed here, about zero or more tickets. This topic owns it: you plan it here (doc via update_task_doc, ' +
      'diagrams and steps with the owner tools, passing work: its key) and later review its PRs first. The description is the brief: what and why, concise. ' +
      'Its key is the first ticket\'s key, else a slug of the title. doc pre-fills the document. plan: true makes the work ready (the plan approved) and starts nothing; the user starts it. Use it ' +
      "only when the doc is complete (follow the project's doc template) and the user asked for it; it needs steps.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: ['dev', 'design', 'spike', 'research'], description: 'Default dev.' },
        description: { type: 'string' },
        tickets: {
          type: 'array',
          description: 'Tickets the work is about, as links (any tracker); [] or left out for a work without a ticket.',
          items: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'The https link of the ticket.' }, key: { type: 'string', description: 'Its key, e.g. ABC-12, when the link does not show it.' } } },
        },
        doc: { type: 'string', description: 'Work document (markdown). Required with plan: true.' },
        plan: { type: 'boolean', description: 'The plan is complete and the user approved it: the work is ready; the user starts it.' },
        steps: {
          type: 'array',
          description: 'Execution steps in order; at least one with plan: true. Each runs in its own developer session with at most one PR per repo.',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, note: { type: 'string' }, start_manually: { type: 'boolean' } },
            required: ['title'],
          },
        },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'add_ticket',
    scope: 'project',
    description: 'Add a ticket to a work by its link (any tracker); the same link twice is kept once. A ticket may belong to several works. mag stores only the link.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'The work, e.g. ABC-12.' }, url: { type: 'string' }, ticket_key: { type: 'string', description: 'The ticket key, e.g. ABC-12, when the link does not show it.' } },
      required: ['key', 'url'],
    },
  },
  {
    name: 'reopen_work',
    scope: 'project',
    description:
      'Continue a done work instead of creating a new one (one problem, one work): it goes back to planning with its done steps kept, and this topic owns it from now on. Then plan what is left here with the owner tools (passing work: its key); the user approves the plan when it is ready.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'The done work, e.g. ABC-12.' }, what: { type: 'string', description: 'One line: what else is needed.' } },
      required: ['key', 'what'],
    },
  },
  {
    name: 'add_idea',
    scope: 'any',
    reviewer: 'also',
    description:
      "Put something worth doing that is outside your scope (a bug, a smell, a missed case, the user's aside) on the project's list of ideas, instead of doing it now. One line: what and where. Ideas have no status; the user starts a work from one or deletes it.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'update_task',
    scope: 'project',
    description: 'Change a task title or brief.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['key'],
    },
  },
  {
    name: 'update_task_doc',
    scope: 'project',
    description: 'Replace the document of a task (markdown). Use when a decision from this chat changes the plan of a task.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, markdown: { type: 'string' } }, required: ['key', 'markdown'] },
  },
  {
    name: 'start_grooming',
    scope: 'project',
    description: 'Start a separate groomer agent on a work in planning (or re-plan a ready one not started yet): only when the user asked for a groomer in this conversation. The groomer becomes its owner. It works in the background and pings the user with questions; the user approves its plan, and the work is ready to start. A work you discussed here you plan yourself.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'cancel_task',
    scope: 'project',
    description:
      'Cancel a task that is not done yet: its running agent stops and its worktrees are removed; open PRs stay open. Always ask the user and get a yes before calling this.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, reason: { type: 'string', description: 'Optional one line: why it is canceled.' } },
      required: ['key'],
    },
  },
  // The buttons of a work for a project chat (chat-keruie-robotamy-i-ahentamy.1): only when the user asks for it.
  {
    name: 'approve_plan',
    scope: 'project',
    description: `Approve a work's plan, as the user's Approve: planning -> ready, with the same checks (a step not done yet, no agent of the work in a turn). ${ASKED}`,
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'The work, e.g. ABC-12.' } }, required: ['key'] },
  },
  {
    name: 'start_work',
    scope: 'project',
    description: `Start a ready work (or restart one in progress), as the user's Start: its current step gets a developer. A work in planning is approved first, as the user's Approve & Start (approve_plan's checks). ${ASKED}`,
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The work, e.g. ABC-12.' },
        local_repos: { type: 'array', items: { type: 'string' }, description: 'Repositories (names or paths) its steps work on in the main checkout instead of a worktree, when the user asks for local. Leave it out for worktrees (a restart keeps what the work had).' },
      },
      required: ['key'],
    },
  },
  {
    name: 'start_step',
    scope: 'project',
    description: `Start the next step of a work in progress that waits for Start (start manually), as the user's Start. ${ASKED}`,
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'The work or that step, e.g. ABC-12 or ABC-12.2.' } }, required: ['key'] },
  },
  {
    name: 'restart_review',
    scope: 'project',
    description: `Restart the agent review of the open PRs of a work's current step, as the user's Restart of a review. ${ASKED}`,
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'The work or its current step.' } }, required: ['key'] },
  },
  {
    name: 'message_agent',
    scope: 'project',
    description: `Write to an agent of a work or a step, as the user writes in its chat: its session resumes with the text (also how you answer its question). Without role: the agent that worked last (for a groomer, the developer). A current step with no developer session yet gets one, started with the text, if its work is approved. ${ASKED}`,
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The work or a step, e.g. ABC-12 or ABC-12.2; a work means its current step for developer and reviewer.' },
        text: { type: 'string', description: 'The message, as the user would write it.' },
        role: { type: 'string', enum: MESSAGED_ROLES, description: 'Whom: the developer, the reviewer or the groomer.' },
      },
      required: ['key', 'text'],
    },
  },
  {
    name: 'stop_agent',
    scope: 'project',
    description: `Stop the agents of a work (its steps' too) or of a step that are in a turn, as the user's Stop. ${ASKED}`,
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'The work or a step.' } }, required: ['key'] },
  },
  // The sidebar's Close, Delete and Restore for a project chat (chat-archives-and-deletes-topics.1).
  {
    name: 'list_chats',
    scope: 'any',
    reviewer: 'also',
    description:
      'The topics and works (reviews too) of your workspace, or of your project or every workspace by scope, one compact row each: id (a topic) or key (a work), ref (what read_chat, read_task and the chat tools take), project (past the project scope; null: none), workspace (scope all), labels (other than the project), kind (topic, work, review), title, state (a topic: idle or running; a work: its status), closed, owns (a topic: the keys of the works it owns), lastAt (day of the last item), items (count); this: true on the topic you are in. Newest first. No docs or steps: read_chat and read_task give those. Use it to find what close_chats, delete_chats or restore_chat should get.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string', enum: ['project', 'workspace', 'all'], description: 'project: this project (a topic without one: the topics without a project); workspace (default): this workspace; all: every workspace.' } },
    },
  },
  {
    name: 'close_chats',
    scope: 'project',
    description: `Close (archive) topics and works, as the user's Close: a topic goes to Done with its history (refused while it owns an open work: cancel or finish that), a done work or a review goes to Closed. The topic of an open work or of a review is refused: close that work instead. Each target on its own, in order; one line each: closed, already closed, refused: <why>, or no such…. This topic is never closed. ${ASKED}`,
    inputSchema: {
      type: 'object',
      properties: { targets: { type: 'array', items: { type: 'string' }, description: 'Refs, topic ids or keys of works or reviews, from list_chats; not step keys.' } },
      required: ['targets'],
    },
  },
  {
    name: 'delete_chats',
    scope: 'project',
    description: `Delete topics and works for good, as the user's Delete: a topic with its history; a work with its steps, sessions, docs, diagrams and worktrees, its owner topic staying (refused while its agents run); a review with mag's topics of it. Branches and PRs stay. A topic that owns an open work is refused until that work is closed or deleted. Each target on its own, in order; one line each: deleted, refused: <why>, or no such… This topic is never deleted. Only for targets the user said yes to deleting in this conversation: list them and ask first; never on your own.`,
    inputSchema: {
      type: 'object',
      properties: { targets: { type: 'array', items: { type: 'string' }, description: 'Refs, topic ids or keys of works or reviews, from list_chats; not step keys.' } },
      required: ['targets'],
    },
  },
  {
    name: 'restore_chat',
    scope: 'project',
    description: `Restore a closed topic, work or review, as the user's Restore: back where it was in the list. A canceled work cannot be restored. One line: restored, not closed, refused: <why>, or no such…. ${ASKED}`,
    inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'A ref, a topic id or the key of a work or review, from list_chats.' } }, required: ['target'] },
  },
  {
    name: 'update_notes',
    scope: 'project',
    description: 'Replace the project notes every agent sees (decisions, conventions, links). Read them first with list_tasks; keep them short.',
    inputSchema: { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'] },
  },
  {
    name: 'run_architect',
    scope: 'project',
    description: 'Re-analyze the code and redraw the architecture diagram in the background.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'show_canvas',
    scope: 'any',
    description:
      'Show the user a visual: UI mockup, comparison, anything without a type of its own (diff diagrams go through show_diagram). Pass one self-contained HTML page or fragment (inline SVG/JS; CDN scripts from cdn.jsdelivr.net or unpkg.com are allowed). ' +
      `mag puts its own stylesheet in every canvas, on the app's tokens and in the user's light or dark theme, so the user sees one product. Build on its classes: ${CANVAS_CLASSES} ` +
      "Bring no palette, fonts or background of your own; add CSS only for layout, using mag's var(--…) tokens for any colour or size (a page with colours of its own is shown on light). " +
      `To show a diagram (the id show_diagram gave you) or another canvas in the page, put <${EMBED_TAG} id="<its id>"></${EMBED_TAG}> at the top level of the page, not inside another element: mag draws that canvas there with its own renderer, hover and click included, and a page it embeds may embed others. Never redraw a diagram in the page (no Mermaid, no hand-made SVG of one); embed it. A page with embeds is split into separate documents at them: its top-level styles go with every piece, its scripts do not, so a script after an embed cannot reach the elements before it. ` +
      'It renders in the chat and is kept with the project (and the task, in a task run). To revise, pass the id you got back: a new version replaces the old one.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        html: { type: 'string' },
        id: { type: 'string', description: 'Existing canvas id to revise.' },
      },
      required: ['title', 'html'],
    },
  },
  {
    name: 'show_diagram',
    scope: 'any',
    // The reviewer draws the fact set of its step only (T-57.4, T-58, povnyi-diff-nabir-pov-iazanykh.1).
    reviewer: 'also',
    description:
      'Record a typed diagram of a change; mag draws it and keeps it with the task (in a task run) or the project. One diagram per question; name the view it answers first (modules, deployment, a scenario) and draw one level per view. component when modules, their interfaces or the calls between them change, and for the system view: apps and outside runtimes at the top level in their boundaries (cloud accounts, VPCs, runtimes, a SaaS, the device) with the main flows numbered, each app\'s modules in its children, so the user clicks into the app and sees its level drawn the same way; sequence for a scenario between participants (services, databases, queues, outside APIs, CLIs); state for the states of an entity; flowchart for an algorithm, with of for the logic of one method; data when stored data changes (its entities and relations say what belongs there). Mark every changed element with diff (add, mod, del); also move, with from, for an interface method (component) or an entity or field (data) that moved or is renamed (one line, never a del and an add). Mocks, fakes and test-only types are never on a diagram. Boundaries are where the code runs, as the project\'s architecture records it (get_architecture), named neutrally as it names them (an AWS account, a SaaS, a runner, a device), never ours or theirs, never by team; a project without an architecture has no outer frames, only its apps; a module whose place the architecture does not say: ask the user, never guess. component takes its modules from get_architecture (same ids) and needs summary: one or two sentences on what changes in substance. Unchanged neighbours without a mark give context. For a method whose non-trivial logic changes, public or private, also draw a flowchart with of, summary and changes, linked from its interface line or, for a private method, from the step of the flowchart that calls it; a new method replacing an old one sets replaces. Draw as many diagrams as the change needs, several of one type too, each a separate named diagram. Give it its place in the task: role option with option for the sketch of an option, role plan with step and repo for the change of a step (steps exist only after create_subtask: place earlier diagrams then with place_diagram). Fails with a list of errors and saves nothing when the data is wrong. A component diagram is also checked against the architecture, and the answer lists where they disagree (an id not in the architecture and not marked add, an add of a module it has, a new module without path): saved anyway, fix it or say in the doc why it is right. A new module gives path, the code it will own. To revise, pass the id you got back. The diagrams of one place (an option, a step\'s plan, a step\'s fact) are one set: mark its entry (the system level or the top component diagram) root, and link the others from modules, interface lines, uses and entities (links: to, node, kind), so every changed module reaches the data, scenarios and method logic it takes part in; a flowchart\'s of counts as a logic link from its method. The answer warns where the set does not hang together (no root, a link outside the set or to a missing node, a diagram the root does not reach) and where a diagram breaks a rule of the diff (an entity without module, data that is not stored, a reference field without relation, a relation between modules not cross, mocks, a rename drawn as del and add). A fact set (the reviewer\'s of its step, a review\'s of a teammate\'s PR) takes only sequence and flowchart diagrams: mag generates its Component and Data diagrams from the change inventory (set_inventory). Draw a scenario (participants with module ids: mag links it from those modules) or the logic of a method the inventory lists with logic nontrivial (flowchart with of "<module>#<method>", the last segment of its name), without role: it joins the fact set. A review\'s essential diagrams are not the fact: role review takes any type, its own set (mark its system view root), shown on the review page above the issues. The answer is mag\'s check of the fact: the inventory against the hunks, links, plan ↔ fact.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        diagram: DIAGRAM,
        id: { type: 'string', description: 'Existing diagram id to revise.' },
        ...PLACEMENT,
        root: { type: 'boolean', description: 'true: the entry of its set (the system level or the top component diagram); the other diagrams of the set stop being root. Not in a fact set: its root is mag\'s.' },
      },
      required: ['title', 'diagram'],
    },
  },
  {
    name: 'request_integration',
    scope: 'any',
    reviewer: 'also',
    description:
      'Ask the user to turn on an integration that is turned off in mag for your role (your prompt lists them): the user gets a card with Enable: Ask / Auto. Then end your turn saying the integration is off in mag; once enabled, mag tells you to repeat your last step.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The integration id from your prompt, e.g. claude_ai_Slack.' },
        why: { type: 'string', description: 'One line: what you need it for.' },
      },
      required: ['id', 'why'],
    },
  },
  {
    name: 'publish',
    scope: 'any',
    description:
      'Hand mag a write that speaks for the user (a post, comment, ticket or doc edit), to run after their Allow: the user gets the Publish card with its preview and rules (a write mag publishes unasked for this project runs at once). With command, mag runs it in its shell in cwd after the Allow and answers its output; with payload, the Allow lets you make exactly that call of your own tool once, without a second card. A deny answers the user\'s note: revise and call again. A push to a base branch is refused. The call waits for the user.',
    inputSchema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Where it goes, kind first: "Slack #channel", "Jira ABC-12", "Confluence <page>", "GitHub owner/repo#4", "Google Docs <doc>", or a plain name for anything else. A gh or acli command\'s own target wins.' },
        command: { type: 'string', description: 'A shell command that does the write (gh, acli, curl…), run in the user\'s login shell.' },
        cwd: { type: 'string', description: 'Absolute directory to run command in; default your work\'s directory, else the project\'s first repository.' },
        payload: {
          type: 'object',
          description: 'Instead of command: the call of your own MCP tool that does the write.',
          properties: { tool: { type: 'string', description: 'Its full name, e.g. mcp__slack__post_message.' }, input: { type: 'object' } },
          required: ['tool', 'input'],
        },
        why: { type: 'string', description: 'One line for the card: what this is and why it goes out now.' },
      },
      required: ['destination', 'why'],
    },
  },
  {
    name: 'approve_tool',
    scope: 'any',
    reviewer: 'also',
    description: 'Internal: mag uses this to ask the user before an integration call or a GitHub write. Do not call it yourself.',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name', 'input'],
    },
  },
] as const

/** The --permission-prompt-tool, as Claude Code names it. */
export const APPROVE_TOOL = 'mcp__mag__approve_tool'

/**
 * Task tools a project chat also gets for the works it owns (T-55.5): it plans them itself instead of a groomer, and
 * reviews a teammate's PR (reviews-ahent-reviuit-pr-timeitiv.2). In a
 * chat they take work, the key of the work; show_diagram and show_canvas take it optionally (without it, the drawing is the project's).
 */
export const OWNER_TOOLS = ['get_diagrams', 'place_diagram', 'update_doc', 'set_needs_input', 'answer_developer', 'create_subtask', 'update_subtask', 'delete_subtask', 'reorder_subtasks', 'show_diagram', 'show_canvas', 'get_pr_changes', 'set_inventory', 'set_pr_review', 'decide_direction'] as const

/** A project chat's buttons a groomer also gets, on the work it grooms or owns (roles-start-only-when-asked.1): all of them, as the user asks. */
export const GROOMER_CONTROL_TOOLS = ['approve_plan', 'start_work', 'start_step', 'restart_review', 'message_agent', 'stop_agent'] as const

const WORK_ARG = { type: 'string', description: 'The key of the work this topic owns, e.g. ABC-12.' }

export type ToolScope = 'task' | 'project' | 'any'

/** The tools a run sees, as the MCP server lists them: by scope and role; a project chat gets the owner tools with work. */
export function toolsFor(scope: 'task' | 'project', role: string | undefined): { name: string; description: string; inputSchema: object }[] {
  const owner = scope === 'project' && role === 'chat'
  const groomer = scope === 'task' && role === 'groomer'
  const control = (name: string) => groomer && (GROOMER_CONTROL_TOOLS as readonly string[]).includes(name)
  return TOOL_DEFS.filter((t) => (t.scope === 'any' || t.scope === scope || control(t.name) || (owner && (OWNER_TOOLS as readonly string[]).includes(t.name))) && toolForRole(t, role)).map((t) => {
    if (control(t.name)) {
      const schema = t.inputSchema as { properties: Record<string, unknown>; required?: readonly string[] }
      return { name: t.name, description: `${t.description} On your work only; key defaults to it.`, inputSchema: { ...schema, required: (schema.required ?? []).filter((r) => r !== 'key') } }
    }
    if (!owner || !(OWNER_TOOLS as readonly string[]).includes(t.name)) return { name: t.name, description: t.description, inputSchema: t.inputSchema }
    const schema = t.inputSchema as { properties: Record<string, unknown>; required?: readonly string[] }
    const optional = t.scope === 'any'
    return {
      name: t.name,
      description: `${t.description} In this chat: ${optional ? 'pass work to draw it in a work you own' : 'pass work, the key of a work you own'}.`,
      inputSchema: { ...schema, properties: { work: WORK_ARG, ...schema.properties }, required: optional ? schema.required : ['work', ...(schema.required ?? [])] },
    }
  })
}

/** Whether a run of `role` (undefined: unknown, as before roles were passed) gets the tool. */
export function toolForRole(def: { name: string; reviewer?: 'only' | 'also' }, role: string | undefined): boolean {
  const reviewer = 'reviewer' in def ? def.reviewer : undefined
  if (role === 'reviewer') return !!reviewer
  return reviewer !== 'only'
}
export type ToolName = (typeof TOOL_DEFS)[number]['name']
