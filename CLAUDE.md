# CLAUDE.md

Project context for Claude Code. Read `HANDOFF.md` for current state and
outstanding work; this file covers how to work in the repo.

## Standing rule: documentation is part of every change

**The user has asked that documentation always be kept current — across
every session, indefinitely.** Treat a change as unfinished until its
docs are updated, in the same commit as the code. Do not batch it up "for
later" and do not wait to be asked.

Which file to touch, by change type:

| You changed | Update |
|---|---|
| A table, column, index, or cascade | `docs/SCHEMA.md` |
| An integration, or something learned about a third-party API | `README.md` + `HANDOFF.md` |
| Colours, type, spacing, or a component pattern | `docs/DESIGN.md` |
| A view's structure, or a JS section in the front end | the section map atop `public/index.html` |
| Behaviour worth protecting from regression | add a check to `scripts/smoke-test.sh` |
| Deploy mechanics, tooling quirks, or conventions | this file |
| Shipped a feature, or hit a dead end | `HANDOFF.md` |

Also:

- **Record dead ends, not just successes.** "Outlook is impossible
  because the domain is on Hostinger" saved re-investigating it. A future
  session cannot know what was already ruled out unless it is written
  down.
- **Note when a *test* was wrong**, not just when code was. Several false
  alarms this project came from bad test harnesses; that pattern is worth
  remembering. The worst was in `bad()` itself: it ended on a `[ -n "$2" ]`
  test, so calling it without a detail string returned non-zero and any
  check written `cond && bad "x" || ok "y"` reported a FAIL *and* a PASS
  for the same assertion. Checks written the other way round were fine,
  which is why it survived so long. A test harness is code and can be
  wrong in ways that flatter you.
- **Never write secret values into any file.** Reference them by
  variable name. Docs live in a public repo.

## What this is

Internal ops app for a small data consultancy: mail, calendar, booking
pages, CRM, service desk, and accounting figures in one place. Plain
Node + Express + Postgres, no framework, **no build step**. Deployed on
Railway, live at
https://pocket-data-office-production.up.railway.app

## Working on it

### There is no local runtime

Node, npm, `gh` and the Railway CLI are **not installed** on the dev
machine. You cannot run the app, install packages, or `node --check` a
file. Perl is available; `python` is a Windows Store alias and does not
work.

**The deploy is the test.** Read changed code carefully before pushing —
a syntax error costs a full deploy cycle to discover.

### Deploying

Pushing to GitHub does **not** reliably trigger a deploy, and Railway's
plain "redeploy" rebuilds the *previous* commit. Always deploy by SHA
using the Railway MCP agent:

> Deploy commit `<sha>` for service `24ed1c72-0af5-4dc6-bee4-ea4abdaee4ad`.

Builds take **about three minutes**. `get-logs` returns an empty array
while a build is in progress — that is not evidence of a hang. Wait for
the status to change to SUCCESS before concluding anything.

**`list-variables` under-reports — do not trust it as evidence of absence.**
It returned 23 names for this service and silently omitted all five
`FILES_*` variables, which were present the whole time. That looked
exactly like a broken integration and nearly caused a pointless re-wiring.
To check whether a variable is really set, ask the Railway agent for the
service config, or better, hit the app endpoint that actually uses it
(`/api/files/status` does a `HeadBucket` with the live credentials).
Separately, variable changes are staged and only reach the running app on
the next deploy — so a genuinely new variable still needs one.

### Verifying

`scripts/smoke-test.sh` exercises the paths that have broken before.
Run it after any change touching mail, calendar, scheduling, tickets,
CRM, projects, people, files, or Wave:

```bash
AUTH_USER=... AUTH_PASS=... bash scripts/smoke-test.sh
```

It creates and deletes records against the live app — including a real
upload to the live bucket — and cleans up after itself, so don't run it
while someone is using the app.

### Shell gotcha

The Windows shell mangles non-ASCII in command arguments. Testing UTF-8
by passing characters through `curl -d` produces **false** corruption
reports. Write the payload to a file and use `--data-binary @file`.

## Conventions that matter

- **Money is integer cents** everywhere — DB, API, and JS. Only the UI
  converts to dollars. Wave's `Money.minorUnitValue` is already cents,
  which is why it drops straight in.
- **Never invent placeholder figures.** Anything without a real data
  source renders as `—` with a note saying why. A plausible-looking
  invented number on a dashboard someone acts on is worse than a visible
  gap. This has been decided deliberately; don't "improve" it.
- **Validate credentials before storing them.** Mail, Calendly and Wave
  all test against the real service on connect so a bad value fails
  immediately with the provider's own error, rather than producing a
  silently empty view later.
- **Synced records are read-only locally.** Calendly bookings and
  ticket-SLA calendar entries return 409 on edit/delete, because the next
  sync would overwrite the change.
- **Secrets never go in the repo or in chat.** They live in Railway
  variables. If a rotation is needed, *the user* does it — anything
  Claude generates ends up in a transcript.
- **`escapeHtml()` everything** interpolated into `innerHTML`. Mail
  bodies and CRM fields are attacker-influenced.

## Architecture notes

`server.js` holds every route. Order matters: routes registered **before**
the auth-gate middleware are public, and three things depend on that —
the `.ics` calendar feed, the public booking pages, and `/healthz`.
Calendar clients and booking visitors cannot authenticate.

`public/index.html` is the whole front end in one file (~4,000 lines).
It opens with a section map; navigate by grepping the markers rather than
scrolling.

`lib/migrate.js` runs on every boot and is idempotent — it is the schema
source of truth. See `docs/SCHEMA.md` for the tables and how they relate.

## Constraints that are settled

Do not re-investigate these; each cost significant time to establish and
is documented in `HANDOFF.md`:

- **Outlook mail and Outlook Calendar are impossible.** The domain is on
  Hostinger, not Microsoft 365. Mail runs over IMAP/SMTP.
- **Calendly cannot be told about busy time.** Its availability API is
  read-only.
- **Wave uses a Full Access Token, not OAuth.** OAuth requires the end
  user's business to be on a paid tier.
- **The "AI Agent" view IS built** - see the Assistant section of the
  README. The old rule against it was overturned deliberately; do not
  re-apply it. What survives from that rule is the shape: read tools run,
  write tools only ever queue a proposal, and approving in the UI is the
  single path by which anything the assistant suggests reaches the data.
  Do not add a tool that writes directly.
- **draw.io must be embedded, not linked to.** app.diagrams.net saves
  only to its own fixed list of backends (Drive, OneDrive, Dropbox,
  GitHub, GitLab, Bitbucket, device) and cannot be taught about this app.
  Embed mode makes the host page the storage, which is the only way a
  diagram saves back into a client's folder. There is also no
  server-side render of `.drawio` without draw.io's separate export
  server — do not go hunting for a Node library. See the Diagrams
  section of the README.
- **File storage is Railway Buckets, and the alternatives were checked.**
  There is no `pocketdataoffice.com` OneDrive (no Microsoft tenant on the
  domain), Proton Drive has no public API, and self-hosting means a
  second server to patch and back up. The accepted cost is no backup and
  no version history — see the Outstanding work section of `HANDOFF.md`.

## Design

The app follows a reference design supplied by the user. Its tokens and
layout specs are captured in `docs/DESIGN.md`, so the original bundle is
not needed. Create and edit flows open in modal dialogs — do not add new
inline editors.
