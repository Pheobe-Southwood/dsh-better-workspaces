# 0004. Worktree branch semantics: base selection, mnemonic placeholder, first-message LLM rename

Date: 2025-09-08 (v1, after first browser acceptance)

## Context

The v1 hero flow let the user pick a branch and treated the pick as a
**checkout target**, and creation only fired when the user re-opened the
branch dropdown and clicked an item. The staging trigger's default label
(`分支: main`) looked like a completed choice, so users started chatting in
the *original* session — cwd unchanged — and every session on that working
tree saw the same diff. Two design errors compounded:

1. **Dead-end staging**: a visible "selection" that triggers nothing.
2. **Wrong branch semantics**: checking out the picked branch conflicts with
   git's one-worktree-per-branch rule exactly for the default choice (the
   default branch is checked out in the primary worktree), and does not match
   the reference implementation users compare against.

Paseo's verified behavior (reference source, `packages/server`):

- `resolve-worktree-creation-intent.ts`: no explicit action ⇒ **branch-off**;
  `refName` is the *base*, `branchName ?? worktreeSlug ?? "worktree"` is the
  new branch — a picked branch is never a checkout in the default flow.
- `worktree-core.ts` + app UI: the placeholder branch name is a mnemonic id
  (`createNameId()` from `mnemonic-id`), generated **client-side** and sent
  with the creation request.
- `workspace-auto-name.ts` / `paseo-worktree-service.ts` /
  `worktree-branch-name-generator.ts`: the session's **first agent context**
  triggers one LLM call producing `{title, branch}`; guards are metadata
  `firstAgentBranchAutoName.status === 'pending'` (v2 metadata, written at
  creation for branch-off), current branch still equals the recorded
  placeholder, and a one-shot `attempted` mark written *before* the model
  call; success applies `git branch -m` and notifies git mutation.
- `protocol/branch-slug.ts`: branch slugs are `[a-z0-9-/]`, ≤100, no
  leading/trailing/consecutive hyphens; collisions take `-2..-50` suffixes.

DSH-side capability check (all verified against the live deployment):
`ctx.llm.stream(options)` is callable from host plugins (the
`dsh-session-title-llm` package is the canonical call pattern:
`{provider, model, messages, system, maxTokens, sessionId, purpose, signal}`
→ chunks `text-delta`/`finish`); `ctx.agentDefaultModel.currentSelection()`
yields `{provider, model}`; `ctx.on('session/event', (session, event))`
carries genuine human messages as `event.type === 'user/message'` with
`event.data.source.kind === 'user'` and text blocks in `event.data.content`;
`session.header.cwd` gives the directory.

## Decision

Adopt paseo semantics in two phases.

**Phase A (client, hot-reloaded):**

- Mode menu: `本地` / `新建 worktree` (creates **immediately** from the
  default base) / `新建 worktree（选基分支）…` (staging).
- Branch-list picks are **bases**: always `intent: 'branch-off'`; the UI no
  longer sends `checkout` (the host API keeps the capability).
- The client generates the mnemonic slug (`adj-noun-hhhh`, embedded word
  lists — the bundle cannot import host modules) and sends it with every
  creation; it seeds the worktree directory and, on new-enough hosts, the
  placeholder branch.
- Staging trigger relabeled `基于: {branch}` — no false "selected" state.

**Phase B (host, effective after the next `dsh` restart — ADR 0003):**

- `createWorktree` branch-off without an explicit `branchName` cuts the
  placeholder from the slug (server-side mnemonic fallback) and records
  `autoName: {status: 'pending', placeholder}` in `worktree.json` (additive
  field, metadata stays version 1; explicit names record `ineligible`).
- `autoname.js` subscribes to `session/event` and runs the ported guard
  chain: genuine first user message, non-subagent session, cwd under the
  worktrees root, `pending` status, current branch still == placeholder.
  The `attempted` mark is written **before** the model call (one-shot even on
  failure, paseo parity). Naming uses `llm.stream` with the
  `agentDefaultModel` route, a 20 s budget, 64 max tokens, a ported
  branch-slug contract prompt (prompt-as-material-only, English output), and
  a hand-rolled delta collector. Output goes through `cleanBranchName` →
  `validateBranchSlug` → `findAvailableBranchName` (`-2..-50`) →
  `git branch -m` → metadata `renamed` → `hub.invalidate(cwd)`, so SSE
  refreshes badges/hero live.

**Deviations from paseo (deliberate):**

1. No title generation — DSH owns session titles natively (`sessionTitle`);
   only the branch is renamed.
2. Explicitly-named branches are `ineligible` — paseo marks every fresh
   branch-off pending; respecting an explicit user-chosen name is the saner
   reading of intent.
3. Migration window: worktrees created before the Phase B restart carry no
   `autoName` field and keep their placeholder (`main-wt` era names included)
   forever; no retroactive renaming.
4. v1 UI exposes no PR-checkout entry (host `checkout` intent remains for a
   future PR flow).

## Consequences

- The dead-end is gone: every terminal UI action creates a worktree and
  jumps to its session; chatting always happens in the intended directory.
- Placeholder names are valid slugs by construction; rename failures degrade
  to keeping them (best-effort, never blocks the session).
- The rename costs one auxiliary LLM call per worktree session lifetime.
- Guard placement (path-prefix gate + metadata check before any git call)
  keeps the per-message overhead negligible for non-worktree sessions.
- Tests pin the semantics: placeholder/pending metadata, explicit-name
  ineligibility, end-to-end rename through the subscription, manual-rename /
  invalid-output / collision / subagent / non-worktree guards, slug rules.
