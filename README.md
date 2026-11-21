# mag

Task-centric workspace for AI coding agents. The unit of work is a project and its tasks, not a chat session.
Agents (Claude Code now, others later) groom tasks in the background, ask for input when they need it,
and the project home shows only what is waiting on you.

**Direction.** mag is becoming a workspace for any kind of work, not only code: workspaces, labels with Project as a
system label, deliverables with a publish gate, Inbox, Routines, Library, People, unified search and a Slack-like shell.
It is decided in [docs/decisions/0001](docs/decisions/0001-mag-as-a-workspace.md), shown for users in
[docs/vision](docs/vision/workspace-vision.html), and is being built in phases. This README describes what ships today;
[CHANGELOG.md](CHANGELOG.md) tracks what changed.

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
  diff/       Architecture diff, any language: the files a PR changes by owner module with numbered hunks (get_pr_changes), the change inventory checked against them (the review), the changes a plan or fact diagram draws, plan ↔ fact
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
2. Start a work from the field at the top of the work list (the left column): words open a topic that discusses the
   problem, creates the work and plans it with you; a ticket link opens a topic about that ticket; a GitHub PR link
   reviews a teammate's PR. A work also starts from an idea (Project ▾ → Ideas).
   Work states: `planning` → `ready` (you approved the plan) → `in_progress` → `done`, plus `canceled` before done; a
   done work can be continued (back to `planning`). mag has no backlog, priority or archive: what nobody works on yet
   is an idea, priority lives in your tracker. A work's key is its first ticket's key (`ABC-12`) or a slug of its
   title (`fix-login`); works from before have `T-12`.
3. **Groom** a task: Claude Code runs in the background in the first repo (read-only tools),
   writes the task document and either asks for input or marks the task groomed. A task with several steps gets
   subtasks: a short checklist of the plan (title + optional note, todo / in progress / done), with no doc, agent or
   PR of their own.
4. The project window has three columns: the work list (waiting on you, agents working, planning · ready, topics
   without a work, done in 7 days), the open work's conversation with its owner, and the artifact pane (Diff, Doc,
   Steps, Agents; a review's page for a review). You talk to the owner only: what needs you comes as cards at the end
   of the conversation (questions with the agent's recommendations and **Accept recommendations**, the plan with
   **Approve & Start**, the merge, a failed agent or check). The chats of groomers, developers and reviewers are logs
   under Agents, with Stop and Restart; the owner passes things on to them.
5. **Approve & Start** approves a planned work and starts its first step.
6. Todo runs top to bottom, **one task at a time**; the next one starts when no task is in progress.
   One developer session owns a task from start to merge. Its cwd is the task dir (`worktrees/<projectId>/<key>/`), with a
   git worktree per project repository (`<task dir>/<repo-name>/`, branch `mag/<key>-<title>` from the base branch).
   It implements, tests, self-reviews, marks the subtasks in progress and done with `set_subtask_status`, pushes and
   opens one PR per changed repo with `gh`, recording each with `set_pr`. An open PR is a badge on the task.
7. Every minute the app checks the open PRs of tasks in progress: all merged (and no repo with commits left without
   one) → task done and worktrees removed; one closed without merge → a note for you; new comments on any of them →
   the same developer session is resumed with them. You merge; agents never do.
8. **Cancel** stops a work's agent and removes its worktrees (open PRs stay; close them on GitHub).

### Architecture

Apps follow one layout: `core/lib` (project libraries), `core/clients` (one per other runtime: APIs, DBs, queues),
`core/services` (business logic, one area each), and the app layer on top (React, handlers, workers...).
Services never use services, clients never use clients or services, lib never uses clients or services,
core never uses the app layer. With **Enforce core architecture** on (default for new projects), groomers design
changes per layer with service interfaces first, and developers must pass `check_architecture` before a PR.
The **Architecture** tab is drawn by an AI architect: **Analyze with AI** runs a read-only agent over the repo, which
classifies modules into these layers (whatever the folders are called), writes their interfaces and concerns, and saves
the result via `set_architecture`. The app only renders it: lanes per layer, `uses` as arrows, layering breaks in red.
Each module has a `level` (system: apps and outside runtimes; module: their parts) and `paths`, the code it owns; every
code file must be in exactly one module (the most specific path wins), and `set_architecture` lists the files left
over. A module that owns the same code under a new id gets its previous id back, so diagrams and diffs keep pointing at it.
It re-runs after every merged PR once a diagram exists.

Developer agents need `git` and an authenticated `gh` CLI. Worktrees live in userData/worktrees.

### Project chat

The **Chat** panel sits next to every tab: a free conversation about the project, one or more threads per project.
The agent reads the code and the web but never edits code; decisions become works (`create_work`, planned right in the chat;
a work already fully discussed can go straight to ready with `create_work` + `doc` + `plan: true`),
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
| `create_subtask` | Groomer: add a checklist step (title, optional note) |
| `update_subtask` / `delete_subtask` / `reorder_subtasks` | Groomer: change the checklist when re-grooming |
| `set_subtask_status` | Developer marks a step `in_progress` / `done` (or back to `todo`); one in progress at a time. `check_subtask` is a deprecated alias |
| `set_pr` | Developer records the PR of one repo; once every changed repo has one, the task waits for your merge |
| `check_architecture` | Programmatic rule check (imports between layers) of the working copy |
| `get_architecture` | The project's architecture diagram |
| `list_tasks` | All tasks of the project |
| `show_canvas` | Show an HTML mockup/diagram; revise by id |
| `add_idea` | Any agent: put a finding outside its scope on the project's ideas instead of doing it |

Project chats and the architect get `list_tasks`, `read_task`, `create_work`, `reopen_work`, `add_ticket`, `update_task`,
`update_task_doc`, `start_grooming`, `cancel_task` (after asking you), `list_chats`, `close_chats` / `restore_chat`
(when you ask) and `delete_chats` (after asking you), `update_notes`, `run_architect`,
`show_canvas` and the architecture tools. A project chat owns the works it creates and plans them itself: it also gets
the step and diagram tools (`create_subtask`, `place_diagram`, `get_diagrams`…) with a `work` argument, the key of a work
it owns. A separate groomer runs only when you ask for one (Groom, or asking a chat). A ticket is only a
link (`Task.tickets`); agents read trackers through whatever the user's environment has (MCP, CLI).

Ideas (Project ▾ → Ideas) are a plain list without status: the user's notes and agents' `add_idea` findings. Start work opens a new
topic with the idea, which leaves the list. A done work that needs more is continued, not duplicated: `reopen_work` in a
chat, or Continue on the work, puts it back in planning (its done steps stay) and its owner adds steps.

The MCP server forwards calls to a localhost endpoint in the main process (random port + token).

Data lives in Electron's userData folder (`db.json`, `runs/`).

### Meetings

**Record call** in the sidebar, or ⌥⇧⌘R, records the mic as `me` and the system audio as `others`. A Swift helper does
the capture through a Core Audio process tap (macOS 14.2+). whisper.cpp transcribes locally, and no audio is kept. On
stop, Claude writes the summary. Each meeting is a folder in `~/Documents/mag/meetings/YYYY/MM/<id>/`
(`transcript.md`, `summary.md`, `meta.json`) with a derived full-text index, `.index.sqlite`, next to them. Delete a
folder to delete a meeting. Every agent can use `search_meetings` and `read_meeting`.

## Not in the PoC yet

- Separate reviewer agents before the PR (now the developer self-reviews)
- Mermaid rendering in docs, doc version diffs
- Notifications, other agents (Codex), Flow view of the plan
