// Tools the MCP server exposes to agents. Schemas only; handlers live in tools.ts.
// scope: 'task' = runs bound to a task (groomer, developer, reviewer), 'project' = project chat and architect, 'any' = both.
// reviewer: it sees only tools marked 'only' (its own) or 'also' for it; the other roles all but 'only'.
// OWNER_TOOLS: a project chat plans the works it owns with them too, passing work (see toolsFor).

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
    enum: ['option', 'plan', 'none'],
    description: 'option: sketches an option of §Options; plan: the planned change of one step; none: unplaced. Omitted on a revision: the diagram keeps its place.',
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
            items: { type: 'object', required: ['to', 'calls'], properties: { to: { type: 'string' }, calls: LINES('Methods of `to` it calls'), diff: DIFF, files: FILES, links: LINKS } },
          },
          links: LINKS,
          children: { type: 'array', items: { type: 'object', description: 'An inner module with the same fields.' }, description: 'Inner modules.' },
        },
      },
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
            description: 'Its indexes and unique keys, changed ones marked; an upsert or "create if missing" rests on a unique one on its key.',
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
  required: ['text'],
  properties: {
    text: { type: 'string' },
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
const claim = (extra: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  required: ['text', 'cites', ...required],
  properties: {
    text: { type: 'string' },
    source: { type: 'string', enum: ['agent', 'yours', 'question', 'rule'], description: "agent: your reading; yours: the user's own words; question; rule: a project rule fails. mag gives checked to a mechanical fact of the direction whose cites are all verified units." },
    cites: { type: 'array', items: { type: 'string' }, description: 'Inventory unit ids or file:line; a PR comment, decision:<id> or a note for the user\'s words. At least one.' },
    view: { type: 'string', description: 'The diagram of the review\'s set that shows it: canvas:<id>#<node>.' },
    ...extra,
  },
})

/** The review report (review-v2-questions-first-direction.1): answers to fixed questions; mag checks it before it stores it. */
const REPORT = {
  type: 'object',
  description: 'The answers to the review\'s questions, as the playbook\'s report says.',
  required: ['direction', 'problem', 'conventions', 'risks', 'questions', 'changes', 'checks'],
  properties: {
    direction: {
      type: 'object',
      description: 'The design decision(s) the change makes and its options; never a verdict on it.',
      required: ['decisions', 'options', 'facts', 'references'],
      properties: {
        decisions: { type: 'array', items: claim(), description: 'One sentence each.' },
        options: {
          type: 'array',
          description: '2–4 (a step: the plan\'s, 1–4); exactly one with pr: true, the change\'s own.',
          items: { type: 'object', required: ['name', 'tradeoffs'], properties: { name: { type: 'string' }, tradeoffs: { type: 'string' }, pr: { type: 'boolean' } } },
        },
        facts: { type: 'array', items: claim(), description: 'Mechanical facts about the change\'s option, citing units.' },
        references: { type: 'array', items: claim(), description: 'Notes, ADRs, CLAUDE.md rules, earlier decisions of the user, PR threads.' },
      },
    },
    problem: { type: 'array', items: claim({ criterion: { type: 'string' }, status: { type: 'string', enum: ['solved', 'partly', 'not'] } }, ['criterion', 'status']) },
    conventions: { type: 'array', items: claim({ rule: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail'] } }, ['rule', 'status']) },
    risks: {
      type: 'array',
      items: claim(
        { level: { type: 'string', enum: ['high', 'medium', 'low'] }, kind: { type: 'string', enum: ['bug', 'data', 'ops', 'security', 'privacy'] }, mechanism: { type: 'string', description: 'How it goes wrong.' } },
        ['level', 'kind', 'mechanism'],
      ),
    },
    questions: { type: 'array', items: claim(), description: 'To the author.' },
    changes: {
      type: 'array',
      description: 'The inventory in 2–6 changes by importance; every unit in exactly one; routine ones in one row, last.',
      items: { type: 'object', required: ['title', 'why', 'units'], properties: { title: { type: 'string' }, why: { type: 'string' }, units: { type: 'array', items: { type: 'string' } }, routine: { type: 'boolean' } } },
    },
    checks: { type: 'string', enum: ['request_changes', 'look', 'approve'], description: 'From problem, conventions and risks only.' },
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
      "Tell the user you need them. Pass a one-line reason, or null when nothing is pending anymore. Details belong in the doc. When the user has to decide something, pass each decision in questions with your recommendation: the user sees them on a card and can accept all recommendations with one click (your chat then gets them as the user's answer). A step's developer asks the work's owner first: it answers in the developer's chat or asks the user.",
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
      "The fact of the PRs under review (a step's reviewer; the topic that owns a review of a teammate's PR): their change inventory, a flat list of what changed at the level a reviewer designs at, written from the hunks get_pr_changes lists. mag checks it against the hunks (blockers: a block of changed code in no unit and not in noise, an id that is no block, a unit whose name its hunks do not bear out, a unit on a module that owns none of its blocks, a call to a target that is no module and not external, a unit with several names, a changed method without before, after and note; warnings: code called noise, declarations no unit of their module names), generates the fact's Component and Data diagrams from it (the root of the fact set, replacing those drawn before; a method is a line 'signature - note', a call a marked line on the use of its caller to its target) and answers with the check and plan ↔ fact. Call it again with the whole inventory to fix it.",
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
              description: 'One per change. method: every function or method added, removed or changed, public and private. model / field: types of data and their fields; stored only for persisted data. index: DB indexes and unique keys. dependency: a module starts or stops using another module or system. call: a call between modules added, removed or with changed arguments, one per target method. config / template: prompts, templates, config entries whose change alters behaviour, one per constant. Mocks and test helpers are never units; a rename is one unit; one name per unit, never "a, b" or "a / b".',
              items: {
                type: 'object',
                required: ['kind', 'module', 'name', 'change', 'hunks'],
                properties: {
                  id: { type: 'string', description: 'u1, u2…; filled in when left out.' },
                  kind: { type: 'string', enum: ['method', 'model', 'field', 'index', 'dependency', 'call', 'config', 'template'] },
                  module: { type: 'string', description: 'The module of its hunks, as the listing names it; call: the module that calls.' },
                  owner: { type: 'string', description: 'method: the type, class or file it belongs to; field / index: its model.' },
                  name: { type: 'string', description: 'Copied from the diff. method / model: its name; field: "<model>.<field>"; index: its name; dependency: the module id or package used; call: "<target module id>#<method>" ("<package>#<func>" outside the project, with external); config: the constant, e.g. DEFAULT_PLAYBOOK.fact.' },
                  change: { type: 'string', enum: ['add', 'mod', 'del', 'rename'], description: 'call: add, del, or mod when its arguments change.' },
                  visibility: { type: 'string', enum: ['public', 'private'] },
                  before: { type: 'string', description: 'The old signature (field type, definition; a call as the code made it), one line; none for add. Required for a changed method.' },
                  after: { type: 'string', description: 'The new one; none for del. Required for a changed method.' },
                  from: { type: 'string', description: 'rename: the old name.' },
                  logic: { type: 'string', enum: ['none', 'trivial', 'nontrivial'], description: 'method: nontrivial when branches, loops, error handling, external calls or data access change; trivial for wiring, renames, one-liners; none when only the signature changes.' },
                  stored: { type: 'boolean', description: 'model / field: true only for persisted data (a table, collection, document, cache entry); never arguments, options or DTOs.' },
                  external: { type: 'boolean', description: 'call: its target is outside the project (a package, an outside system), no module of the architecture.' },
                  hunks: { type: 'array', items: { type: 'string' }, description: 'The blocks that change it, e.g. ["H3.1", "H4.2"]; not the other blocks of their hunks. "H3" stands for every block of H3.' },
                  note: { type: 'string', description: 'One line: what changes in meaning; shown after the signature. Required for a changed method.' },
                },
              },
            },
            noise: {
              type: 'array',
              description: 'Blocks of code that are no change of the design, with why: formatting, comments, generated code. Tests, docs and lock files need not be cited.',
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
      'Reviewer only: your review of the PRs of the step under review, once per review: the report (mag checks it against the inventory and derives the findings and the verdict from its checks: request_changes → changes, look → look, approve → merge). changes: the findings go to the developer, not GitHub; merge: ready, nothing for the user to check; look: the user should decide or check something. Without a report (older form): verdict and findings.',
    inputSchema: {
      type: 'object',
      properties: {
        report: REPORT,
        verdict: { type: 'string', enum: ['changes', 'merge', 'look'], description: 'Only without a report; with one it must match its checks.' },
        findings: { type: 'array', description: 'Only without a report: one finding per item, each with its level; none for a clean merge.', items: FINDING },
      },
    },
  },
  {
    name: 'set_pr_review',
    scope: 'task',
    description:
      "A topic that runs a review of a teammate's PR: record it into the result of its format, once you have it and again when it changes; the other format's result stays. v2 (your job says which): the report; mag checks it against the inventory, takes its checks as the verdict and derives the findings the user may publish. v1: verdict and findings, no report. It shows in the review's pane beside its conversation; nothing goes to GitHub.",
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'What the PR fixes and why it is real, with evidence (ticket, code path, logs); short.' },
        approach: { type: 'string', description: 'How the PR solves the problem and whether it does; short.' },
        report: REPORT,
        verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'], description: 'v1 only.' },
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
      "Review a teammate's PR of a project repository, by its GitHub link: mag starts (or reopens) its review, run by this topic in one format, fetches the PR and answers with the job. Do it right here, in this turn. A review keeps one result per format; the other one stays.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'https://github.com/<owner>/<repo>/pull/<n>' },
        format: { type: 'string', enum: ['v1', 'v2'], description: "v1: findings by level and a verdict; v2: the report of questions with the direction for the user. Without it: the project's setting (v2 by default)." },
      },
      required: ['url'],
    },
  },
  {
    name: 'branch_topic',
    scope: 'project',
    description:
      'Branch this topic into a new one, when the user asks to go on with a separate question there: the new topic forks your session, so it starts with everything said here, and this topic stays as it is. text, if given, is its first message: the new topic\'s agent answers it there. Answers with the new topic\'s id; the user finds it in Topics.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Optional first message of the new topic, as the user would write it.' } } },
  },
  {
    name: 'get_pr_changes',
    scope: 'task',
    reviewer: 'also',
    description:
      "The files the step's branches change against the base, any language: per module of the project's architecture that owns them, each changed code file with its hunk ids (H1…, old → new lines); tests, styles, lock files, generated code and docs listed apart. Then every hunk of code with its id, owner module, git's header and lines (three lines of context), each block of changed lines marked [H<n>.<k>]: what set_inventory cites. The reviewer gets the heads under review, numbered as mag checks them. A review of a teammate's PR: its fact at the PR's head, without a plan.",
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
    name: 'list_tasks',
    scope: 'any',
    description:
      'Works of the project: in progress, then ready, planning and finished (done, canceled; newest first); subtasks (execution steps: todo, in_progress, done) follow their task. Key, title, type, status, parent, needs_input, PRs with their state, tickets (links), cancel reason; then the project\'s ideas (text, source: where an agent found it).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_task',
    scope: 'project',
    description: 'One work or step with its document, by key (e.g. ABC-12, step ABC-12.3).',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
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
    description: 'Start a separate groomer agent on a work in planning (or re-plan a ready one not started yet): only for a work nobody planned in a conversation, e.g. one started from a ticket link. The groomer becomes its owner. It works in the background and pings the user with questions; the user approves its plan, and the work is ready to start. A work you discussed here you plan yourself.',
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
    description: `Write to an agent of a work or a step, as the user writes in its chat: its session resumes with the text (also how you answer its question). Without role: the agent that worked last. ${ASKED}`,
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
      'Show the user a visual: UI mockup, comparison, anything without a type of its own (diff diagrams go through show_diagram). Pass one self-contained HTML document (inline CSS/SVG/JS; CDN scripts from cdn.jsdelivr.net or unpkg.com are allowed). It renders in the chat and is kept with the project (and the task, in a task run). To revise, pass the id you got back: a new version replaces the old one.',
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
      'Record a typed diagram of a change; mag draws it and keeps it with the task (in a task run) or the project. One diagram per question: component when modules, their interfaces or the calls between them change; sequence for a scenario between participants (services, databases, queues, outside APIs, CLIs); state for the states of an entity; flowchart for an algorithm, with of for the logic of one method; data when stored data changes (collections, tables, fields, indexes and unique keys; each entity with module, its owner, and a relation for each reference field; never arguments of calls, interfaces or clients). Mark every changed element with diff (add, mod, del); also move, with from, for an interface method (component) or an entity or field (data) that moved or is renamed (one line, never a del and an add). Methods, calls and fields go one per line, never grouped with "/", "," or "+"; a changed one is a del line and an add line. Mocks, fakes and test-only types are never on a diagram. An interface is methods with signatures, not prose. component takes its modules from get_architecture (same ids) and needs summary: one or two sentences on what changes in substance. Unchanged neighbours without a mark give context. data gives every field on its own line; a field moved to another entity is move with from "<entity>.<field>". For a method whose non-trivial logic changes, public or private, also draw a flowchart with of, summary and changes, linked from its interface line or, for a private method, from the step of the flowchart that calls it; a new method replacing an old one sets replaces. Draw as many diagrams as the change needs, several of one type too, each a separate named diagram. Give it its place in the task: role option with option for the sketch of an option, role plan with step and repo for the change of a step (steps exist only after create_subtask: place earlier diagrams then with place_diagram). Fails with a list of errors and saves nothing when the data is wrong. A component diagram is also checked against the architecture, and the answer lists where they disagree (an id not in the architecture and not marked add, an add of a module it has, a new module without path): saved anyway, fix it or say in the doc why it is right. A new module gives path, the code it will own. To revise, pass the id you got back. The diagrams of one place (an option, a step\'s plan, a step\'s fact) are one set: mark its entry (the system level or the top component diagram) root, and link the others from modules, interface lines, uses and entities (links: to, node, kind); a flowchart\'s of counts as a logic link from its method. The answer warns where the set does not hang together (no root, a link outside the set or to a missing node, a diagram the root does not reach) and where a diagram breaks a rule of the diff (an entity without module, data that is not stored, a reference field without relation, a relation between modules not cross, mocks, a rename drawn as del and add). A fact set (the reviewer\'s of its step, a review\'s of a teammate\'s PR) takes only sequence and flowchart diagrams: mag generates its Component and Data diagrams from the change inventory (set_inventory). Draw a scenario (participants with module ids: mag links it from those modules) or the logic of a method the inventory lists with logic nontrivial (flowchart with of "<module>#<method>", the last segment of its name), without role: it joins the fact set. The answer is mag\'s check of the fact: the inventory against the hunks, links, plan ↔ fact.',
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
    name: 'approve_tool',
    scope: 'any',
    reviewer: 'also',
    description: 'Internal: mag uses this to ask the user before an integration call. Do not call it yourself.',
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

const WORK_ARG = { type: 'string', description: 'The key of the work this topic owns, e.g. ABC-12.' }

export type ToolScope = 'task' | 'project' | 'any'

/** The tools a run sees, as the MCP server lists them: by scope and role; a project chat gets the owner tools with work. */
export function toolsFor(scope: 'task' | 'project', role: string | undefined): { name: string; description: string; inputSchema: object }[] {
  const owner = scope === 'project' && role === 'chat'
  return TOOL_DEFS.filter((t) => (t.scope === 'any' || t.scope === scope || (owner && (OWNER_TOOLS as readonly string[]).includes(t.name))) && toolForRole(t, role)).map((t) => {
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
