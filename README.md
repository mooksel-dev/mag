# mag

Task-centric workspace for AI coding agents. The unit of work is a project and its tasks, not a chat session.
Agents (Claude Code now, others later) groom tasks in the background, ask for input when they need it,
and the project home shows only what is waiting on you.

Domain: `mag.moodel.dev`

## Layout

```
apps/
  poc/        Electron + React playground. Ideas get tried here first.
  desktop/    (later) production desktop app
  web/        (later) web app
packages/
  core/       Domain model: Project, Task, AgentSession, AgentEvent, plan rules, doc templates
  agents/     Agent adapters. Claude Code via `claude -p --output-format stream-json`
  arch/       Import-based layering rule checker behind check_architecture
```

Everything is TypeScript. Workspace packages ship sources (`exports: ./src/index.ts`) and are bundled by each app.

## Run the PoC

Requirements: Node 22+, pnpm 10 (`corepack enable`), Claude Code CLI logged in.

```sh
pnpm install
pnpm poc
```

If the app can't find `claude`, start it with `MAG_CLAUDE_BIN=/path/to/claude pnpm poc`.

## What the PoC does

1. Create a project, attach repositories (Settings).
2. Add tasks to the backlog (Plan tab).
3. **Groom** a task: Claude Code runs in the background in the first repo (read-only tools),
   writes the task document and either asks for input or marks the task groomed. A task with several steps gets
   subtasks: a short checklist of the plan (title + optional note, todo/done), with no doc, agent or PR of their own.
4. **Needs you** lists tasks waiting on you. Open one, answer in the chat; the agent updates the doc.
5. **Add to plan** puts a groomed task at the end of the plan; reorder not-started tasks with ▲▼.
   Only top-level tasks enter the plan, and only when groomed with nothing pending.
6. The plan runs top to bottom, **one task at a time**; the next one starts only after every PR of the previous one is merged.
   One developer session owns a task from start to merge. Its cwd is the task dir (`worktrees/<projectId>/<key>/`), with a
   git worktree per project repository (`<task dir>/<repo-name>/`, branch `mag/<key>-<title>` from the base branch).
   It implements, tests, self-reviews, ticks the subtasks with `check_subtask`, pushes and opens one PR per changed repo
   with `gh`, recording each with `set_pr`. Once every repo with commits has a PR, the task moves to review.
7. Every minute the app checks the PRs of tasks in review: all merged → task done and worktrees removed; one closed
   without merge → back to in progress with a note; new comments on any of them → the same developer session is resumed
   with them. You merge; agents never do.

### Architecture

Apps follow one layout: `core/lib` (project libraries), `core/clients` (one per other runtime: APIs, DBs, queues),
`core/services` (business logic, one area each), and the app layer on top (React, handlers, workers...).
Services never use services, clients never use clients or services, lib never uses clients or services,
core never uses the app layer. With **Enforce core architecture** on (default for new projects), groomers design
changes per layer with service interfaces first, and developers must pass `check_architecture` before a PR.
The **Architecture** tab is drawn by an AI architect: **Analyze with AI** runs a read-only agent over the repo, which
classifies modules into these layers (whatever the folders are called), writes their interfaces and concerns, and saves
the result via `set_architecture`. The app only renders it: lanes per layer, `uses` as arrows, layering breaks in red.
It re-runs after every merged PR once a diagram exists.

Developer agents need `git` and an authenticated `gh` CLI. Worktrees live in userData/worktrees.

### Project chat

The **Chat** panel sits next to every tab: a free conversation about the project, one or more threads per project.
The agent reads the code and the web but never edits code; decisions become tasks (`create_task`, `start_grooming`;
a task already fully discussed can go straight to the end of the plan with `create_task` + `doc` + `plan: true`),
notes (`update_notes`) or task-doc changes. Paste screenshots or drop files into any chat (task chats too); they are
copied to userData/attachments and handed to the agent as paths. Agents draw mockups and diagrams with `show_canvas`:
self-contained HTML rendered in a sandboxed iframe in the chat, kept with the project and the task.

### How the agent talks to the app

The app knows only task metadata. Content lives in an agent-written markdown doc.
Each run gets a stdio MCP server (`src/main/task-mcp.ts`, server name `mag`). Task runs (groomer, developer) get:

| Tool | Purpose |
| --- | --- |
| `get_task` | Task, subtask checklist, project repos, work (task dir; per repo worktree, branch, PR), doc template |
| `get_doc` / `update_doc` | Read / replace the task document |
| `set_needs_input` | One-line reason shown in Needs you, or `null` |
| `mark_groomed` | No open questions left, plan ready |
| `create_subtask` | Groomer: add a checklist step (title, optional note) |
| `update_subtask` / `delete_subtask` / `reorder_subtasks` | Groomer: change the checklist when re-grooming |
| `check_subtask` | Developer ticks (or unticks) a step |
| `set_pr` | Developer records the PR of one repo; the task moves to review once every changed repo has one |
| `check_architecture` | Programmatic rule check (imports between layers) of the working copy |
| `get_architecture` | The project's architecture diagram |
| `list_tasks` | All tasks of the project |
| `show_canvas` | Show an HTML mockup/diagram; revise by id |

Project chats and the architect get `list_tasks`, `read_task`, `create_task`, `update_task`, `update_task_doc`,
`start_grooming`, `update_notes`, `run_architect`, `show_canvas` and the architecture tools.

The MCP server forwards calls to a localhost endpoint in the main process (random port + token).

Data lives in Electron's userData folder (`db.json`, `runs/`).

## Not in the PoC yet

- Separate reviewer agents before the PR (now the developer self-reviews)
- Mermaid rendering in docs, doc version diffs
- Notifications, other agents (Codex), Flow view of the plan
