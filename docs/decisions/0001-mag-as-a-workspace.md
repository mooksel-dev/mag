# 0001. mag is a workspace, not only a tool for coding agents

- Status: accepted, 2026-11-21
- Work: `mag-as-the-user-s` (direction), phases planned as separate works (below)
- User-facing presentation: [docs/vision/workspace-vision.html](../vision/workspace-vision.html)

## Context

mag knows one kind of done, a merged PR. Real usage (165 sessions, 48 works) shows that most topics aren't code: inbound requests, reports, assessments, proposals, PRD reading, reviews of teammates' PRs. They ran as bare chats with no state, no final version and no review loop. Agents posted outside mag (GitHub, Slack) without a preview. Rules for recurring reports lived in Claude Code memory files outside mag. Agents re-asked who is who in every topic. On the technical side, a project is the only container and it owns repos, `read_chat` refuses other projects, and the whole state, chat history included, sits in one 7.7 MB JSON file. That file is rebroadcast to every window on every streamed item and written non-atomically.

This isn't about one role. A developer ends up with more code deliverables, a manager with more documents and decisions; the mechanics are the same.

## Decision

1. **Workspaces** (e.g. Aura, Personal) are the top level, each with its own settings, knowledge, directories, people, repos and labels, and a user profile (role and how the user works) that agents read. mag's prompts assume no role. A workspace is a default scope, not a wall: on the user's ask any agent reads and searches other workspaces.
2. **Everything that classifies an item is a label, as in Linear.**
   - Labels sit in groups, and a group is exclusive (0..1 per item) or multi (0..n). Each workspace defines its own.
   - **System labels** carry settings and behaviour. The first is **Project**: exclusive, a namespace with or without code. It can carry repos, a Jira project, channels, playbook/template/knowledge overrides and routines, and settings resolve workspace → project → the work's decisions. Milestone and others are added only when needed.
   - Labels carry match rules (repo, ticket key, channel), so mag labels items itself, from the item and never from a person.
   - There is no Team entity, because contribution is fluid. A team is at most a label, and where a person works is derived from activity.
3. **Repos belong to the workspace.** Code doesn't need a project (a quick prototype), and a project doesn't need code.
4. **Deliverable is the one model for results.** A code change is one kind (plan ↔ fact review, PR, merge). Others (report, assessment, proposal/decision, reply, ticket) go draft → verify (claims checked against their sources) → the user's review → publish/final, with versions and one final.
5. **Publish gate.** Every outbound write asks by default with a faithful preview; it never denies, so nothing the CLI can do is taken away. Auto is opt-in per destination.
6. **Workspace sections:** Inbox (what waits on the user; an item becomes a topic only when opened), Meetings, Routines (scheduled drafts with editable rules), Library (a view over final deliverables and decisions), People (who is who from directories; the user's notes stay local), and unified search.
7. **UI shell like Slack:**
   - a rail of sections;
   - a resizable topics column grouped by Project;
   - a workspace dropdown;
   - several workspace windows at once;
   - canvases still pop out.

   Topics stay the main working unit.
8. **Storage:**
   - state goes to SQLite;
   - human content is markdown under `~/Documents/mag/<workspace>/`;
   - one derived full-text index;
   - session history no longer goes into the state broadcast;
   - atomic writes with rotated backups.

## Rejected

- **Teams first** (each team holds people, projects, routines). It forces a re-org, personal items don't fit, and it breaks when teams shuffle.
- **Stream first with standing agents.** It loses mag's plan depth, drifts toward a Slack client, carries autonomy, privacy and token costs, and conflicts with "topics are made only by the user". Its Inbox and a triager that never creates topics are kept.
- **Separate project and label concepts.** That gives two models for one need; Project as a system label replaces both.

## Consequences

- Delivered in phases, each its own work, each PR leaving the app working:

  | Phase | Works |
  |---|---|
  | P0 | `p0-fast-safe-store-no`: broadcast without history, atomic writes, then SQLite |
  | P1 | `design-system-refresh-tokens-icon`, `workspaces-and-labels-project-as`, `slack-like-shell-rail-resizable`, `publish-gate-for-every-outbound`, `inbox-what-waits-on-me`, `deliverables-library-claims-review-and` |
  | P2 | `routines-scheduled-drafts-and-a` |
  | P3 | `who-is-who-people-from` (person pages and 1:1 deferred) |
  | P4 | `unified-search-across-the-workspace` |
- Today's four projects migrate to Project labels in two workspaces with their settings intact.
- Anti-goals:
  - no databases or manual tagging;
  - no own tracker (Jira stays);
  - no meeting bot;
  - no people scoring;
  - no auto-send;
  - no auto-created topics;
  - no mirror of Slack or email;
  - nothing hard-wired to a role.
