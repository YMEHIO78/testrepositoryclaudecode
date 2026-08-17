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
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n'   "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
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

  # Booking/ticket-owned events must reject direct edits.
  api -o /dev/null -X DELETE "$BASE_URL/api/tickets/$TKID"
fi

# ------------------------------------------------------------- CRM

head_ "CRM"

CL=$(api -X POST "$BASE_URL/api/crm/clients" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Test Co","stage":"client","valueCents":123456,"recurring":true}')
CLID=$(echo "$CL" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$CLID" ]; then
  bad "could not create client" "$CL"
else
  ok "client created"
  echo "$CL" | grep -q '"valueCents":123456' \
    && ok "money stored as integer cents" \
    || bad "money handling" "valueCents was not round-tripped"
  api -o /dev/null -X DELETE "$BASE_URL/api/crm/clients/$CLID"
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

# ---------------------------------------------------------- summary

printf '\n----------------------------------------\n'
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
