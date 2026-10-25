// Tools the MCP server exposes to agents. Schemas only; handlers live in tools.ts.
// scope: 'task' = runs bound to a task (groomer, developer), 'project' = project chat and architect, 'any' = both.
export const TOOL_DEFS = [
  {
    name: 'get_task',
    scope: 'task',
    description: 'Get the current task: title, type, status, description, parent (with its doc, for a subtask), subtasks in order (with their docs), project repos and the doc template for this task type.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_doc',
    scope: 'task',
    description: 'Read the current task document (markdown).',
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
    description: 'Mark the task as groomed: no open questions left, plan and context ready. Fails while needs_input is set.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_subtask',
    scope: 'task',
    description:
      'Groomer only: add a subtask to the current task, with its own short doc. One subtask = one PR. Subtasks run in creation order; they are not groomed separately.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: ['dev', 'design', 'spike', 'research'] },
        description: { type: 'string' },
        doc: { type: 'string', description: 'Markdown doc of the subtask: what this part changes and how to check it.' },
      },
      required: ['title', 'type', 'description', 'doc'],
    },
  },
  {
    name: 'update_subtask',
    scope: 'task',
    description: 'Groomer only: change a subtask of the current task (title, type, brief or doc) while re-grooming.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        title: { type: 'string' },
        type: { type: 'string', enum: ['dev', 'design', 'spike', 'research'] },
        description: { type: 'string' },
        doc: { type: 'string' },
      },
      required: ['key'],
    },
  },
  {
    name: 'delete_subtask',
    scope: 'task',
    description: 'Groomer only: remove a subtask of the current task that is no longer needed.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'reorder_subtasks',
    scope: 'task',
    description: 'Groomer only: set the execution order of the subtasks. Pass every subtask key of the current task, in the new order.',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'array', items: { type: 'string' } } },
      required: ['keys'],
    },
  },
  {
    name: 'set_pr',
    scope: 'task',
    description: 'Developer only: record the pull request you opened for this task. Moves the task to review.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
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
    description: 'Get the recorded architecture of this project (apps, layers, modules, interfaces, dependencies), if any.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_architecture',
    scope: 'project',
    description: 'Record the architecture of the project. Replaces the previous one. Every app lists its nodes by layer (app, service, client, lib).',
    inputSchema: {
      type: 'object',
      required: ['summary', 'apps'],
      properties: {
        summary: { type: 'string', description: 'Two or three sentences about the whole system.' },
        apps: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'nodes'],
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              kind: { type: 'string', description: 'e.g. Electron app, React web, HTTP API, worker, library' },
              nodes: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'name', 'layer', 'description', 'uses'],
                  properties: {
                    id: { type: 'string', description: 'kebab-case, unique within the app, stable across runs' },
                    name: { type: 'string' },
                    layer: { type: 'string', enum: ['app', 'service', 'client', 'lib'] },
                    path: { type: 'string' },
                    description: { type: 'string', description: 'One or two sentences of responsibility.' },
                    interface: { type: 'array', items: { type: 'string' }, description: 'Public methods: "name(args): Result - what it does". Key for services and clients.' },
                    uses: { type: 'array', items: { type: 'string' }, description: 'Ids of nodes in the same app it depends on.' },
                    concern: { type: 'string', description: 'One line if it breaks the layering or smells.' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'list_tasks',
    scope: 'any',
    description: 'All tasks of the project: the plan in execution order, then the backlog; subtasks follow their task. Key, title, type, status, parent, needs_input.',
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
    description: 'Add a task to the backlog. The description is the brief the groomer starts from: what and why, concise.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: ['dev', 'design', 'spike', 'research'] },
        description: { type: 'string' },
      },
      required: ['title', 'type', 'description'],
    },
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
    description: 'Start the groomer agent on a backlog task. It works in the background and pings the user with questions.',
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
      'Show the user a visual: UI mockup, diagram, comparison, flow. Pass one self-contained HTML document (inline CSS/SVG/JS; CDN scripts from cdn.jsdelivr.net or unpkg.com are allowed). It renders in the chat and is kept with the project (and the task, in a task run). To revise, pass the id you got back: a new version replaces the old one.',
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
] as const

export type ToolScope = 'task' | 'project' | 'any'
export type ToolName = (typeof TOOL_DEFS)[number]['name']
