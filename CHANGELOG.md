# Changelog

Notable changes to mag, newest first. Design decisions live in [docs/decisions](docs/decisions).

## Unreleased

### Direction
- mag becomes a workspace, not only a tool for coding agents: workspaces, labels with Project as a system label, deliverables with a publish gate, Inbox, Routines, Library, People, unified search, and a Slack-like shell. See [0001](docs/decisions/0001-mag-as-a-workspace.md) and the [presentation](docs/vision/workspace-vision.html). Planned in phases P0–P4; nothing of it has shipped yet.

### Added
- Meetings: record a call on the Mac (mic as `me`, system audio as `others`), transcribe it locally with whisper.cpp, summarize with Claude, and search across meetings. Every agent gets `search_meetings` / `read_meeting`. Files go to `~/Documents/mag/meetings` (#154, #156, #157).
- Chat message actions: rewind, edit, retry, branch from here, copy, and restoring code to a message (#153, #155, #161).
- Reviews: report as issues + evidence, acceptance criteria in planning, PRs and step reviews, the run state in one line (#164, #165, #166).
- Model catalogue: versions, effort and a per-session choice with a context gauge (#146, #147).
- Canvases embed canvases; system view for review (#145).

### Changed
- Questions and plan cards are compact: one header, a line per question or step, details folded (#159, #160, #162, #163).
- The owner hears its works: the user's Approve and the work's events go with its next message (#152).
- Integrations default to reads mode: reads run at once, posts and changes wait for the Allow.
- Worktrees live in the repository's `.mag` (#130).
