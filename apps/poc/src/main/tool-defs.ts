// Tools the MCP server exposes to agents. Schemas only; handlers live in tools.ts.
// scope: 'task' = runs bound to a task (groomer, developer, tracker), 'project' = project chat and architect, 'any' = both.
// tracker: the tracker role sees only tools marked 'only' (its own) or 'also'; the other roles all but 'only'.

/** One module of set_architecture. `children` items are described in words, not by $ref: not every agent follows it. */
const ARCH_MODULE = {
  type: 'object',
  required: ['id', 'name', 'description', 'uses'],
  properties: {
    id: { type: 'string', description: 'kebab-case, unique in the whole tree, stable across runs' },
    name: { type: 'string' },
    kind: { type: 'string', description: 'Top level: Electron app, React web, HTTP API, worker, database, 3rd-party API, CLI…' },
    layer: { type: 'string', enum: ['app', 'service', 'client', 'lib'], description: 'Modules inside an app.' },
    path: { type: 'string' },
    description: { type: 'string', description: 'One or two sentences of responsibility.' },
    interface: { type: 'array', items: { type: 'string' }, description: 'Public methods: "name(args): Result - what it does". Key for services and clients.' },
    uses: {
      type: 'array',
      description: 'Real dependencies on any module of the tree.',
      items: {
        type: 'object',
        required: ['to', 'calls'],
        properties: {
          to: { type: 'string', description: 'Id of the module it uses.' },
          calls: { type: 'array', items: { type: 'string' }, description: 'Methods of `to` it calls, e.g. "groom(taskId)".' },
        },
      },
    },
    concern: { type: 'string', description: 'One line if it breaks the layering or smells.' },
    children: { type: 'array', items: { type: 'object', description: 'An inner module with the same fields, children included.' }, description: 'Inner modules of a big module.' },
  },
}

const DIFF = { type: 'string', enum: ['add', 'mod', 'del'], description: 'Change: add, mod or del. Leave it out for unchanged context.' }
const LINES = (what: string) => ({
  type: 'array',
  description: `${what}. A plain string is an unchanged line; a changed line is the old one del and the new one add.`,
  items: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, diff: DIFF } },
})

/** The data of show_diagram; one shape per type, fields of the other types are left out. */
const DIAGRAM = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['component', 'sequence', 'state', 'flowchart'] },
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
          interface: LINES('Public methods "name(args): Result - what it does"'),
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
  },
}

export const TOOL_DEFS = [
  {
    name: 'get_task',
    scope: 'task',
    description:
      'Get the current task: title, type, status, description, subtasks (its steps in order, with status, startManually, PRs and current: true on the step being worked on), project repos, the work (your step\'s dir and per repo: worktree, branch, PR) and the doc template for this task type.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_doc',
    scope: 'task',
    description: 'Read the current task document (markdown).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_diagrams',
    scope: 'task',
    description: 'The diagrams of this task with their data: the target picture of the change (component, sequence, state, flowchart) with diff marks.',
    inputSchema: { type: 'object', properties: {} },
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
    name: 'mark_groomed',
    scope: 'task',
    description:
      'Mark the task as groomed: no open questions left, plan and steps ready. It goes to todo, ready for the user to start. When re-grooming the remaining steps of a task in progress, the task continues with its current step. Fails while needs_input is set or without steps.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_subtask',
    scope: 'task',
    description:
      'Groomer only: add an execution step to the current task: a short title and an optional one-line note saying what ships in it. Each step runs in its own developer session from fresh base, with at most one PR per changed repo; steps run in order, kept in creation order.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        note: { type: 'string', description: 'Optional one line; the task doc carries the details.' },
        start_manually: { type: 'boolean', description: 'The step waits for the user to press Start instead of starting when the previous one is done (releases in parts).' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_subtask',
    scope: 'task',
    description: 'Groomer only: change the title, note or start_manually of a step while re-grooming. In remaining mode done steps are locked.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        title: { type: 'string' },
        note: { type: 'string' },
        start_manually: { type: 'boolean' },
      },
      required: ['key'],
    },
  },
  {
    name: 'delete_subtask',
    scope: 'task',
    description: 'Groomer only: remove a step that is no longer needed. In remaining mode only todo steps can be removed.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'reorder_subtasks',
    scope: 'task',
    description: 'Groomer only: set the order of the steps. Pass every step key of the current task, in the new order. In remaining mode done steps and the current one keep their places at the front.',
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
    name: 'get_import',
    scope: 'task',
    tracker: 'only',
    description: 'Tracker only: the ticket to import into this task: key, url (null only for an old import by key) and kind (jira or linear).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_brief',
    scope: 'task',
    tracker: 'only',
    description:
      'Tracker only: write what you read from the ticket into the task: its title and the brief (markdown) the groomer starts from. Call it once, at the end. Pass url when get_import had none.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "The ticket's summary." },
        brief: { type: 'string', description: 'Markdown brief: description, comments, attachments, subtasks, linked tickets and pages.' },
        url: { type: 'string', description: "The ticket's web link; only when get_import returned url: null." },
      },
      required: ['title', 'brief'],
    },
  },
  {
    name: 'check_architecture',
    scope: 'any',
    description: 'Analyze the code in your working copy: layers (app, services, clients, lib), service/client interfaces and import rule violations. Developers must have zero violations before opening a PR.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_architecture',
    scope: 'any',
    description: 'Get the recorded architecture of this project, if any: a tree of modules (apps and outside runtimes on top, layered modules inside) with interfaces and the calls between them.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_architecture',
    scope: 'project',
    description:
      'Record the architecture of the project as a tree of modules. Replaces the previous one. Top level: apps and outside runtimes (database, 3rd-party API, agent CLI…); inside an app: modules by layer (app, service, client, lib), nested as deep as it helps.',
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
      'Tasks of the project, archived ones left out: in progress, then todo by priority, then grooming, backlog and recently finished (done, canceled); subtasks (execution steps: todo, in_progress, done) follow their task. Key, title, type, status, parent, needs_input, PRs with their state, cancel reason.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_task',
    scope: 'project',
    description: 'One task with its document, by key (e.g. T-12, subtask T-12.3).',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'create_task',
    scope: 'project',
    description:
      'Add a task to the backlog. The description is the brief the groomer starts from: what and why, concise. ' +
      'doc pre-fills the task document. plan: true puts the task in todo (lowest priority) and starts nothing; the user starts it. Use it ' +
      "only when the doc is complete (follow the project's doc template) and the user asked for it; it needs steps.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: ['dev', 'design', 'spike', 'research'] },
        description: { type: 'string' },
        doc: { type: 'string', description: 'Task document (markdown). Required with plan: true.' },
        plan: { type: 'boolean', description: 'Skip grooming and put the task in todo; the user starts it.' },
        ticket_url: { type: 'string', description: 'Jira or Linear ticket URL to link the task to (no import). Fails, creating nothing, when the ticket is linked to another task.' },
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
      required: ['title', 'type', 'description'],
    },
  },
  {
    name: 'link_ticket',
    scope: 'project',
    description:
      'Link a top-level task to a Jira or Linear ticket by its URL, replacing its link if any. Only a link: nothing is imported and the brief stays. ' +
      'Fails when the URL is not a ticket link or the ticket is linked to another task.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, url: { type: 'string' } }, required: ['key', 'url'] },
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
    description: 'Start the groomer agent on a backlog task (or re-groom a todo task not started yet). It works in the background and pings the user with questions; when done, the task goes to todo, ready for the user to start.',
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
    name: 'archive_task',
    scope: 'project',
    description: 'Archive a done or canceled task: it leaves the Active view and keeps its status. The user can restore it.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
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
      'Record a typed diagram of a change; mag draws it and keeps it with the task (in a task run) or the project. One diagram per question: component when modules, their interfaces or the calls between them change; sequence for a scenario between participants (services, databases, queues, outside APIs, CLIs); state for the states of an entity; flowchart for an algorithm. Mark every changed element with diff (add, mod, del); unchanged neighbours without a mark give context. Fails with a list of errors and saves nothing when the data is wrong. To revise, pass the id you got back.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        diagram: DIAGRAM,
        id: { type: 'string', description: 'Existing diagram id to revise.' },
      },
      required: ['title', 'diagram'],
    },
  },
  {
    name: 'approve_tool',
    scope: 'any',
    tracker: 'also',
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

export type ToolScope = 'task' | 'project' | 'any'

/** Whether a run of `role` (undefined: unknown, as before roles were passed) gets the tool. */
export function toolForRole(def: { name: string; tracker?: 'only' | 'also' }, role: string | undefined): boolean {
  const tracker = 'tracker' in def ? def.tracker : undefined
  return role === 'tracker' ? !!tracker : tracker !== 'only'
}
export type ToolName = (typeof TOOL_DEFS)[number]['name']
