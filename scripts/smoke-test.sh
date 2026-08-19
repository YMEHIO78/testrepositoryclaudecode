#!/usr/bin/env bash
#
# Smoke tests against a running instance.
#
# Every check here corresponds to something that actually broke during
# development. They exist so the same bug cannot come back silently.
#
#   AUTH_USER=... AUTH_PASS=... bash scripts/smoke-test.sh
#   BASE_URL=http://localhost:3000 AUTH_USER=... AUTH_PASS=... bash scripts/smoke-test.sh
#
# It creates and deletes records against the target instance, so do not
# run it while someone is using the app. It cleans up after itself.

set -uo pipefail

BASE_URL="${BASE_URL:-https://pocket-data-office-production.up.railway.app}"
: "${AUTH_USER:?set AUTH_USER}"
: "${AUTH_PASS:?set AUTH_PASS}"

JAR=$(mktemp)
PASS=0
FAIL=0

cleanup() { rm -f "$JAR"; }
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
# The trailing `return 0` is load-bearing. Without it the function ends on
# `[ -n "$2" ]`, which exits non-zero whenever no detail is passed — so a
# check written `cond && bad "x" || ok "y"` ran BOTH branches and reported
# a FAIL and a PASS for the same assertion. Checks written the other way
# round were unaffected, which is why it hid for so long.
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n'   "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; return 0; }
head_() { printf '\n== %s\n' "$1"; }

api() { curl -s -b "$JAR" --max-time 60 "$@"; }

# ---------------------------------------------------------------- auth

head_ "Auth"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$BASE_URL/healthz")
[ "$code" = "200" ] && ok "/healthz is public" || bad "/healthz" "got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$BASE_URL/api/inbox")
[ "$code" = "302" ] && ok "API redirects when unauthenticated" || bad "unauthenticated API" "expected 302, got $code"

curl -s -c "$JAR" -o /dev/null --max-time 30 \
  -d "username=$AUTH_USER" -d "password=$AUTH_PASS" "$BASE_URL/login"
code=$(api -o /dev/null -w '%{http_code}' "$BASE_URL/")
[ "$code" = "200" ] && ok "login works" || bad "login" "got $code — later checks will fail"

# ------------------------------------------------------- calendar/ics

head_ "Calendar and .ics feed"

FEED=$(api "$BASE_URL/api/calendar/feed" | grep -o 'https[^"]*\.ics')
[ -n "$FEED" ] && ok "feed URL issued" || bad "feed URL"

if [ -n "$FEED" ]; then
  # Must be readable with no session: calendar clients cannot log in.
  ICSFILE=$(mktemp)
  curl -s --max-time 30 "$FEED" -o "$ICSFILE"
  grep -q "BEGIN:VCALENDAR" "$ICSFILE" && ok "feed readable unauthenticated" || bad "feed unauthenticated"

  # RFC 5545 requires CRLF; a bare LF breaks strict parsers. Inspect the
  # file's bytes directly — reading it through a shell variable normalises
  # \r away and produces a false failure.
  if od -c "$ICSFILE" | head -3 | grep -q '\\r'; then
    ok "feed uses CRLF"
  else
    bad "feed line endings" "expected CRLF"
  fi
  rm -f "$ICSFILE"

  BADFEED=$(echo "$FEED" | sed 's|/calendar/[a-f0-9]*/|/calendar/0000000000000000/|')
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$BADFEED")
  [ "$code" = "404" ] && ok "wrong feed token 404s" || bad "feed token check" "got $code"
fi

# ------------------------------------------------------ scheduling

head_ "Scheduling (slot maths)"

SLUG=$(api "$BASE_URL/api/scheduling/config" | grep -o '"slug":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$SLUG" ]; then
  bad "no meeting type configured" "skipping slot checks"
else
  SLOTS=$(curl -s --max-time 30 "$BASE_URL/api/book/$SLUG/slots")
  TARGET=$(echo "$SLOTS" | grep -o '"slots":\[[^]]*' | grep -o '"[0-9T:.Z-]*"' | sed -n '3p' | tr -d '"')

  if [ -z "$TARGET" ]; then
    bad "no bookable slots offered" "check weekly hours"
  else
    ok "slots are offered ($SLUG)"

    # An existing event must remove the slot — this is the whole point of
    # computing availability against calendar_events.
    EV=$(api -X POST "$BASE_URL/api/calendar/events" -H 'Content-Type: application/json' \
      -d "{\"title\":\"smoke-test block\",\"startsAt\":\"$TARGET\"}")
    EVID=$(echo "$EV" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

    AFTER=$(curl -s --max-time 30 "$BASE_URL/api/book/$SLUG/slots")
    echo "$AFTER" | grep -q "\"$TARGET\"" \
      && bad "existing event did not block its slot" "regression: slot still offered" \
      || ok "existing event blocks its slot"

    # And booking it directly must be refused, not just hidden.
    RESP=$(curl -s --max-time 30 -X POST "$BASE_URL/api/book/$SLUG" -H 'Content-Type: application/json' \
      -d "{\"startsAt\":\"$TARGET\",\"name\":\"Smoke Test\",\"email\":\"smoke@example.com\"}" \
      -w '\n%{http_code}')
    echo "$RESP" | tail -1 | grep -q '409' \
      && ok "booking a blocked slot is refused (409)" \
      || bad "booking a blocked slot" "expected 409, got $(echo "$RESP" | tail -1)"

    [ -n "$EVID" ] && api -o /dev/null -X DELETE "$BASE_URL/api/calendar/events/$EVID"
  fi
fi

# --------------------------------------------------------- tickets

head_ "Tickets and SLA projection"

TK=$(api -X POST "$BASE_URL/api/tickets" -H 'Content-Type: application/json' \
  -d '{"subject":"smoke-test ticket","priority":"high","slaDueAt":"2030-01-01T12:00:00.000Z"}')
TKID=$(echo "$TK" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
REF=$(echo "$TK" | grep -o '"reference":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TKID" ]; then
  bad "could not create ticket" "$TK"
else
  ok "ticket created ($REF)"

  api "$BASE_URL/api/calendar/events?from=2029-12-01T00:00:00Z&to=2030-02-01T00:00:00Z" \
    | grep -q "SLA due" && ok "SLA date projected onto the calendar" || bad "SLA projection"

  # Resolving must retract the calendar entry.
  api -o /dev/null -X PATCH "$BASE_URL/api/tickets/$TKID" \
    -H 'Content-Type: application/json' -d '{"status":"resolved"}'
  api "$BASE_URL/api/calendar/events?from=2029-12-01T00:00:00Z&to=2030-02-01T00:00:00Z" \
    | grep -q "SLA due" && bad "resolved ticket left its SLA on the calendar" \
                        || ok "resolving retracts the SLA entry"

  # Detail page: aggregate endpoint must return the ticket and its log.
  DET=$(api "$BASE_URL/api/tickets/$TKID/detail")
  echo "$DET" | grep -q '"ticket"' && ok "ticket detail loads" || bad "ticket detail" "$(echo "$DET" | head -c 150)"
  echo "$DET" | grep -q '"kind":"created"' && ok "activity log records creation" || bad "activity log missing creation"
  echo "$DET" | grep -q '"kind":"status"' && ok "activity log records the status change" || bad "activity log missing status change"

  api -o /dev/null -X DELETE "$BASE_URL/api/tickets/$TKID"
fi

# ------------------------------------------------------------- CRM

head_ "CRM"

CL=$(api -X POST "$BASE_URL/api/crm/clients" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Test Co","stage":"client","recurring":true}')
CLID=$(echo "$CL" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$CLID" ]; then
  bad "could not create client" "$CL"
else
  ok "client created"
  # Value is derived from package quantities now, never typed, so a new
  # client starts at zero rather than at whatever was posted.
  echo "$CL" | grep -q '"valueCents":0' \
    && ok "a new client's value starts derived at zero" \
    || bad "client value not derived" "$(echo "$CL" | head -c 150)"

  # Detail page aggregates several sources; each must degrade on its own
  # rather than failing the response.
  CD=$(api "$BASE_URL/api/crm/clients/$CLID/detail")
  echo "$CD" | grep -q '"client"'   && ok "client detail loads"            || bad "client detail" "$(echo "$CD" | head -c 150)"
  echo "$CD" | grep -q '"tickets"'  && ok "client detail includes tickets" || bad "client detail tickets"
  echo "$CD" | grep -q '"invoices"' && ok "client detail includes invoices"|| bad "client detail invoices"
  echo "$CD" | grep -q '"warnings"' && ok "client detail reports warnings" || bad "client detail warnings"

  # Terms, health and start date. All optional, and a partial update must
  # leave the fields it does not mention alone — the detail page's inline
  # dropdowns each send exactly one.
  api -o /dev/null -X PATCH "$BASE_URL/api/crm/clients/$CLID" \
    -H 'Content-Type: application/json' \
    -d '{"terms":"Retainer","health":"Watch","clientSince":"2026-03-01"}'
  WITH=$(api "$BASE_URL/api/crm/clients/$CLID/detail")
  echo "$WITH" | grep -q '"terms":"Retainer"' && ok "terms saved" || bad "terms not saved"
  echo "$WITH" | grep -q '"health":"Watch"' && ok "health saved" || bad "health not saved"
  echo "$WITH" | grep -q '"clientSince"' && ok "client since saved" || bad "clientSince not saved"

  api -o /dev/null -X PATCH "$BASE_URL/api/crm/clients/$CLID" \
    -H 'Content-Type: application/json' -d '{"stage":"engaging"}'
  PART=$(api "$BASE_URL/api/crm/clients/$CLID/detail")
  echo "$PART" | grep -q '"terms":"Retainer"' \
    && ok "a partial update leaves terms alone" \
    || bad "partial update nulled terms" "the inline dropdowns each send one field"
  echo "$PART" | grep -q '"health":"Watch"' \
    && ok "a partial update leaves health alone" || bad "partial update nulled health"

  # An unknown value must not be stored — health drives a colour, and an
  # unrecognised one would render as no assessment at all.
  api -o /dev/null -X PATCH "$BASE_URL/api/crm/clients/$CLID" \
    -H 'Content-Type: application/json' -d '{"health":"Fantastic"}'
  api "$BASE_URL/api/crm/clients/$CLID/detail" | grep -q '"health":"Fantastic"' \
    && bad "an unknown health value was stored" || ok "unknown health values are rejected"

  # The option lists have to reach the browser or the dropdowns are empty.
  LISTS=$(api "$BASE_URL/api/crm/clients")
  echo "$LISTS" | grep -q '"terms":\["Retainer"' && ok "terms options served" || bad "terms options missing"
  echo "$LISTS" | grep -q '"health":\[{"key":"Green"' && ok "health options served" || bad "health options missing"
  api -o /dev/null -X DELETE "$BASE_URL/api/crm/clients/$CLID"
fi

# --------------------------------------------------------- meetings

head_ "Meetings linked to a client"

MC=$(api -X POST "$BASE_URL/api/crm/clients" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Meeting Co","stage":"client"}')
MCID=$(echo "$MC" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$MCID" ]; then
  bad "could not create client for meeting tests" "$MC"
else
  MEV=$(api -X POST "$BASE_URL/api/calendar/events" -H 'Content-Type: application/json' \
    -d "{\"title\":\"smoke-test kickoff\",\"startsAt\":\"2031-04-02T15:00:00.000Z\",\"clientId\":\"$MCID\"}")
  MEVID=$(echo "$MEV" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  echo "$MEV" | grep -q "\"clientId\":$MCID" && ok "an event can be tagged to a client" \
    || bad "event not tagged" "$(echo "$MEV" | head -c 150)"

  api "$BASE_URL/api/calendar/events?clientId=$MCID" | grep -q 'smoke-test kickoff' \
    && ok "events filter by client" || bad "client filter on events"

  api "$BASE_URL/api/crm/clients/$MCID/detail" | grep -q 'smoke-test kickoff' \
    && ok "the client page lists its meetings" || bad "meetings missing from client detail"

  # Clearing the tag is distinct from leaving it alone: the editor sends
  # an empty string to unset, and omitting the field must not wipe it.
  api -o /dev/null -X PATCH "$BASE_URL/api/calendar/events/$MEVID" \
    -H 'Content-Type: application/json' -d '{"title":"smoke-test kickoff renamed"}'
  api "$BASE_URL/api/calendar/events?clientId=$MCID" | grep -q 'renamed' \
    && ok "an unrelated edit keeps the client tag" || bad "edit dropped the client tag"

  api -o /dev/null -X PATCH "$BASE_URL/api/calendar/events/$MEVID" \
    -H 'Content-Type: application/json' -d '{"clientId":""}'
  api "$BASE_URL/api/calendar/events?clientId=$MCID" | grep -q 'renamed' \
    && bad "clearing the client tag did nothing" || ok "the client tag can be cleared"

  # Deleting a client must not delete the record of having met them.
  api -o /dev/null -X PATCH "$BASE_URL/api/calendar/events/$MEVID" \
    -H 'Content-Type: application/json' -d "{\"clientId\":\"$MCID\"}"
  api -o /dev/null -X DELETE "$BASE_URL/api/crm/clients/$MCID"
  api "$BASE_URL/api/calendar/events?from=2031-01-01T00:00:00Z&to=2032-01-01T00:00:00Z" \
    | grep -q 'renamed' \
    && ok "deleting a client leaves its meetings on the calendar" \
    || bad "deleting a client destroyed its meeting history"

  [ -n "$MEVID" ] && api -o /dev/null -X DELETE "$BASE_URL/api/calendar/events/$MEVID"
fi

# ------------------------------------------------------------ vault

head_ "Client credentials"

VC=$(api -X POST "$BASE_URL/api/crm/clients" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Vault Co","stage":"client"}')
VCID=$(echo "$VC" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$VCID" ]; then
  bad "could not create client for vault tests" "$VC"
else
  SYS=$(api -X POST "$BASE_URL/api/vault/systems" -H 'Content-Type: application/json' \
    -d "{\"clientId\":$VCID,\"name\":\"Smoke Databricks\",\"url\":\"https://example.invalid\"}")
  SYSID=$(echo "$SYS" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  [ -n "$SYSID" ] && ok "system created" || bad "system creation" "$SYS"

  SEC=$(api -X POST "$BASE_URL/api/vault/secrets" -H 'Content-Type: application/json' \
    -d "{\"systemId\":$SYSID,\"label\":\"Smoke API key\",\"kind\":\"api_key\",\"username\":\"svc@example.invalid\",\"value\":\"SUPERSECRETVALUE123\"}")
  SECID=$(echo "$SEC" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  [ -n "$SECID" ] && ok "credential stored" || bad "credential creation" "$SEC"

  # The invariant that matters most: a value must never appear in any
  # response except the one reveal call for that one secret.
  echo "$SEC" | grep -q 'SUPERSECRETVALUE123' \
    && bad "the create response echoed the secret back" || ok "creating does not echo the value"

  LIST=$(api "$BASE_URL/api/vault?clientId=$VCID")
  echo "$LIST" | grep -q 'Smoke API key' && ok "credential is listed" || bad "credential not listed"
  echo "$LIST" | grep -q 'SUPERSECRETVALUE123' \
    && bad "the list response contains the secret value" "values must never be listed" \
    || ok "listing never carries the value"

  # Metadata edits must not disturb the stored value.
  api -o /dev/null -X PATCH "$BASE_URL/api/vault/secrets/$SECID" \
    -H 'Content-Type: application/json' -d '{"label":"Smoke API key renamed"}'

  REV=$(api -X POST "$BASE_URL/api/vault/secrets/$SECID/reveal")
  echo "$REV" | grep -q 'SUPERSECRETVALUE123' \
    && ok "reveal returns the decrypted value" || bad "reveal failed" "$(echo "$REV" | head -c 200)"
  echo "$REV" | grep -q '"revealCount":1' \
    && ok "reveals are counted" || bad "reveal not counted"

  # Deleting a client while credentials remain must fail loudly rather
  # than cascading them away - they are not in the backup.
  code=$(api -o /dev/null -w '%{http_code}' -X DELETE "$BASE_URL/api/crm/clients/$VCID")
  [ "$code" = "409" ] && ok "deleting a client with stored credentials is refused" \
    || bad "client delete cascaded into credentials" "expected 409, got $code"

  # And the backup must not carry them either.
  api "$BASE_URL/api/export" | grep -q 'SUPERSECRETVALUE123' \
    && bad "the backup export contains a client credential" || ok "credentials stay out of the export"
  api "$BASE_URL/api/export/summary" | grep -q 'client_secrets' \
    && ok "the export names client_secrets as excluded" || bad "exclusion not declared"

  api -o /dev/null -X DELETE "$BASE_URL/api/vault/systems/$SYSID"
  api -o /dev/null -X DELETE "$BASE_URL/api/crm/clients/$VCID"
fi

# -------------------------------------------------------- diagrams

head_ "Diagrams"

DC=$(api -X POST "$BASE_URL/api/crm/clients" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Diagram Co","stage":"client"}')
DCID=$(echo "$DC" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$DCID" ]; then
  bad "could not create client for diagram tests" "$DC"
else
  DG=$(api -X POST "$BASE_URL/api/diagrams" -H 'Content-Type: application/json' \
    -d "{\"name\":\"Smoke Architecture\",\"clientId\":$DCID}")
  DGID=$(echo "$DG" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  [ -n "$DGID" ] && ok "diagram created" || bad "diagram creation" "$(echo "$DG" | head -c 200)"

  # The extension is what makes draw.io open it as a diagram rather than
  # as plain XML, so it must be added whether or not the name had one.
  echo "$DG" | grep -q '"name":"Smoke Architecture.drawio"' \
    && ok "the .drawio extension is added" || bad "extension not normalised" "$(echo "$DG" | head -c 200)"

  READ=$(api "$BASE_URL/api/diagrams/$DGID")
  echo "$READ" | grep -q 'mxGraphModel' \
    && ok "a new diagram opens as a real empty page" || bad "blank diagram is not valid mxfile"

  # A save must round-trip: what the editor posts is what comes back.
  api -o /dev/null -X PUT "$BASE_URL/api/diagrams/$DGID" -H 'Content-Type: application/json' \
    -d '{"xml":"<mxfile host=\"smoke\"><diagram name=\"P\">MARKERXYZ</diagram></mxfile>"}'
  api "$BASE_URL/api/diagrams/$DGID" | grep -q 'MARKERXYZ' \
    && ok "saving round-trips the diagram" || bad "save did not round-trip"

  # Editing must not pile up copies - the whole point of replaceContent.
  N=$(api "$BASE_URL/api/diagrams?clientId=$DCID" | grep -o '"id":[0-9]*' | wc -l)
  [ "$N" -eq 1 ] && ok "saving edits in place rather than adding a file" \
    || bad "saving created extra files" "expected 1 diagram, found $N"

  # Diagrams are files, but they must not appear in the client's Files
  # list twice over - they get their own section.
  DETAIL=$(api "$BASE_URL/api/crm/clients/$DCID/detail")
  echo "$DETAIL" | grep -q '"diagrams"' \
    && ok "the client detail carries a diagrams list" || bad "no diagrams key on client detail"

  # The editor route must refuse ordinary files. It hands bytes to a
  # third-party iframe, so it is not a general file reader.
  TXT=$(api -X POST "$BASE_URL/api/files?name=smoke-note.txt&clientId=$DCID" \
    -H 'Content-Type: text/plain' --data-binary 'not a diagram')
  TXTID=$(echo "$TXT" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  if [ -n "$TXTID" ]; then
    code=$(api -o /dev/null -w '%{http_code}' "$BASE_URL/api/diagrams/$TXTID")
    [ "$code" = "404" ] && ok "the editor refuses files that are not diagrams" \
      || bad "a non-diagram file was readable as a diagram" "expected 404, got $code"
    api -o /dev/null -X DELETE "$BASE_URL/api/files/$TXTID"
  else
    bad "could not upload a control file" "$(echo "$TXT" | head -c 160)"
  fi

  # Re-filing from inside the editor: the move that makes "save into a
  # client's folder" mean anything.
  MOVED=$(api -X PATCH "$BASE_URL/api/diagrams/$DGID" -H 'Content-Type: application/json' \
    -d '{"clientId":null}')
  echo "$MOVED" | grep -q '"clientId":null' \
    && ok "a diagram can be re-filed to no client" || bad "re-filing failed" "$(echo "$MOVED" | head -c 160)"

  api -o /dev/null -X DELETE "$BASE_URL/api/files/$DGID"
  api -o /dev/null -X DELETE "$BASE_URL/api/crm/clients/$DCID"
fi

# ----------------------------------------------------------- agent

head_ "AI assistant"

AG=$(api "$BASE_URL/api/agent")
echo "$AG" | grep -q '"configured"' && ok "assistant status responds" || bad "agent status" "$(echo "$AG" | head -c 150)"

if echo "$AG" | grep -q '"configured":true'; then
  ok "assistant is configured"
  echo "$AG" | grep -q '"usage"' && ok "token spend is tracked" || bad "usage missing"
else
  ok "assistant not configured — chat checks skipped"
  # It must degrade, not 500: the view says so and the endpoint refuses.
  code=$(api -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/agent/conversations/1/messages" \
    -H 'Content-Type: application/json' -d '{"text":"hello"}')
  [ "$code" = "503" ] && ok "chat refuses cleanly when unconfigured" \
    || bad "unconfigured chat" "expected 503, got $code"
fi

# The approval queue is the safety model, and these two checks are the
# reason it exists — they hold whether or not a key is configured.
api "$BASE_URL/api/agent/actions?pending=1" | grep -q '"actions"' \
  && ok "approval queue responds" || bad "approval queue"

code=$(api -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/agent/actions/999999/approve")
[ "$code" = "409" ] || [ "$code" = "404" ] \
  && ok "approving an unknown action is refused" || bad "unknown action" "got $code"

code=$(api -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/agent/actions/1/destroy")
[ "$code" = "400" ] && ok "only approve and reject are accepted" \
  || bad "decision validation" "expected 400, got $code"

# --------------------------------------------------------- backup

head_ "Backup export"

SUM=$(api "$BASE_URL/api/export/summary")
echo "$SUM" | grep -q '"counts"' && ok "export summary responds" || bad "export summary" "$(echo "$SUM" | head -c 150)"

EXP=$(api "$BASE_URL/api/export")
# Pretty-printed, so the colon is followed by a space.
echo "$EXP" | grep -q '"formatVersion": 1' && ok "export builds" || bad "export failed"
echo "$EXP" | grep -q '"clients"' && ok "export includes clients" || bad "clients missing from export"
echo "$EXP" | grep -q '"packages"' && ok "export includes packages" || bad "packages missing from export"

# Credentials must never be in a file that gets downloaded to a laptop.
echo "$EXP" | grep -q 'encrypted_password' \
  && bad "the export contains mailbox credentials" "these must stay out" \
  || ok "mailbox credentials are excluded"
echo "$EXP" | grep -q 'calendar_feed_token' \
  && bad "the export contains the calendar feed token" \
  || ok "the calendar feed token is excluded"
# Match the column, not the table name: the table name legitimately
# appears in the export's own list of what it left out.
echo "$EXP" | grep -q 'encrypted_payload' \
  && bad "the export contains oauth token payloads" || ok "oauth tokens are excluded"

# It has to arrive as a file, not render in the browser.
BH=$(api -D - -o /dev/null "$BASE_URL/api/export")
echo "$BH" | grep -qi 'content-disposition: attachment' \
  && ok "the export downloads as a file" || bad "export disposition"
echo "$BH" | grep -qi 'filename="pocket-data-office-' \
  && ok "the download is date-stamped" || bad "export filename"

# --------------------------------------------------------- search

head_ "Search"

SC=$(api -X POST "$BASE_URL/api/crm/clients" -H 'Content-Type: application/json' \
  -d '{"name":"Zephyr Logistics","stage":"engaging","notes":"warehouse migration"}')
SCID=$(echo "$SC" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
api -o /dev/null -X POST "$BASE_URL/api/crm/clients/$SCID/contacts" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Priya Raman","email":"priya@zephyr-example.com","isPrimary":true}'

ST=$(api -X POST "$BASE_URL/api/tickets" -H 'Content-Type: application/json' \
  -d "{\"subject\":\"Zephyr onboarding call\",\"clientId\":$SCID}")
STID=$(echo "$ST" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$SCID" ]; then
  bad "could not set up search fixtures" "$SC"
else
  api "$BASE_URL/api/search?q=zephyr" | grep -q '"kind":"client"' \
    && ok "finds a client by name" || bad "client name search"

  # Mid-word, which is the reason for ILIKE '%term%' over a prefix match.
  api "$BASE_URL/api/search?q=ephyr" | grep -q 'Zephyr Logistics' \
    && ok "matches mid-word, not just prefixes" || bad "mid-word search"

  # Case-insensitivity is the whole point of ILIKE.
  api "$BASE_URL/api/search?q=ZEPHYR" | grep -q 'Zephyr Logistics' \
    && ok "search is case-insensitive" || bad "case sensitivity"

  api "$BASE_URL/api/search?q=warehouse%20migration" | grep -q 'Zephyr Logistics' \
    && ok "finds a client by its notes" || bad "notes search"

  # A contact's email should surface their client, with a subtitle saying
  # why — otherwise the hit looks like it matched for no reason.
  CH=$(api "$BASE_URL/api/search?q=priya")
  echo "$CH" | grep -q 'Zephyr Logistics' && ok "finds a client via its contact" || bad "contact search"
  echo "$CH" | grep -q '"subtitle":"Contact: Priya Raman"' \
    && ok "says which contact matched" || bad "match reason missing"

  api "$BASE_URL/api/search?q=onboarding" | grep -q '"kind":"ticket"' \
    && ok "finds a ticket by subject" || bad "ticket search"

  # Under two characters must not run: '%a%' matches most of the database
  # and would look broken rather than helpful.
  api "$BASE_URL/api/search?q=a" | grep -q '"tooShort":true' \
    && ok "a one-character query is refused" || bad "short query not refused"

  # A literal % must be searched for, not treated as "match everything".
  api "$BASE_URL/api/search?q=%25%25" | grep -q '"groups":\[\]' \
    && ok "wildcards in the query are escaped" || bad "ILIKE wildcard leaked through"

  [ -n "$STID" ] && api -o /dev/null -X DELETE "$BASE_URL/api/tickets/$STID"
  api -o /dev/null -X DELETE "$BASE_URL/api/crm/clients/$SCID"
fi

# -------------------------------------------------------- packages

head_ "Packages and derived client value"

PK=$(api -X POST "$BASE_URL/api/packages" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Package","unitCents":25000,"unitNote":"per smoke test"}')
PKID=$(echo "$PK" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

PC=$(api -X POST "$BASE_URL/api/crm/clients" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Package Co","stage":"client"}')
PCID=$(echo "$PC" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$PKID" ] || [ -z "$PCID" ]; then
  bad "could not set up package test" "pkg=$PKID client=$PCID"
else
  ok "package created"

  setqty() {
    api -X PUT "$BASE_URL/api/crm/clients/$PCID/packages/$PKID" \
      -H 'Content-Type: application/json' -d "{\"quantity\":$1}"
  }

  # 3 x $250.00 = $750.00. The whole point of the feature: the client's
  # value is this product, not a number somebody typed.
  setqty 3 | grep -q '"valueCents":75000' \
    && ok "value derives from unit price times quantity" \
    || bad "derived value wrong" "$(setqty 3 | head -c 150)"

  api "$BASE_URL/api/crm/clients/$PCID" 2>/dev/null >/dev/null
  api "$BASE_URL/api/crm/clients" | grep -q '"valueCents":75000' \
    && ok "the client list reports the derived value" || bad "list value not derived"

  # Absolute, not incremental: setting the same quantity twice must not
  # compound. A stepper double-click would otherwise double the money.
  setqty 3 > /dev/null
  setqty 3 | grep -q '"valueCents":75000' \
    && ok "setting the same quantity twice does not compound" \
    || bad "quantity compounded on repeat"

  # Repricing the package must move every client carrying it, with no
  # cached total left behind to go stale.
  api -o /dev/null -X PATCH "$BASE_URL/api/packages/$PKID" \
    -H 'Content-Type: application/json' -d '{"unitCents":30000}'
  api "$BASE_URL/api/crm/clients/$PCID/packages" | grep -q '"valueCents":90000' \
    && ok "repricing a package moves the client value" \
    || bad "reprice did not propagate"

  # A package on a client retires rather than deletes, so the client's
  # value survives. Nothing here is backed up.
  DELP=$(api -X DELETE "$BASE_URL/api/packages/$PKID")
  echo "$DELP" | grep -q '"retired":true' \
    && ok "a package in use retires instead of deleting" || bad "package deleted while in use" "$DELP"
  api "$BASE_URL/api/crm/clients/$PCID/packages" | grep -q '"valueCents":90000' \
    && ok "retiring leaves the client value untouched" || bad "value changed on retire"

  # Back to zero, and now it is unused, so it deletes outright.
  setqty 0 > /dev/null
  api -X DELETE "$BASE_URL/api/packages/$PKID" | grep -q '"retired":false' \
    && ok "an unused package deletes outright" || bad "unused package did not delete"

  api -o /dev/null -X DELETE "$BASE_URL/api/crm/clients/$PCID"
fi

# -------------------------------------------------------- projects

head_ "Projects"

PJ=$(api -X POST "$BASE_URL/api/projects" -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test project","stage":"build","budgetCents":200000,"spentCents":50000}')
PJID=$(echo "$PJ" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$PJID" ]; then
  bad "could not create project" "$PJ"
else
  ok "project created"

  api -o /dev/null -X POST "$BASE_URL/api/projects/$PJID/tasks" \
    -H 'Content-Type: application/json' -d '{"title":"smoke task","status":"todo"}'

  # A dated pending milestone must appear on the calendar.
  api -o /dev/null -X POST "$BASE_URL/api/projects/$PJID/milestones" \
    -H 'Content-Type: application/json' -d '{"name":"smoke milestone","dueOn":"2030-03-01"}'

  DET=$(api "$BASE_URL/api/projects/$PJID/detail")
  echo "$DET" | grep -q '"tasks"'      && ok "project detail includes the board" || bad "project detail tasks"
  echo "$DET" | grep -q 'smoke task'   && ok "task saved to the board"           || bad "task not saved"
  echo "$DET" | grep -q '"milestones"' && ok "project detail includes milestones"|| bad "project detail milestones"

  api "$BASE_URL/api/calendar/events?from=2030-02-01T00:00:00Z&to=2030-04-01T00:00:00Z" \
    | grep -q "smoke milestone" && ok "milestone projected onto the calendar" || bad "milestone projection"

  # Deleting the project must take its calendar entries with it.
  api -o /dev/null -X DELETE "$BASE_URL/api/projects/$PJID"
  api "$BASE_URL/api/calendar/events?from=2030-02-01T00:00:00Z&to=2030-04-01T00:00:00Z" \
    | grep -q "smoke milestone" \
    && bad "deleted project left its milestone on the calendar" \
    || ok "deleting a project clears its calendar entries"
fi

# ----------------------------------------------------------- files

head_ "Files"

FS=$(api "$BASE_URL/api/files")
if echo "$FS" | grep -q "\"configured\":true"; then
  ok "file storage configured"

  ST=$(api "$BASE_URL/api/files/status")
  echo "$ST" | grep -q "\"ok\":true" && ok "bucket reachable with the configured credentials" \
    || bad "bucket unreachable" "$(echo "$ST" | head -c 150)"

  # Round-trip an upload, then confirm the bytes come back intact.
  TMPF=$(mktemp); echo "smoke-test-file-contents" > "$TMPF"
  UP=$(api -X POST "$BASE_URL/api/files?name=smoke-test.txt" \
    -H "Content-Type: text/plain" --data-binary @"$TMPF")
  FID=$(echo "$UP" | grep -o "\"id\":[0-9]*" | head -1 | cut -d: -f2)

  if [ -z "$FID" ]; then
    bad "upload failed" "$(echo "$UP" | head -c 200)"
  else
    ok "file uploaded"
    DL=$(api "$BASE_URL/api/files/$FID/download")
    [ "$DL" = "smoke-test-file-contents" ] && ok "download returns the same bytes" \
      || bad "download mismatch" "got: $(echo "$DL" | head -c 60)"

    # Downloads must force-download, never render in the app origin.
    HDRS=$(api -D - -o /dev/null "$BASE_URL/api/files/$FID/download")
    echo "$HDRS" | grep -qi "content-disposition: attachment" \
      && ok "download forces attachment disposition" || bad "download disposition"

    # Moving is metadata only: the object keeps its key, so the same file
    # must still download byte-for-byte afterwards.
    MVF=$(api -X POST "$BASE_URL/api/folders" -H 'Content-Type: application/json' \
      -d '{"name":"Smoke Move Target"}' | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
    api -o /dev/null -X PATCH "$BASE_URL/api/files/$FID" \
      -H 'Content-Type: application/json' -d "{\"folderId\":$MVF}"
    api "$BASE_URL/api/files?folder=$MVF" | grep -q "smoke-test.txt" \
      && ok "a moved file lands in its new folder" || bad "move did not land"
    [ "$(api "$BASE_URL/api/files/$FID/download")" = "smoke-test-file-contents" ] \
      && ok "a moved file still downloads intact" || bad "move corrupted the download"
    api -o /dev/null -X DELETE "$BASE_URL/api/folders/$MVF"

    api -o /dev/null -X DELETE "$BASE_URL/api/files/$FID"
    api "$BASE_URL/api/files" | grep -q "smoke-test.txt" \
      && bad "deleted file still listed" || ok "delete removes the file"
  fi
  rm -f "$TMPF"
else
  bad "file storage not configured" "FILES_* variables missing"
fi

# --------------------------------------------------------- folders

head_ "Folders"

CLF=$(api -X POST "$BASE_URL/api/crm/clients" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Folder Co","stage":"client"}')
CLFID=$(echo "$CLF" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$CLFID" ]; then
  bad "could not create client for folder tests" "$CLF"
else
  mkfolder() {
    api -X POST "$BASE_URL/api/folders" -H 'Content-Type: application/json' -d "$1" \
      | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2
  }

  F1=$(mkfolder "{\"name\":\"Contracts\",\"clientId\":$CLFID}")
  [ -n "$F1" ] && ok "folder created" || bad "folder creation"

  # Re-creating the same name must reuse, not duplicate — this is what
  # makes re-uploading a folder idempotent instead of stacking copies.
  # The -n guard matters: without it, two empty ids compare equal and this
  # check passes while folder creation is completely broken. It did.
  F1B=$(mkfolder "{\"name\":\"contracts\",\"clientId\":$CLFID}")
  [ -n "$F1B" ] && [ "$F1" = "$F1B" ] && ok "same folder name reuses the existing folder" \
    || bad "duplicate folder created" "got '$F1B', expected '$F1'"

  F2=$(mkfolder "{\"name\":\"2026\",\"parentId\":$F1}")
  [ -n "$F2" ] && ok "nested folder created" || bad "nesting"

  # A file placed directly in the folder, and one placed via a path that
  # has to be built on the fly (the folder-upload route).
  TMPA=$(mktemp); echo "file-in-folder" > "$TMPA"
  FA=$(api -X POST "$BASE_URL/api/files?name=in-folder.txt&clientId=$CLFID&folderId=$F1" \
    -H "Content-Type: text/plain" --data-binary @"$TMPA" \
    | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  FB=$(api -X POST "$BASE_URL/api/files?name=deep.txt&clientId=$CLFID&folderId=$F1&path=Deep" \
    -H "Content-Type: text/plain" --data-binary @"$TMPA" \
    | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  rm -f "$TMPA"
  [ -n "$FA" ] && [ -n "$FB" ] && ok "files uploaded into folders" || bad "upload into folder"

  ROOT=$(api "$BASE_URL/api/files?clientId=$CLFID&folder=root")
  echo "$ROOT" | grep -q '"name":"Contracts"' && ok "root lists the folder" || bad "root folder listing"
  echo "$ROOT" | grep -q '"files":\[\]' && ok "files inside folders stay out of the root" \
    || bad "root listing leaked nested files"

  INSIDE=$(api "$BASE_URL/api/files?clientId=$CLFID&folder=$F1")
  echo "$INSIDE" | grep -q 'in-folder.txt' && ok "folder lists its own file" || bad "folder file listing"
  echo "$INSIDE" | grep -q '"name":"Deep"' && ok "upload path created the subfolder" \
    || bad "path-based folder creation"

  # With no client filter the top level must still list folders. It used
  # to return files only, which made every folder look like it had
  # vanished unless you first picked the right client.
  ALLC=$(api "$BASE_URL/api/files")
  echo "$ALLC" | grep -q '"name":"Contracts"' && ok "all-clients root lists folders too" \
    || bad "all-clients root hid the folders" "$(echo "$ALLC" | head -c 150)"
  echo "$ALLC" | grep -q '"clientName":"Smoke Folder Co"' \
    && ok "folder rows carry their client name" || bad "folder client name missing"

  CRUMB=$(api "$BASE_URL/api/files?clientId=$CLFID&folder=$F2")
  echo "$CRUMB" | grep -q '"breadcrumb":\[{"id":'"$F1" && ok "breadcrumb starts at the top folder" \
    || bad "breadcrumb" "$(echo "$CRUMB" | head -c 150)"

  # Deleting a folder must never destroy files. Nothing here is backed up,
  # so this is the check that matters most in this section.
  DELF=$(api -X DELETE "$BASE_URL/api/folders/$F1")
  echo "$DELF" | grep -q '"movedFiles":1' && ok "deleting a folder moves its file up a level" \
    || bad "folder delete moved the wrong number of files" "$DELF"

  code=$(api -o /dev/null -w '%{http_code}' "$BASE_URL/api/files/$FA/download")
  [ "$code" = "200" ] && ok "the file survived its folder being deleted" \
    || bad "file lost with its folder" "got $code"

  api -o /dev/null -X DELETE "$BASE_URL/api/files/$FA"
  api -o /dev/null -X DELETE "$BASE_URL/api/files/$FB"
  api -o /dev/null -X DELETE "$BASE_URL/api/crm/clients/$CLFID"
fi

# ---------------------------------------------------------- people

head_ "People"

PE=$(api -X POST "$BASE_URL/api/people" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Contractor","role":"Tester","engagement":"contractor","rateCents":6500}')
PEID=$(echo "$PE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$PEID" ]; then
  bad "could not create person" "$PE"
else
  ok "person created"
  echo "$PE" | grep -q '"rateCents":6500' && ok "rate stored as cents" || bad "rate handling"

  # No permission field should ever appear on a person record.
  echo "$PE" | grep -qE '"(access|permission|scope)"' \
    && bad "person record carries a permission field" "the app has no per-user access control" \
    || ok "no fabricated permission field"

  # Assignment round-trip via a throwaway project.
  PJ2=$(api -X POST "$BASE_URL/api/projects" -H 'Content-Type: application/json' -d '{"name":"smoke team project"}')
  PJ2ID=$(echo "$PJ2" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  if [ -n "$PJ2ID" ]; then
    api -o /dev/null -X POST "$BASE_URL/api/projects/$PJ2ID/team" \
      -H 'Content-Type: application/json' -d "{\"personId\":$PEID}"
    api "$BASE_URL/api/projects/$PJ2ID/detail" | grep -q 'Smoke Contractor' \
      && ok "person assigned to a project" || bad "team assignment"
    api -o /dev/null -X DELETE "$BASE_URL/api/projects/$PJ2ID"
  fi

  api -o /dev/null -X DELETE "$BASE_URL/api/people/$PEID"
fi

# ------------------------------------------------------------ mail

head_ "Mail"

MB=$(api "$BASE_URL/api/mailboxes")
echo "$MB" | grep -q '"mailboxes"' && ok "mailbox endpoint responds" || bad "mailbox endpoint"

INBOX=$(api "$BASE_URL/api/inbox")
if echo "$INBOX" | grep -q '"messages"'; then
  ok "inbox loads"
  ERRS=$(echo "$INBOX" | grep -o '"errors":\[[^]]*\]')
  [ "$ERRS" = '"errors":[]' ] && ok "no per-mailbox errors" || bad "mailbox errors present" "$ERRS"

  # Unread must come from IMAP STATUS, not from counting the loaded page.
  echo "$INBOX" | grep -q '"counts"' && ok "mailbox-wide counts reported" || bad "counts missing"

  # Paging: page 1 must return different messages than page 0.
  IDS0=$(echo "$INBOX" | grep -o '"id":"[0-9]*"' | head -5 | tr '\n' ' ')
  P1=$(api "$BASE_URL/api/inbox?page=1")
  IDS1=$(echo "$P1" | grep -o '"id":"[0-9]*"' | head -5 | tr '\n' ' ')
  if [ -z "$IDS1" ]; then
    ok "paging returns empty past the end (small mailbox)"
  elif [ "$IDS0" = "$IDS1" ]; then
    bad "paging returned the same messages" "page 0 and page 1 are identical"
  else
    ok "paging returns older messages"
  fi

  # Search is server-side; a nonsense term must narrow, not error.
  S=$(api "$BASE_URL/api/inbox?q=zzzqqqxxnomatch")
  if echo "$S" | grep -q '"messages"'; then
    N=$(echo "$S" | grep -o '"id":"[0-9]*"' | wc -l)
    [ "$N" -eq 0 ] && ok "search narrows to nothing for a nonsense term" \
                   || bad "search returned $N results for a nonsense term"
  else
    bad "search errored" "$(echo "$S" | head -c 200)"
  fi

  # Attachment endpoint must validate rather than 500.
  code=$(api -o /dev/null -w '%{http_code}' "$BASE_URL/api/inbox/attachment?account=nope@example.com&uid=1&index=0")
  [ "$code" = "400" ] && ok "attachment endpoint rejects unknown mailbox" || bad "attachment validation" "got $code"
else
  bad "inbox did not load" "$(echo "$INBOX" | head -c 200)"
fi

# ------------------------------------------------------ integrations

head_ "Integrations"

for p in calendly wave google; do
  R=$(api "$BASE_URL/api/$p/status")
  echo "$R" | grep -q '"connected"' && ok "$p status responds" || bad "$p status" "$(echo "$R" | head -c 120)"
done

FIN=$(api "$BASE_URL/api/finance")
echo "$FIN" | grep -q '"connected"' && ok "finance endpoint responds" || bad "finance endpoint"
  # Expenses ride along with the finance payload. Wave may legitimately
  # have no expense accounts in use, so the assertion is on the shape
  # being present, not on there being rows.
  FIN=$(api "$BASE_URL/api/finance")
  if echo "$FIN" | grep -q '"connected":true'; then
    echo "$FIN" | grep -q '"expenses"' && ok "finance payload carries expenses" || bad "expenses key missing"
    echo "$FIN" | grep -q '"expensesError":null' \
      && ok "the expense query succeeded against Wave" \
      || bad "expense query errored" "$(echo "$FIN" | grep -o '"expensesError":"[^"]*"' | head -c 200)"
  else
    ok "Wave not connected — expense checks skipped"
  fi

# ---------------------------------------------------------- summary

printf '\n----------------------------------------\n'
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
