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
const LINES = (what: string) => ({
  type: 'array',
  description: `${what}. ${ONE_PER_LINE}`,
  items: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, diff: DIFF } },
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
      from: { type: 'string', description: 'With move: the id of the module it moved from, another module of this diagram.' },
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
            items: { type: 'object', required: ['to', 'calls'], properties: { to: { type: 'string' }, calls: LINES('Methods of `to` it calls'), diff: DIFF } },
          },
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
      items: { type: 'object', required: ['id', 'label', 'shape'], properties: { id: { type: 'string' }, label: { type: 'string' }, shape: { type: 'string', enum: ['start', 'step', 'decision', 'end'] }, diff: DIFF } },
    },
    edges: {
      type: 'array',
      description: 'flowchart: arrows; label the branches of a decision.',
      items: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' }, diff: DIFF } },
    },
    entities: {
      type: 'array',
      description: 'data: collections, tables, structs or types with their fields; unchanged neighbours without a mark give context.',
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
          fields: {
            type: 'array',
            description: 'One field per item, never several in one name ("a / b", "a, b"). A changed field (name or type) is the old one del and the new one add; a field moved from another entity is move with from.',
            items: {
              type: 'object',
              required: ['name', 'type'],
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                note: { type: 'string' },
                diff: DATA_DIFF,
                from: { type: 'string', description: 'With move: "<entity id>.<field>" it moved from, a field of another entity of this diagram.' },
              },
            },
          },
        },
      },
    },
    relations: {
      type: 'array',
      description: 'data: links between entities. A relation pointed elsewhere is the old one del and the new one add.',
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
        },
      },
    },
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
    description: 'Tell the user you need them. Pass a one-line reason, or null when nothing is pending anymore. Details belong in the doc.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: ['string', 'null'] } },
      required: ['reason'],
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
    name: 'set_review',
    scope: 'task',
    reviewer: 'only',
    description:
      'Reviewer only: your verdict on the PRs of the step under review, once per review. changes: the developer must fix the findings first (they go to the developer, not GitHub); merge: ready, nothing for the user to check; look: the user should decide or check what the findings say.',
    inputSchema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['changes', 'merge', 'look'] },
        findings: {
          type: 'array',
          description: 'One finding per item; none for a clean merge.',
          items: {
            type: 'object',
            required: ['text'],
            properties: { text: { type: 'string' }, where: { type: 'string', description: 'file:line, a module or a PR, when it applies.' } },
          },
        },
      },
      required: ['verdict', 'findings'],
    },
  },
  {
    name: 'get_pr_changes',
    scope: 'task',
    reviewer: 'also',
    description:
      "The structural diff of the step's branches against the base, computed from the code, not drawn: per module of the project's architecture, the added, removed, changed and moved symbols with old and new signatures, contracts (tool definitions and other arrays of named items), new and removed dependencies between modules, and the changed files. Check every change against the plan; 'NOT deterministic' lists files of languages it cannot read.",
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
    description:
      'Record a typed diagram of a change; mag draws it and keeps it with the task (in a task run) or the project. One diagram per question: component when modules, their interfaces or the calls between them change; sequence for a scenario between participants (services, databases, queues, outside APIs, CLIs); state for the states of an entity; flowchart for an algorithm, with of for the logic of one method; data when the data schema changes (collections, tables, fields, core model types, file or API payload formats). Mark every changed element with diff (add, mod, del); also move, with from, for an interface method (component) or an entity or field (data) that moved. Methods, calls and fields go one per line, never grouped with "/", "," or "+"; a changed one is a del line and an add line. An interface is methods with signatures, not prose. component takes its modules from get_architecture (same ids) and needs summary: one or two sentences on what changes in substance. Unchanged neighbours without a mark give context. data gives every field on its own line; a field moved to another entity is move with from "<entity>.<field>". For a method whose non-trivial logic changes, also draw a flowchart with of, summary and changes; a new method replacing an old one sets replaces. Draw as many diagrams as the change needs, several of one type too, each a separate named diagram. Give it its place in the task: role option with option for the sketch of an option, role plan with step and repo for the change of a step (steps exist only after create_subtask: place earlier diagrams then with place_diagram). Fails with a list of errors and saves nothing when the data is wrong. To revise, pass the id you got back.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        diagram: DIAGRAM,
        id: { type: 'string', description: 'Existing diagram id to revise.' },
        ...PLACEMENT,
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
 * Task tools a project chat also gets for the works it owns (T-55.5): it plans them itself instead of a groomer. In a
 * chat they take work, the key of the work; show_diagram and show_canvas take it optionally (without it, the drawing is the project's).
 */
export const OWNER_TOOLS = ['get_diagrams', 'place_diagram', 'update_doc', 'set_needs_input', 'create_subtask', 'update_subtask', 'delete_subtask', 'reorder_subtasks', 'show_diagram', 'show_canvas'] as const

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
