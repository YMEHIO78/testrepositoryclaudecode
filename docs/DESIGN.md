# Design system

Extracted from the reference design the user supplied
(`Pocket Data Office.html`, a self-extracting bundle on their OneDrive).
Everything needed is captured here — **the original file is not required**.

## Reading the original, if you ever must

It is a bundle: the real markup is a JSON-encoded string inside
`<script type="__bundler/template">`. Decode with perl + `JSON::PP`,
using the character-oriented decoder (`JSON::PP->new->utf8(0)->decode`)
— `decode_json` dies with "Wide character".

**Trap:** the decoded file contains a `:root` stylesheet with a **teal**
palette (`#0088b0`) and cool greys. It is dead boilerplate and never
renders. The actual design is ~1,134 **inline styles**; the file contains
zero CSS classes. Reading `:root` and believing it produced a completely
wrong restyle once already.

## Tokens

```
background   #faf7f0    warm cream, page
surface      #fffdf8    cards
sidebar      #f0ebe0
hover        #f4f0e6    rows/list items
accent-hover #e6e0f7    nav and interactive hover

text         #201e1d
muted        #605d5d  #7d7979  #8a8683  #9b9797   (darkest → lightest)

accent       #1800ad    primary blue
accent-dark  #12007d    hover on primary
urgent       #a90b56    overdue, unread counts, destructive
yellow       #edbb00

divider      rgba(32, 30, 29, 0.14)
             rgba(32, 30, 29, 0.08)  list-row separators
             rgba(32, 30, 29, 0.18)  section header underlines
             rgba(32, 30, 29, 0.28)  secondary button borders

radius       1px / 2px / 4px         (sharp; 2px is the workhorse)
spacing      5 / 10 / 15 / 20 / 30 / 40px
font         "Source Serif 4", Georgia, serif
body         15px / 1.55 / weight 400
headings     weight 600
shadows      sm 0 1px 2px · md 0 3px 10px · lg 0 12px 32px
             (all color-mix of #2d2b2b at 14/16/22%)
```

These live in `:root` in `public/index.html`. Legacy names (`--brand`,
`--paper`, `--line`, `--muted`…) are **aliases** onto them, which is why
the whole app restyled without editing every rule. Keep the aliases.

## Type scale

| Use | Size |
|---|---|
| Dashboard greeting | 40px, weight 600, tracking -0.015em |
| View `h1` | 26px, tracking -0.01em |
| Mail subject (detail) | 30px, weight 600, tracking -0.015em |
| Dashboard stat value | 38px, weight 600, tracking -0.02em |
| Secondary stat | 22px |
| Section header `h2` | 15px, uppercase, tracking 0.14em, weight 600 |
| Kicker / eyebrow | 10–11px, uppercase, tracking 0.16–0.18em, weight 600 |
| Body | 15px |
| Meta / secondary | 12–14px |

## Layout specs

**Shell** — `display:flex`, sidebar `264px` fixed, `position:sticky`,
`height:100vh`, background `#f0ebe0`, right border. Brand is "POCKET"
21px/700/tracking .16em in accent, over "DATA OFFICE" 10px/600/tracking
.34em in muted.

**Inbox (master–detail)** — list column `380px` fixed with right border;
rows are flex-column buttons with a `1px rgba(32,30,29,.08)` bottom
border and hover `#f4f0e6`. Detail pane `flex:1`, `padding:30px 44px
60px`, `max-width:900px`. Body text is capped at **66ch**. Actions sit in
a bottom bar above a top border, primary filled in accent.

**Dashboard** — stat strip `repeat(3,1fr)` with `gap:2px`, `2px solid`
top border and a hairline bottom. Main columns `1.15fr 1fr 0.95fr`,
`gap:48px`. Lower section `1.4fr 1fr`. Pipeline bars: label `148px`,
track `flex:1` at `15px` high on `#eee9dd`, value `96px` right-aligned,
count `34px`.

**Dialogs** — backdrop `position:fixed; inset:0; display:grid;
place-items:center`, tinted `color-mix(#2d2b2b 50%)`. Dialog
`min(560px,100%)`, surface background, `shadow-lg`, `radius-lg`,
`gap:15px`. Title 20px serif with an uppercase accent kicker above.
Actions right-aligned; destructive action pushed left with `margin-right:auto`.

## Rules that are decisions, not accidents

- **Create and edit flows open in modal dialogs.** Do not add inline
  editors; the pattern is `openModal()` + `[data-modal="save|cancel|delete"]`.
- **Missing data renders as `—` with a note explaining why**, never as an
  invented figure. The dashboard's expenses row and the pre-Wave cash
  panel are the examples. This is deliberate: a plausible fake number on
  a panel someone acts on is worse than a visible gap.
- **Synced records get a read-only panel**, not a disabled form, so it is
  obvious the record is owned elsewhere.
- **HTML email renders inside a `sandbox` iframe.** Never inject mail
  HTML into the page.

## Not built from the reference

The reference includes an **AI Agent** view (chat, agent actions,
approvals). The project README explicitly rules out an AI-agent chat
feature — **do not build it**.

It also shows detail pages for clients, tickets and projects, plus
Projects/Files/People views, which do not exist yet. See `HANDOFF.md`.
