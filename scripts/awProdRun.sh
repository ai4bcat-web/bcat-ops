#!/usr/bin/env bash
# awProdRun.sh: ONE guided runner for the production Aljex data load (Docs/tms-build/AW_PROD_RUN_GUIDE.md).
# Per step: DRY RUN -> parse counts -> compare to the EXPECTED table below -> PASS/FAIL table -> (only if all PASS) apply -> verify.
# Never prints/logs the password or e-mail: they live only in exported env vars BCAT_EMAIL / BCAT_PASSWORD (unset on exit).
# bash 3.2 compatible (macOS). Deps: node, aws. Tests: scripts/awProdRun.test.mjs.
#
#   scripts/awProdRun.sh [--suffix 5ucwdyvwivelbo4k4jomvrwel4] [--target dev|rehearsal] [--yes-if-all-pass] [--from STEP]
#                        [--only STEP] [--dry-only] [--files-dir DIR] [--resume] [--fresh-step STEP]
#                        [--expect STEP.METRIC=VALUE]   (restates a SOFT expected number on purpose; recorded in results.tsv)
# Test-only: AW_PROD_NONINTERACTIVE=1 reads answers from stdin and credentials from BCAT_EMAIL/BCAT_PASSWORD;
#            AWPROD_SCRIPTS_DIR points at a directory holding awProd.mjs + awProdRunHelper.mjs (fakes).
set -o pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS=${AWPROD_SCRIPTS_DIR:-$ROOT/scripts}
PROD_SFX=5ucwdyvwivelbo4k4jomvrwel4
DEV_SFX=nc3jsnxdmjhkpequimypiatkma
APP=d3dejqzs77khq6
CUTOFF=2026-11-07
ALL_STEPS="preflight settings backfill-check customers carriers tax-ids loads backfill ap-aging ap-expected ar reconcile"

SUFFIX="" ; TARGET=prod ; YES_ALL=0 ; FROM="" ; ONLY="" ; DRY_ONLY=0 ; FILES_DIR=/Users/adminoid/aljex-export
FRESH_STEPS=" " ; EXPECTS=" "
while [ $# -gt 0 ]; do
  case "$1" in
    --suffix) SUFFIX=$2; shift 2 ;;
    --target) TARGET=$2; shift 2 ;;
    --yes-if-all-pass) YES_ALL=1; shift ;;
    --from) FROM=$2; shift 2 ;;
    --only) ONLY=$2; shift 2 ;;
    --dry-only) DRY_ONLY=1; shift ;;
    --files-dir) FILES_DIR=$2; shift 2 ;;
    --resume) shift ;;
    --fresh-step) FRESH_STEPS="$FRESH_STEPS$2 "; shift 2 ;;
    --expect) EXPECTS="$EXPECTS$2 "; shift 2 ;;
    -h|--help) sed -n 2,14p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" = 0 ]; then echo "Refusing to run as root." >&2; exit 2; fi
case "$TARGET" in
  prod) [ -z "$SUFFIX" ] && SUFFIX=$PROD_SFX
        [ "$SUFFIX" = "$PROD_SFX" ] || { echo "Refusing: --suffix must be exactly $PROD_SFX for production." >&2; exit 2; }
        BRANCH=main ;;
  dev|rehearsal)
        want=$DEV_SFX
        [ "$TARGET" = rehearsal ] && want=$(BCAT_STACK=rehearsal node "$SCRIPTS/awProdRunHelper.mjs" suffix rehearsal 2>/dev/null | sed -n 's/^apiId=//p')
        [ -z "$SUFFIX" ] && SUFFIX=$want
        [ "$SUFFIX" = "$want" ] && [ -n "$want" ] || { echo "Refusing: --suffix does not match the $TARGET stack (production is never a test target)." >&2; exit 2; }
        BRANCH=dev; [ "$TARGET" = rehearsal ] && BRANCH=rh ;;
  *) echo "Refusing: --target must be dev or rehearsal (production is the default, no flag)." >&2; exit 2 ;;
esac
if [ ! -t 0 ] && [ "${AW_PROD_NONINTERACTIVE:-}" != 1 ]; then
  echo "Refusing: stdin is not a terminal. Run this in your own terminal (tests only: AW_PROD_NONINTERACTIVE=1)." >&2; exit 2
fi
if [ "${AW_PROD_NONINTERACTIVE:-}" = 1 ] && { [ -z "${BCAT_EMAIL:-}" ] || [ -z "${BCAT_PASSWORD:-}" ]; }; then
  echo "Refusing: AW_PROD_NONINTERACTIVE=1 needs BCAT_EMAIL and BCAT_PASSWORD in the environment." >&2; exit 2
fi
case "$FROM$ONLY" in ""|*) : ;; esac
for s in $FROM $ONLY; do case " $ALL_STEPS " in *" $s "*) : ;; *) echo "unknown step: $s" >&2; exit 2 ;; esac; done

trap 'unset BCAT_PASSWORD BCAT_EMAIL' EXIT INT TERM
[ "$TARGET" = prod ] && unset BCAT_STACK || export BCAT_STACK=$TARGET

# ---- run dir, transcript, state ------------------------------------------------------------------
LOGS=$HOME/bcat-ops-backups/aw-prod-logs
RUN_DIR=$LOGS/run-$(date +%Y%m%dT%H%M%S)
mkdir -p "$RUN_DIR" && chmod 700 "$LOGS" "$RUN_DIR"
TRANSCRIPT=$RUN_DIR/transcript.log
RESULTS=$RUN_DIR/results.tsv
RUN_STATE=$RUN_DIR/state.tsv
if [ "$TARGET" = prod ]; then GSTATE=$LOGS/STATE.tsv; GJOBS=$LOGS/JOBS.tsv; else GSTATE=$LOGS/STATE-$TARGET.tsv; GJOBS=$LOGS/JOBS-$TARGET.tsv; fi
: >> "$GSTATE"; : >> "$GJOBS"; : > "$RUN_STATE"
printf 'step\tmetric\texpected\tactual\tresult\n' > "$RESULTS"
FAILS=0 ; ANYFAIL=0 ; DRY_FAIL_NOTES=""

SCRUB_AWK='
BEGIN { p = ENVIRON["BCAT_PASSWORD"]; e = ENVIRON["BCAT_EMAIL"] }
{
  if (p != "") while ((i = index($0, p)) > 0) $0 = substr($0, 1, i - 1) "[hidden]" substr($0, i + length(p))
  if (e != "") while ((i = index($0, e)) > 0) $0 = substr($0, 1, i - 1) "[email]" substr($0, i + length(e))
  gsub(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z][A-Za-z]+/, "[email]")
  gsub(/\(?[0-9][0-9][0-9]\)?[ .-][0-9][0-9][0-9][ .-][0-9][0-9][0-9][0-9]/, "[phone]")
  gsub(/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]+/, "[digits]")
  if (match($0, /[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]/)) $0 = substr($0, 1, RSTART - 1) "password[hidden]"
  print; fflush()
}'
scrub() { awk "$SCRUB_AWK"; }
say() { printf '%s\n' "$*"; printf '%s\n' "$*" | scrub >> "$TRANSCRIPT"; }
if [ -t 1 ]; then GREEN=$(tput setaf 2 2>/dev/null); RED=$(tput setaf 1 2>/dev/null); YEL=$(tput setaf 3 2>/dev/null); RST=$(tput sgr0 2>/dev/null); else GREEN=""; RED=""; YEL=""; RST=""; fi

ask_yn() { # prompt -> 0 if y
  local a=""
  printf '%s ' "$1" >&2
  read -r a || a=""
  printf '%s %s\n' "$1" "answer: $a" | scrub >> "$TRANSCRIPT"
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
now_iso() { date -u +%FT%TZ; }
set_state() { # step status ; global state only for real (non dry-only) runs
  printf '%s\t%s\t%s\n' "$1" "$2" "$(now_iso)" >> "$RUN_STATE"
  [ "$DRY_ONLY" = 1 ] || printf '%s\t%s\t%s\n' "$1" "$2" "$(now_iso)" >> "$GSTATE"
}
get_state() { awk -F'\t' -v s="$1" '$1==s{v=$2} END{print v}' "$GSTATE"; }
save_job() { printf '%s\t%s\n' "$1" "$2" >> "$GJOBS"; }
get_job() { awk -F'\t' -v s="$1" '$1==s{v=$2} END{print v}' "$GJOBS"; }
is_done() { # state file, or the awProd file-step checkpoint marker
  [ "$(get_state "$1")" = DONE ] && return 0
  case "$1" in customers|carriers|ap-aging|ap-expected|ar)
    [ -f "$LOGS/$1.checkpoint.json" ] && grep -q '"applied:' "$LOGS/$1.checkpoint.json" 2>/dev/null && return 0 ;; esac
  return 1
}

# ---- expected table: step|phase|metric|type|op|expected|hard|runbook ---------------------------------
# phase D = dry run, A = after apply. type n|$|s. op = <= >= < ~N (+-N) in info. expected "@dry:KEY" = value from the dry run.
# hard=H is a stop condition that --expect can never restate.
expected_table() { cat <<'EOF'
settings|D|settings.action|s|in|SET,NOOP|H|Step 1a
settings|D|settings.default_row|s|=|yes|H|Step 1
settings|D|settings.counter|n|info|-|S|Step 1a
settings|A|verify_settings.seriesAt19999|n|=|1|H|Step 1 Expected
settings|A|verify_settings.numeric|n|=|1|H|Step 1 Expected
backfill-check|D|backfill_before.totalLoads|n|=|958|S|Step 3 Facts
backfill-check|D|backfill_before.matchedByPro|n|info|-|S|Step 3a (about 957)
backfill-check|D|backfill_before.linkedById|n|info|-|S|Step 3a (about 1)
backfill-check|D|backfill_before.ambiguous|n|=|0|H|Step 3a STOP
backfill-check|D|backfill_before.unmappable|n|=|0|H|Step 3a STOP
backfill-check|D|backfill_before.alreadyLinked|n|=|0|S|Step 3 Facts
backfill-check|D|backfill_before.beforeWindow|n|=|0|S|Step 3a
# CUTOFF RULE (2026-11-08, CutoffRule): the cutoff means BOOKED. afterCutoff = Loads CREATED on/after the cutoff (still a STOP, must be 0);
# carriedOver = Loads booked before it that ship on/after it (17 on 2026-11-08: PRO 14811..14939), kept in the window and linked.
backfill-check|D|backfill_before.afterCutoff|n|=|0|H|Step 3a STOP (created on/after the cutoff)
backfill-check|D|backfill_before.carriedOver|n|=|17|S|Step 3a (booked before the cutoff, shipping on/after it; informational)
backfill-check|D|derived.bucketsSum|s|=|yes|H|Step 3a
backfill-check|D|derived.evaluated|s|=|yes|H|Step 3a --evaluate
backfill-check|D|derived.dryEqualsEvaluate|s|=|yes|H|Step 3a
backfill-check|D|table.Shipment.before|n|=|0|S|Step 3 (Shipment empty before loads)
customers|D|uploaded.rows|n|=|761|S|Step 4a Expect
customers|D|CUSTOMER.staged|n|=|515|S|Step 4a Expect
customers|D|derived.customersTotal|n|=|515|S|Step 4a (created+matched+enriched)
customers|D|LOCATION.staged|n|=|245|S|Step 4a Expect
customers|D|excluded|n|=|1|S|Step 4a (TEST CUSTOMER)
customers|D|factor|n|~2|479|S|Step 4a Stop
customers|D|manual|n|~2|36|S|Step 4a Stop
customers|D|needsReview|n|<=|10|S|Step 4a Stop
customers|D|danisco120|n|=|2|S|Step 4a Expect
customers|D|duplicateGroups|n|info|-|S|Step 4a (32 documented)
customers|D|CUSTOMER.errors|n|=|0|H|Step 4a
customers|D|LOCATION.errors|n|=|0|H|Step 4a
customers|A|job.status|s|=|APPLIED|H|Step 4a
customers|A|table.Customer.delta|n|=|@dry:CUSTOMER.created|H|Step 4a Verify
customers|A|table.Location.delta|n|=|@dry:LOCATION.created|H|Step 4a Verify
carriers|D|uploaded.rows|n|=|2462|S|Step 4b Expect
carriers|D|CARRIER.staged|n|=|2442|S|Step 4b Expect (carriers)
carriers|D|otherVendorsSkipped|n|=|19|S|Step 4b Expect
carriers|D|inactive|n|=|252|S|Step 4b Expect
carriers|D|withFactorId|n|=|183|S|Step 4b Expect
carriers|D|quickPay|n|=|14|S|Step 4b Expect
carriers|D|derived.strippedAll|s|=|yes|H|Step 4b (bank/routing/tax not imported)
carriers|D|rowsWithFedSs|n|=|0|H|Step 4b Stop
carriers|D|rowsWithBankAccount|n|=|0|H|Step 4b Stop
carriers|D|rowsWithRouting|n|=|0|H|Step 4b Stop
carriers|D|CARRIER.errors|n|=|0|H|Step 4b
carriers|A|job.status|s|=|APPLIED|H|Step 4b
carriers|A|table.Carrier.delta|n|=|@dry:CARRIER.created|H|Step 4b Verify
tax-ids|D|tax-ids.rows|n|=|2462|S|Step 4b-tax
tax-ids|D|tax-ids.withValue|n|info|-|S|Step 4b-tax (counts only)
tax-ids|D|tax-ids.resolvable|n|info|-|S|Step 4b-tax
tax-ids|D|tax-ids.unresolvable|n|info|-|S|Step 4b-tax
# Loads rows below recomputed for the cutoff-means-BOOKED rule (no upper bound on ship date) from aljex-full-export-2026-11-07.csv with the real
# STAGE + PLAN on an empty dev store: 8347 rows = 7944 LOAD + 403 memo; LOAD skipped = 2601 older than 2024-11-07 + 4 identical duplicates = 2605
# (was 2626 with the 21 rows shipping on/after 2026-11-07 skipped); LOAD created+matched = 7944 - 2605 = 5339 (was 5318).
loads|D|stage.rows|n|=|8347|H|Step 4c Stop (rows)
loads|D|LOAD.staged|n|=|7944|S|Step 4c (7944 LOAD rows)
loads|D|LOAD.skipped|n|=|2605|S|Step 4c (2601 before 2024-11-07 + 4 duplicates; the 21 shipping after the cutoff are KEPT)
loads|D|stage.duplicatePros|n|=|4|S|Step 4c (4 repeated PROs)
loads|D|LOAD.conflicts|n|=|0|H|Step 4c Stop (AMBIGUOUS/CONFLICT)
loads|D|derived.loadSum|s|=|yes|H|Step 4c
loads|D|derived.anyErrors|n|=|0|H|Step 4c
loads|D|LOAD.created|n|info|-|S|Step 4c (CREATE count)
loads|D|LOAD.matched|n|info|-|S|Step 4c (LINK about 957)
loads|A|reconciled|s|=|YES|H|Step 4c Verify
loads|A|conservation|s|=|OK|H|Step 4c Verify
loads|A|table.Load.delta|n|>=|0|H|Step 4c Stop (Load count must not decrease)
loads|A|table.Load.delta|n|=|@dry:LOAD.created|S|Step 4c (958 + CREATE)
backfill|D|backfill_before.matchedByPro|n|=|0|S|Step 4c-bis
backfill|D|backfill_before.linkedById|n|info|-|S|Step 4c-bis (about 1)
backfill|D|backfill_before.ambiguous|n|=|0|H|Step 4c-bis
backfill|D|backfill_before.unmappable|n|=|0|H|Step 4c-bis
backfill|D|backfill_before.afterCutoff|n|=|0|H|Step 4c-bis (created on/after the cutoff)
backfill|D|backfill_before.carriedOver|n|info|-|S|Step 4c-bis (17 carried over)
backfill|D|derived.bucketsSum|s|=|yes|H|Step 4c-bis
backfill|D|table.Shipment.before|n|>=|1|H|Step 4c-bis (run loads first)
backfill|A|backfill_after.linkedById|n|=|0|H|Step 4c-bis Expect
backfill|A|backfill_after.matchedByPro|n|=|0|H|Step 4c-bis Expect
backfill|A|backfill_after.ambiguous|n|=|0|H|Step 4c-bis Expect
ap-aging|D|uploaded.rows|n|=|67|S|Step 4d
ap-aging|D|apAging.bills|n|=|67|S|Step 4d
ap-aging|D|apAging.totalCents|$|=|83407.20|S|Step 4d
ap-aging|D|tieout.apBucket:D0_30.file|$|=|66642.20|S|Step 4d
ap-aging|D|tieout.apBucket:D31_60.file|$|=|16765.00|S|Step 4d
ap-aging|D|tieout.apBucket:D61_90.file|$|=|0.00|S|Step 4d
ap-aging|D|apAging.unresolved|n|=|0|H|Step 4d STOP
ap-aging|D|apAging.rejected|n|=|0|H|Step 4d
ap-aging|A|job.status|s|=|APPLIED|H|Step 4d
ap-aging|A|table.CarrierBill.delta|n|=|@dry:BILL.created|H|Step 4d Verify
ap-aging|A|tieout.apAgingTotal.diff|$|=|0.00|H|Step 4d tie-out diff $0.00
ap-expected|D|uploaded.rows|n|=|36|S|Step 4e
ap-expected|D|apExpected.rows|n|=|36|S|Step 4e
ap-expected|D|apExpected.expected|n|=|24|S|Step 4e
ap-expected|D|apExpected.expectedCents|$|=|27706.47|S|Step 4e
ap-expected|D|apExpected.droppedStale|n|=|12|S|Step 4e
ap-expected|D|apExpected.droppedStaleCents|$|=|7562.71|S|Step 4e
ap-expected|D|derived.apExpectedFileTotal|$|=|35269.18|S|Step 4e
ap-expected|D|apExpected.rejected|n|=|0|H|Step 4e
ap-expected|A|job.status|s|=|APPLIED|H|Step 4e
ar|D|uploaded.rows|n|=|296|S|Step 4f
ar|D|invoices|n|=|296|S|Step 4f
ar|D|totalCents|$|=|357753.44|S|Step 4f
ar|D|invoiceTotalCents|$|=|361203.44|S|Step 4f
ar|D|previousPaidCents|$|=|3450.00|S|Step 4f
ar|D|partialCount|n|=|3|S|Step 4f
ar|D|byBucket.D0_30|$|=|216416.34|S|Step 4f
ar|D|byBucket.D31_60|$|=|62201.30|S|Step 4f
ar|D|byBucket.D61_90|$|=|30005.50|S|Step 4f
ar|D|byBucket.D91_120|$|=|14874.95|S|Step 4f
ar|D|byBucket.D121_PLUS|$|=|34255.35|S|Step 4f
ar|D|derived.bcatBucketSum|$|=|357753.44|H|Step 4f (BCAT buckets differ only by redated Danisco)
ar|D|derived.redatedEqTerms90|s|=|yes|H|Step 4f (redated Danisco = Aljex 90-day rows)
ar|D|redated.count|n|info|-|S|Step 4f (54 or 55: dry run decides)
ar|D|tieout.arInvoiceMinusPayments.diff|$|=|0.00|H|Step 4f
ar|D|tieout.arPreviousPayments.diff|$|=|0.00|H|Step 4f
ar|D|unresolved|n|=|0|H|Step 4f STOP
stage-export|A|staged.rows|n|=|8347|H|Step 4c-0 Expect
ar|A|job.status|s|=|APPLIED|H|Step 4f
ar|A|table.Invoice.delta|n|=|@dry:INVOICE.created|H|Step 4f Verify
ar|A|table.ArPayment.delta|n|=|@dry:priorPaymentsCreated|H|Step 4f Verify
ar|A|tieout.arTotal.diff|$|=|0.00|H|Step 4f Verify (cent-exact)
rec-CUSTOMERS|A|rec.matched|n|=|515|S|Step 5
rec-CARRIERS|A|rec.matched|n|=|2442|S|Step 5
rec-AP|A|rec.money.aljex|$|=|83407.20|S|Step 5
rec-AP|A|rec.money.diff|$|=|0.00|S|Step 5
rec-AR|A|rec.money.aljex|$|=|357753.44|S|Step 5
rec-AR|A|rec.money.diff|$|=|0.00|S|Step 5
rec-SHIPMENTS|A|rec.aljexRows|n|info|-|S|Step 5
EOF
}

# ---- parser: one awk program turns awProd / awImport / importAljex output (+ its log) into "metric<TAB>value" -----------
PARSE_AWK='
function money(s) { gsub(/\$/, "", s); gsub(/,/, "", s); return s }
function nocomma(s) { while (match(s, /[0-9],[0-9][0-9][0-9]/)) s = substr(s, 1, RSTART) substr(s, RSTART + 2); return s }
function put(k, v) { val[k] = v; if (!(k in seen)) { seen[k] = 1; order[++n] = k } }
function pairs(prefix, rest,   parts, np, i, w, nw, key, v) {
  rest = nocomma(rest); np = split(rest, parts, /, /)
  for (i = 1; i <= np; i++) { nw = split(parts[i], w, " "); if (nw >= 2) { v = w[nw]; key = w[1]; for (j = 2; j < nw; j++) key = key "_" w[j]; put(prefix "." key, money(v)) } }
}
{
  line = $0
  if (line ~ /^  [A-Z_]+ +staged [0-9]+/) {
    nw = split(line, w, " "); ent = w[1]
    for (i = 2; i < nw; i += 2) put(ent "." w[i], w[i + 1])
    errs += w[nw]
    if (ent == "LOAD") { ls = w[3]; lsum = w[5] + w[7] + w[9] + w[11] + w[13] }
    if (ent ~ /^(CUSTOMER|LOCATION|CARRIER|INVOICE|BILL)$/ && 0) {}
  } else if (line ~ /^  tie-out /) {
    t = nocomma(line); sub(/^  tie-out +/, "", t); nw = split(t, w, " ")
    put("tieout." w[1] ".file", money(w[3])); put("tieout." w[1] ".bcat", money(w[5])); put("tieout." w[1] ".diff", money(w[7]))
  } else if (line ~ /^== .* job /) {
    if (match(line, /job [^ ]+ [A-Z]+/)) { t = substr(line, RSTART + 4, RLENGTH - 4); split(t, w, " "); put("job.id", w[1]); put("job.status", w[2]) }
    if (line ~ /big export staged/) { t = line; sub(/.*job /, "", t); sub(/,.*/, "", t); put("staged.job", t); u = line; sub(/.*, /, "", u); t = line; sub(/ rows.*/, "", t); sub(/.*, /, "", t); put("staged.rows", t) }
  } else if (line ~ /^  uploaded [A-Z_]+: job /) {
    t = line; sub(/^.*job /, "", t); nw = split(t, w, " "); put("upload.job", w[1]); put("uploaded.rows", w[2])
  } else if (line ~ /^  stripped before upload: /) {
    t = line; sub(/^  stripped before upload: /, "", t); put("stripped", t)
  } else if (line ~ /^  rows with a value in the columns/) {
    t = nocomma(line); put("sens.line", "seen")
  } else if (line ~ /^  every row matched: /) { put("everyRowMatched", substr(line, 22))
  } else if (line ~ /^  needs a look: /) { split(line, w, " "); put("needsLook", w[4])
  } else if (line ~ /^  [A-Za-z0-9]+: / && line !~ /^  money: /) {
    t = line; sub(/^  /, "", t); name = t; sub(/:.*/, "", name); rest = t; sub(/^[^:]*: /, "", rest)
    rest = nocomma(rest)
    if (rest ~ /,/ || (rest ~ / / && name ~ /^(byBucket|byBucketBcat|termsCounts|redated|apAging|apExpected|findings)$/)) {
      if (name ~ /^byBucket/) { np = split(rest, parts, /, /); for (i = 1; i <= np; i++) { split(parts[i], w, " "); put(name "." w[1], sprintf("%.2f", w[2] / 100)) } }
      else pairs(name, rest)
    } else if (rest !~ / /) put(name, money(rest))
    else if (name ~ /^byBucket/) { split(rest, w, " "); put(name "." w[1], sprintf("%.2f", w[2] / 100)) }
    else if (name == "redated" || name == "termsCounts") pairs(name, rest)
  } else if (line ~ /^STAGE .*rows \(/) {
    t = line; sub(/^STAGE [^:]*: /, "", t); split(t, w, " "); put("stage.rows", w[1])
    if (match(line, /[0-9]+ identical duplicates/)) { split(substr(line, RSTART, RLENGTH), w, " "); put("stage.duplicatePros", w[1]) }
  } else if (line ~ /conservation [A-Z]+ +reconciled [A-Z]+/) {
    nw = split(line, w, " "); for (i = 1; i < nw; i++) { if (w[i] == "conservation") put("conservation", w[i + 1]); if (w[i] == "reconciled") put("reconciled", w[i + 1]) }
  } else if (line ~ /^table [A-Za-z]+: before /) {
    t = line; sub(/^table /, "", t); m = t; sub(/:.*/, "", m)
    if (match(t, /before [-0-9]+/)) put("table." m ".before", substr(t, RSTART + 7, RLENGTH - 7))
    if (match(t, /after [-0-9]+/)) put("table." m ".after", substr(t, RSTART + 6, RLENGTH - 6))
    if (match(t, /delta -?[0-9]+/)) put("table." m ".delta", substr(t, RSTART + 6, RLENGTH - 6))
  } else if (line ~ /^settings plan: /) {
    t = line; sub(/^settings plan: /, "", t); split(t, w, " "); put("settings.action", w[1])
    put("settings.default_row", (t ~ /does not exist/) ? "no" : "yes")
    if (match(t, /counter [0-9]+ ->/)) put("settings.counter", substr(t, RSTART + 8, RLENGTH - 11))
  } else if (line ~ /^Aljex rows|^  Aljex rows/) {
    t = line; sub(/^ +/, "", t); nw = split(t, w, "  +")
    for (i = 1; i <= nw; i++) { k = w[i]; if (k ~ /^Aljex rows /) put("rec.aljexRows", substr(k, 12)); else if (k ~ /^BCAT rows /) put("rec.bcatRows", substr(k, 11)); else if (k ~ /^matched /) put("rec.matched", substr(k, 9)); else if (k ~ /^Aljex-only /) put("rec.aljexOnly", substr(k, 12)); else if (k ~ /^BCAT-only /) put("rec.bcatOnly", substr(k, 11)); else if (k ~ /^mismatched /) put("rec.mismatched", substr(k, 12)); else if (k ~ /^differences /) put("rec.differences", substr(k, 13)) }
  } else if (line ~ /^  money: Aljex /) {
    t = nocomma(line); nw = split(t, w, " "); put("rec.money.aljex", money(w[3])); put("rec.money.bcat", money(w[5])); put("rec.money.diff", money(w[7]))
  } else if (line ~ /refusals not evaluated/) { notEval = 1
  } else if (line ~ /^[A-Za-z][A-Za-z -]*: ([A-Za-z0-9]+=-?[0-9]+ ?)+$/) {
    label = line; sub(/:.*/, "", label); gsub(/ /, "_", label); t = line; sub(/^[^:]*: /, "", t); np = split(t, parts, " ")
    for (i = 1; i <= np; i++) { split(parts[i], kv, "="); put(label "." kv[1], kv[2]) }
  }
}
END {
  # derived
  c = val["customersCreated"] + val["customersMatched"] + val["customersEnriched"]
  if (("customersCreated" in val)) put("derived.customersTotal", c)
  if (("backfill_before.loads" in val)) { s = val["backfill_before.matchedByPro"] + val["backfill_before.linkedById"] + val["backfill_before.ambiguous"] + val["backfill_before.unmappable"] + val["backfill_before.alreadyLinked"]; put("derived.bucketsSum", (s == val["backfill_before.loads"]) ? "yes" : "no") }
  put("derived.evaluated", notEval ? "no" : "yes")
  if (("stripped" in val)) put("derived.strippedAll", (val["stripped"] ~ /Fed\/SS #/ && val["stripped"] ~ /Bank Account/ && val["stripped"] ~ /Routing #/) ? "yes" : "no")
  if (("LOAD.staged" in val)) put("derived.loadSum", (ls == lsum) ? "yes" : "no")
  put("derived.anyErrors", errs + 0)
  if (("apExpected.expectedCents" in val)) put("derived.apExpectedFileTotal", sprintf("%.2f", val["apExpected.expectedCents"] + val["apExpected.droppedStaleCents"]))
  if (("byBucketBcat.D0_30" in val)) put("derived.bcatBucketSum", sprintf("%.2f", val["byBucketBcat.D0_30"] + val["byBucketBcat.D31_60"] + val["byBucketBcat.D61_90"] + val["byBucketBcat.D91_120"] + val["byBucketBcat.D121_PLUS"]))
  if (("redated.count" in val)) put("derived.redatedEqTerms90", (val["redated.count"] == val["termsCounts.90"]) ? "yes" : "no")
  for (i = 1; i <= n; i++) printf "%s\t%s\n", order[i], val[order[i]]
}'
parse_out() { awk "$PARSE_AWK" "$1" > "$2"; }
metric_of() { awk -F'\t' -v k="$2" '$1==k{v=$2} END{print v}' "$1"; }

# ---- compare ---------------------------------------------------------------------------------------
cmp_ok() { # type op expected actual -> exit 0 when ok
  awk -v t="$1" -v op="$2" -v e="$3" -v a="$4" 'BEGIN {
    if (t == "$") { e = sprintf("%.0f", e * 100); a = sprintf("%.0f", a * 100) }
    if (op == "=") ok = (t == "s") ? (e == a) : (e + 0 == a + 0)
    else if (op == "<=") ok = (a + 0 <= e + 0)
    else if (op == ">=") ok = (a + 0 >= e + 0)
    else if (op == "<") ok = (a + 0 < e + 0)
    else if (op ~ /^~/) { d = substr(op, 2) + 0; x = a - e; if (x < 0) x = -x; ok = (x <= d) }
    else if (op == "in") { n = split(e, w, ","); ok = 0; for (i = 1; i <= n; i++) if (w[i] == a) ok = 1 }
    else ok = 0
    exit ok ? 0 : 1 }'
}
FAIL_LIST=""
# compare <step> <phase> <metrics file> [dry metrics file] ; sets CMP_FAILS
compare() {
  local step=$1 phase=$2 mf=$3 dryf=${4:-} line metric type op exp hard ref act ov res shown
  CMP_FAILS=0 ; FAIL_LIST=""
  say ""
  say "$(printf '%-14s %-40s %-16s %-16s %s' "$step ($phase)" METRIC EXPECTED ACTUAL RESULT)"
  while IFS='|' read -r s ph metric type op exp hard ref; do
    [ "$s" = "$step" ] && [ "$ph" = "$phase" ] || continue
    act=$(metric_of "$mf" "$metric")
    shown=$exp
    case "$exp" in @dry:*) exp=$(metric_of "$dryf" "${exp#@dry:}"); shown="$exp (dry)" ;; esac
    ov=""
    if [ "$hard" = S ]; then
      for o in $EXPECTS; do case "$o" in "$step.$metric="*) ov=${o#*=}; exp=$ov; shown="$ov (override)" ;; esac; done
    fi
    if [ "$op" = info ]; then res=INFO
    elif [ -z "$act" ]; then res=FAIL; act="(not found)"
    elif cmp_ok "$type" "$op" "$exp" "$act"; then res=PASS
    else res=FAIL; fi
    if [ "$TARGET" != prod ] && [ "$metric" = derived.evaluated ] && [ "$res" = FAIL ]; then res=INFO; fi
    case "$op" in "~"*) shown="$exp +-${op#\~}" ;; "<="|">="|"<") shown="$op $exp" ;; esac
    printf '%s\t%s\t%s\t%s\t%s\n' "$step" "$metric" "$shown" "$act" "$res" >> "$RESULTS"
    local color=""; case "$res" in PASS) color=$GREEN ;; FAIL) color=$RED ;; *) color=$YEL ;; esac
    say "$(printf '%-14s %-40s %-16s %-16s %s' "" "$metric" "$shown" "$act" "$color$res$RST")"
    if [ "$res" = FAIL ]; then CMP_FAILS=$((CMP_FAILS + 1)); FAIL_LIST="$FAIL_LIST $metric(expected $shown, got $act; $ref)"; fi
  done <<EOF
$(expected_table)
EOF
  return $CMP_FAILS
}

rollback_for() { case "$1" in
  settings) echo "TmsSettings+AuditLog: aws dynamodb update-item revert of nextShipmentNumber to the value in the settings log (runbook Step 1 Rollback)" ;;
  customers) echo "Customer, Location, AljexImportJob, AuditLog: restore from the fresh backup or delete by importRunId (runbook Step 4a Rollback)" ;;
  carriers) echo "Carrier, AljexImportJob, AuditLog: empty by importRunId / restore (runbook Step 4b Rollback)" ;;
  tax-ids) echo "CarrierTaxVault + Carrier mirror fields: CLEAR_TAX_ID per carrier (runbook Step 4b-tax Rollback)" ;;
  loads|stage-export) echo "importAljex.mjs rollback --run <applyJobId> --target prod:<tag> --i-mean-production, or per-table restore of the prodpre-importAljex-* backups (runbook Step 4c Rollback)" ;;
  backfill|backfill-check) echo "delete deterministic Shipment/Order/LoadCharge/ProClaim items and REMOVE shipmentId, orderId, loadNumber, leg on the Load (runbook Step 4c-bis Rollback)" ;;
  ap-aging|ap-expected) echo "CarrierBill, LoadCarrier, AljexImportJob, AuditLog: empty by importRunId / restore (runbook Step 4d/4e Rollback)" ;;
  ar) echo "Invoice, ArPayment, Order link, AljexImportJob, AuditLog: empty by importRunId / restore (runbook Step 4f Rollback)" ;;
  reconcile|rec-*) echo "delete the RECONCILE AljexImportJob items (runbook Step 5 Rollback)" ;;
  *) echo "see the Whole-load rollback summary in AW_PROD_DATA_RUNBOOK.md" ;; esac; }
section_for() { case "$1" in
  preflight) echo "Step 0 Preflight" ;; settings) echo "Step 1 Settings" ;; backfill-check|backfill) echo "Step 3 / 4c-bis (backfill)" ;;
  customers) echo "Step 4a Customers" ;; carriers) echo "Step 4b Carriers" ;; tax-ids) echo "Step 4b-tax" ;; loads) echo "Step 4c Loads" ;;
  ap-aging) echo "Step 4d AP aging" ;; ap-expected) echo "Step 4e AP expected" ;; ar) echo "Step 4f AR" ;; *) echo "Step 5 Reconciliation" ;; esac; }

# ---- summary / stop ---------------------------------------------------------------------------------
print_summary() {
  say ""; say "================ SUMMARY ================"
  local s st
  for s in $ALL_STEPS; do
    st=$(awk -F'\t' -v s="$s" '$1==s{v=$2} END{print v}' "$RUN_STATE")
    if [ -z "$st" ] && is_done "$s"; then st="DONE (earlier run)"; fi
    [ -z "$st" ] && st="not run"
    say "$(printf '  %-15s %s' "$s" "$st")"
  done
  say "PASS rows: $(grep -c 'PASS$' "$RESULTS")  FAIL rows: $(grep -c 'FAIL$' "$RESULTS")"
  say "Run dir: $RUN_DIR  (transcript.log, results.tsv, state.tsv; per-step logs: $LOGS)"
  say "Rollback pointers (runbook Whole-load rollback summary): see AW_PROD_DATA_RUNBOOK.md"
  say "UI-only steps still yours (see AW_PROD_RUN_GUIDE.md): invoice copy, default terms, Aljex cutoff, Divisions & ownership (+Ensure seed), Users/Jenny groups, Billing setup review, Aljex reconciliation sign-off by Jenny, Integrations keys."
}
stop_fail() { # step failures...
  local step=$1
  ANYFAIL=1
  say ""
  say "${RED}STOP: $step failed.${RST}"
  say "Failed numbers:$FAIL_LIST"
  say "Read: AW_PROD_DATA_RUNBOOK.md -> $(section_for "$step")"
  say "Rollback pointer: $(rollback_for "$step")"
  set_state "$step" FAILED
  print_summary
  exit 1
}

# ---- running the CLI -------------------------------------------------------------------------------
BP_AGE="" ; LAST_OUT="" ; LAST_RC=0
# cli_run <outfile> <awProd step> args... : runs the step CLI (awProd.mjs in prod; the matching test-mode CLI otherwise)
cli_run() {
  local out=$1 step=$2; shift 2
  : > "$out"
  if [ "$TARGET" = prod ]; then
    node "$SCRIPTS/awProd.mjs" "$step" --suffix "$SUFFIX" "$@" </dev/null 2>&1 | scrub | tee -a "$TRANSCRIPT" "$out"
    LAST_RC=${PIPESTATUS[0]}
  else
    dev_cli "$step" "$@" </dev/null 2>&1 | scrub | tee -a "$TRANSCRIPT" "$out"
    LAST_RC=${PIPESTATUS[0]}
  fi
  local lp
  for lp in $(sed -n 's/^log: //p' "$out"); do [ -f "$lp" ] && scrub < "$lp" >> "$out"; done
  LAST_OUT=$out
  return "$LAST_RC"
}
dev_cli() { # test mode translation of an awProd step line to the non-production tools
  local step=$1; shift
  local args=() skip=0 a apply=0 flag=""
  for a in "$@"; do
    if [ $skip = 1 ]; then skip=0; continue; fi
    case "$a" in --plan) ;; --suffix) skip=1 ;; --apply) apply=1; args+=("$a") ;; *) args+=("$a") ;; esac
  done
  case "$step" in
    customers|carriers|ar) node "$SCRIPTS/awImport.mjs" "$step" --outputs "$RUN_DIR/dev-outputs.json" ${args[@]+"${args[@]}"} ;;
    ap-aging|ap-expected)
      flag=--aging-file; [ "$step" = ap-expected ] && flag=--expected-file
      local fixed=() prev=""
      for a in ${args[@]+"${args[@]}"}; do if [ "$a" = --file ]; then fixed+=("$flag"); else fixed+=("$a"); fi; done
      node "$SCRIPTS/awImport.mjs" ap --outputs "$RUN_DIR/dev-outputs.json" ${fixed[@]+"${fixed[@]}"} ;;
    stage-export) if [ $apply = 1 ]; then node "$SCRIPTS/awImport.mjs" stage-export --outputs "$RUN_DIR/dev-outputs.json" ${args[@]+"${args[@]}"}; else echo "stage-export local check: bytes=1"; fi ;;
    reconcile) if [ $apply = 1 ]; then node "$SCRIPTS/awImport.mjs" reconcile --outputs "$RUN_DIR/dev-outputs.json" ${args[@]+"${args[@]}"}; else echo "reconcile: would start a reconciliation job"; fi ;;
    settings) if [ $apply = 1 ]; then echo "test mode: settings apply is not supported" >&2; return 3; fi; node "$SCRIPTS/awProdRunHelper.mjs" dev-settings ;;
    backfill) if [ $apply = 1 ]; then echo "test mode: backfill apply is not supported" >&2; return 3; fi; node "$SCRIPTS/awProdRunHelper.mjs" dev-backfill ${args[@]+"${args[@]}"} ;;
    loads) if [ $apply = 1 ]; then echo "test mode: loads apply is not supported" >&2; return 3; fi
           local src=""; for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[$i]}" = --source ] && src=${args[$((i + 1))]}; done
           node "$SCRIPTS/importAljex.mjs" run --source "$src" --target live:awtest1 --no-apply ;;
    verify|tax-ids) echo "test mode: $step has no non-production equivalent" ;;
    *) echo "test mode: unknown step $step" >&2; return 2 ;;
  esac
}
TODAY=$(date +%F) ; MMDD=$(date +%m%d)
LIVE_TAG=AW-PROD-$MMDD ; LOADS_TAG=awprod$MMDD

# ---- environment re-check (between steps) ---------------------------------------------------------
env_state() { # prints "status running stage" ; read-only aws metadata
  local st run stage
  st=$(aws cloudformation list-stacks --query "StackSummaries[?starts_with(StackName,'amplify-$APP-$BRANCH-branch-') && StackStatus!='DELETE_COMPLETE' && ParentId==null].[CreationTime,StackStatus]" --output text 2>/dev/null | sort -r | head -1 | awk '{print $2}')
  run=$(aws amplify list-jobs --app-id "$APP" --branch-name "$BRANCH" --max-results 10 --query 'jobSummaries[].status' --output text 2>/dev/null | tr '\t' '\n' | grep -c -E '^(RUNNING|PENDING|PROVISIONING)$')
  stage=$(aws amplify get-branch --app-id "$APP" --branch-name "$BRANCH" --query 'branch.environmentVariables.BCAT_SCHEMA_STAGE' --output text 2>/dev/null)
  case "$stage" in ""|None|null) stage=4 ;; esac
  echo "${st:-NOT_FOUND} ${run:-0} $stage"
}
recheck_env() { # step
  local s r g
  set -- $(env_state)
  s=$1 r=$2 g=$3
  if [ "$s" != UPDATE_COMPLETE ] || [ "$r" != 0 ]; then
    FAIL_LIST=" root stack $s (must be UPDATE_COMPLETE), running Amplify jobs $r (must be 0)"
    printf '%s\t%s\t%s\t%s\t%s\n' "$CURRENT" env-recheck "UPDATE_COMPLETE/0" "$s/$r" FAIL >> "$RESULTS"
    return 1
  fi
  return 0
}

# ---- credentials -------------------------------------------------------------------------------------
say "awProdRun: target=$TARGET suffix=$SUFFIX run dir=$RUN_DIR"
if [ "$TARGET" = prod ]; then
  say "This is PRODUCTION (Amplify app $APP, branch main)."
  printf 'Type the word PRODUCTION to continue: ' >&2
  read -r word || word=""
  printf 'PRODUCTION prompt answered: %s\n' "$([ "$word" = PRODUCTION ] && echo yes || echo no)" >> "$TRANSCRIPT"
  [ "$word" = PRODUCTION ] || { say "Not confirmed. Nothing was done."; exit 2; }
fi
if [ "$TARGET" != prod ]; then node "$SCRIPTS/awProdRunHelper.mjs" dev-outputs "$TARGET" "$RUN_DIR/dev-outputs.json" >/dev/null 2>&1; fi
# Credentials are asked ONLY when a step that still goes through the staff-signed Lambda/AppSync API runs: backfill-check
# (--evaluate) and backfill. The per-file imports, the big-export stage, the loads and the reconcile run OFFLINE with AWS credentials.
LOGGED_IN=0
need_login() {
  [ "$LOGGED_IN" = 1 ] && return 0
  if [ "${AW_PROD_NONINTERACTIVE:-}" != 1 ]; then
    printf 'Admin e-mail (production staff pool; needed by backfill only): ' >&2; read -r BCAT_EMAIL
    printf 'Password (hidden): ' >&2; read -rs BCAT_PASSWORD; printf '\n' >&2
  fi
  export BCAT_EMAIL BCAT_PASSWORD
  say "credentials entered (not logged)"
  CURRENT=login
  if ! node "$SCRIPTS/awProdRunHelper.mjs" login "$TARGET" 2>&1 | scrub | tee -a "$TRANSCRIPT" | grep -q 'login: OK'; then
    say "${RED}Login failed: check the e-mail/password (an ADMIN of the staff pool). Nothing was done.${RST}"; exit 1
  fi
  LOGGED_IN=1
}

# ---- files -------------------------------------------------------------------------------------------
F_CUST=$FILES_DIR/aljex-customers-2026-11-08.csv
F_CARR=$FILES_DIR/aljex-carriers-2026-11-08.csv
F_APA=$FILES_DIR/aljex-ap-aging-2026-11-08.csv
F_APE=$FILES_DIR/aljex-ap-expected-2026-11-08.csv
F_AR=$FILES_DIR/aljex-ar-2026-11-07.csv
F_BIG=$FILES_DIR/aljex-full-export-2026-11-07.csv
PROS=$RUN_DIR/export-keys.txt
trap 'rm -f "$PROS"; unset BCAT_PASSWORD BCAT_EMAIL' EXIT INT TERM

should_run() { # step
  local s=$1
  [ "$s" = stage-export ] && s=loads
  if [ -n "$ONLY" ]; then [ "$ONLY" = "$s" ] && return 0; [ "$s" = preflight ] && return 0; return 1; fi
  if [ -n "$FROM" ] && [ "$s" != preflight ]; then
    case " $ALL_STEPS " in *" $FROM "*) : ;; esac
    local seen=0 x; for x in $ALL_STEPS; do [ "$x" = "$FROM" ] && seen=1; [ "$x" = "$s" ] && { [ $seen = 1 ] && return 0 || return 1; }; done
  fi
  return 0
}
need_rerun() { case "$FRESH_STEPS" in *" $1 "*) return 0 ;; esac; return 1; }
already_done() { # step -> 0 when it should be skipped as DONE
  need_rerun "$1" && return 1
  is_done "$1" || return 1
  say "[$1] DONE (checkpoint / state marker): skipped"; return 0
}

# ---- preflight -----------------------------------------------------------------------------------------
pf() { # metric expected actual result
  printf '%s\t%s\t%s\t%s\t%s\n' preflight "$1" "$2" "$3" "$4" >> "$RESULTS"
  local c=$GREEN; [ "$4" = FAIL ] && c=$RED; [ "$4" = INFO ] && c=$YEL
  say "$(printf '  %-38s %-18s %-22s %s' "$1" "$2" "$3" "$c$4$RST")"
  if [ "$4" = FAIL ]; then PF_FAILS=$((PF_FAILS + 1)); fi
  return 0
}
mtime_of() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }
step_preflight() {
  CURRENT=preflight; PF_FAILS=0
  say ""; say "== PREFLIGHT (read-only) =="
  local stamp=$HOME/bcat-ops-backups/LATEST_BACKUP_STAMP age="" m
  if [ -f "$stamp" ]; then m=$(mtime_of "$stamp"); age=$(( ($(date +%s) - m) / 60 )); fi
  if [ -n "$age" ] && [ "$age" -le 360 ] && [ "$age" -ge -1 ]; then pf "backup stamp age (min)" "<= 360" "$age" PASS
  elif [ "$DRY_ONLY" = 1 ]; then pf "backup stamp age (min)" "<= 360" "${age:-missing}" INFO; say "  (dry-only: an apply would be refused until the stamp is fresh)"
  else
    pf "backup stamp age (min)" "<= 360" "${age:-missing}" FAIL
    say "  If you have just finished a fresh backup, type its exact path (a directory made in the last 6 h) to stamp it, or press Enter to stop."
    printf 'Backup path: ' >&2; read -r bp || bp=""
    if [ -n "$bp" ] && [ -d "$bp" ] && [ $(( $(date +%s) - $(mtime_of "$bp") )) -le 21600 ]; then
      date -u +%FT%TZ > "$stamp"; say "  stamp written for the backup you named"; PF_FAILS=$((PF_FAILS - 1))
      printf '%s\t%s\t%s\t%s\t%s\n' preflight "backup stamp (created by you)" "path typed" "ok" PASS >> "$RESULTS"
    else say "  no valid backup path given; the stamp was NOT created"; fi
  fi
  set -- $(env_state)
  if [ "$1" = UPDATE_COMPLETE ]; then pf "root stack status" UPDATE_COMPLETE "$1" PASS; else pf "root stack status" UPDATE_COMPLETE "$1" FAIL; fi
  if [ "$2" = 0 ]; then pf "running Amplify jobs" 0 "$2" PASS; else pf "running Amplify jobs" 0 "$2" FAIL; fi
  if [ "$3" -ge 3 ] 2>/dev/null; then pf "BCAT_SCHEMA_STAGE" ">= 3" "$3" PASS; else pf "BCAT_SCHEMA_STAGE" ">= 3" "$3" FAIL; fi
  [ "$3" -gt 3 ] 2>/dev/null && say "  WARNING: stage $3 > 3 (runbook: stage 4 TruckLocationHistory TTL must not be deployed during the load)"
  local tc; tc=$(aws dynamodb list-tables --query "length(TableNames[?contains(@,'$SUFFIX')])" --output text 2>/dev/null | awk '{s+=$1} END{print s+0}')
  if [ "$TARGET" = prod ]; then
    [ "$tc" = 110 ] && pf "tables with suffix" 110 "$tc" PASS || pf "tables with suffix" 110 "${tc:-?}" FAIL
    local keys; keys=$(aws amplify get-branch --app-id "$APP" --branch-name main --query 'keys(branch.environmentVariables)' --output text 2>/dev/null)
    case " $keys " in *BCAT_DEV_STACK*|*BCAT_ISOLATED_PREVIEW*) pf "dev-only env vars on main" absent PRESENT FAIL ;; *) pf "dev-only env vars on main" absent absent PASS ;; esac
  else pf "tables with suffix" "(test mode)" "${tc:-?}" INFO; fi
  local j; j=$(node "$SCRIPTS/awProdRunHelper.mjs" jenny "$TARGET" 2>/dev/null | sed -n 's/^jenny: //p')
  if [ "$j" = found ]; then pf "Jenny in staff pool" found "$j" PASS
  elif [ "$TARGET" = prod ]; then pf "Jenny in staff pool" found "${j:-error}" FAIL; else pf "Jenny in staff pool" found "${j:-error}" INFO; fi
  local spec f kind want r sens
  for spec in "$F_CUST:customers:761" "$F_CARR:carriers:2462" "$F_APA:ap-aging:67" "$F_APE:ap-expected:36" "$F_AR:ar:296" "$F_BIG:export:8347"; do
    f=${spec%%:*}; kind=${spec#*:}; want=${kind#*:}; kind=${kind%%:*}
    if [ ! -f "$f" ]; then pf "file $(basename "$f")" "$want rows" missing FAIL; continue; fi
    r=$(node "$SCRIPTS/awProdRunHelper.mjs" rows "$f" "$kind" 2>/dev/null)
    local n; n=$(printf '%s\n' "$r" | sed -n 's/^rows=//p'); sens=$(printf '%s\n' "$r" | sed -n 's/^sensitive=//p')
    [ "$n" = "$want" ] && pf "rows $(basename "$f")" "$want" "$n" PASS || pf "rows $(basename "$f")" "$want" "${n:-?}" FAIL
    case "$kind" in customers|carriers|export) say "    sensitive headers present: $sens, refused by importer (stripped before upload; export has none)" ;; esac
  done
  FC_BEFORE=$(aws dynamodb scan --table-name "FactoringItem-$SUFFIX-NONE" --select COUNT --query Count --output text 2>/dev/null)
  say "  FactoringItem count (before): ${FC_BEFORE:-n/a}"
  LOAD_START=$(now_iso)
  say ""
  if [ "$PF_FAILS" -gt 0 ]; then FAIL_LIST=" $PF_FAILS preflight check(s) failed (see table above)"; stop_fail preflight; fi
  set_state preflight PASS
  say "PREFLIGHT: ALL PASS"
}

# ---- generic step engine ---------------------------------------------------------------------------------
# run_step <state name> <awProd step> <extra args for dry (without --apply)> ; apply args appended after
APPLY_EXTRA=""
confirm_apply() { # step -> 0 yes
  if [ "$YES_ALL" = 1 ]; then say "[$1] all numbers PASS: auto-applied (--yes-if-all-pass)"; return 0; fi
  ask_yn "Apply $1? [y/N]"
}
standard_step() { # name awstep -- args...
  local name=$1 aw=$2; shift 3
  CURRENT=$name
  should_run "$name" || { say "[$name] skipped (--from/--only)"; return 0; }
  already_done "$name" && return 0
  say ""; say "== STEP $name =="
  [ "$aw" = backfill ] && need_login
  recheck_env || { stop_fail "$name"; }
  local dry=$RUN_DIR/$name.dry.out dm=$RUN_DIR/$name.dry.metrics am=$RUN_DIR/$name.apply.metrics
  cli_run "$dry" "$aw" "$@"
  if [ "$LAST_RC" != 0 ]; then
    if grep -qi 'RECONCILED rehearsal' "$dry"; then say "STOP: importer gate message: $(grep -i 'RECONCILED rehearsal' "$dry" | head -1)"; fi
    FAIL_LIST=" the dry run exited $LAST_RC (see lines above)"
    [ "$DRY_ONLY" = 1 ] && { DRY_FAIL_NOTES="$DRY_FAIL_NOTES $name"; ANYFAIL=1; set_state "$name" "DRY-FAIL"; return 0; }
    stop_fail "$name"
  fi
  parse_out "$dry" "$dm"
  compare "$name" D "$dm" || true
  if [ "$CMP_FAILS" -gt 0 ]; then
    if [ "$DRY_ONLY" = 1 ]; then
      say "${RED}[$name] would STOP in a real run ($CMP_FAILS failing number(s)).${RST}"
      case "$name" in ap-aging|ap-expected|ar|backfill) say "  (expected before the loads are applied: this step depends on earlier steps' data)" ;; esac
      ANYFAIL=1; set_state "$name" "DRY-FAIL"; return 0
    fi
    stop_fail "$name"
  fi
  if [ "$DRY_ONLY" = 1 ]; then say "[$name] dry run PASS (dry-only: not applied)"; set_state "$name" "DRY-OK"; return 0; fi
  if [ "$TARGET" != prod ]; then case "$aw" in customers|carriers|ar|ap-aging|ap-expected|stage-export) : ;; *) say "[$name] test mode: apply not supported for this step; skipped"; set_state "$name" "TEST-SKIP"; return 0 ;; esac; fi
  if ! confirm_apply "$name"; then say "[$name] not applied. Re-run the script to resume here."; set_state "$name" "DRY-OK"; print_summary; exit 4; fi
  case "$aw" in customers|carriers|ar|ap-aging|ap-expected) backup_gate ;; esac
  recheck_env || stop_fail "$name"
  local apply=$RUN_DIR/$name.apply.out
  local applyargs=(--apply)
  case "$aw" in customers|carriers|ar|ap-aging|ap-expected) applyargs+=(--live-tag "$LIVE_TAG") ;; esac
  export AW_PROD_CONFIRM=$TODAY-$aw
  cli_run "$apply" "$aw" "$@" "${applyargs[@]}"
  unset AW_PROD_CONFIRM
  if [ "$LAST_RC" != 0 ]; then
    if grep -qi 'RECONCILED rehearsal' "$apply"; then say "STOP: importer gate message: $(grep -i 'RECONCILED rehearsal' "$apply" | head -1)"; fi
    FAIL_LIST=" the apply exited $LAST_RC"; stop_fail "$name"
  fi
  parse_out "$apply" "$am"
  compare "$name" A "$am" "$dm" || true
  [ "$CMP_FAILS" -gt 0 ] && stop_fail "$name"
  local jid; jid=$(metric_of "$am" job.id); [ -z "$jid" ] && jid=$(metric_of "$am" staged.job); [ -n "$jid" ] && save_job "$name" "$jid"
  set_state "$name" DONE
  say "[$name] applied and verified: PASS"
}

# ---- individual steps ---------------------------------------------------------------------------------------
verify_run() { # after settings: awProd verify
  [ "$TARGET" = prod ] || return 0
  cli_run "$RUN_DIR/verify.out" verify >/dev/null 2>&1; parse_out "$RUN_DIR/verify.out" "$RUN_DIR/verify.metrics"
}
step_settings() {
  CURRENT=settings
  should_run settings || return 0
  already_done settings && return 0
  say ""; say "== STEP settings =="
  recheck_env || stop_fail settings
  local dry=$RUN_DIR/settings.dry.out dm=$RUN_DIR/settings.dry.metrics
  cli_run "$dry" settings
  parse_out "$dry" "$dm"
  compare settings D "$dm" || true
  if [ "$CMP_FAILS" -gt 0 ]; then
    if [ "$DRY_ONLY" = 1 ]; then ANYFAIL=1; set_state settings DRY-FAIL; return 0; fi
    stop_fail settings
  fi
  [ "$DRY_ONLY" = 1 ] && { set_state settings DRY-OK; return 0; }
  if [ "$(metric_of "$dm" settings.action)" = NOOP ]; then say "[settings] already at 19999 / NUMERIC: nothing to apply"; set_state settings DONE; return 0; fi
  [ "$TARGET" = prod ] || { say "[settings] test mode: apply not supported; skipped"; set_state settings TEST-SKIP; return 0; }
  confirm_apply settings || { say "[settings] not applied."; set_state settings DRY-OK; print_summary; exit 4; }
  export AW_PROD_CONFIRM=$TODAY-settings
  cli_run "$RUN_DIR/settings.apply.out" settings --apply; local rc=$LAST_RC
  unset AW_PROD_CONFIRM
  [ "$rc" = 0 ] || { FAIL_LIST=" apply exited $rc"; stop_fail settings; }
  verify_run
  compare settings A "$RUN_DIR/verify.metrics" "$dm" || true
  [ "$CMP_FAILS" -gt 0 ] && stop_fail settings
  set_state settings DONE
  say "[settings] applied and verified: PASS. Next (UI, signed in as ADMIN): Settings > Data cutoff first, then ownership seed, then reps (guide)."
}
step_backfill_check() {
  CURRENT=backfill-check
  should_run backfill-check || return 0
  already_done backfill-check && return 0
  need_login
  say ""; say "== STEP backfill-check (--evaluate, then dry run; APPLY is deferred until after the loads) =="
  recheck_env || stop_fail backfill-check
  local ev=$RUN_DIR/backfill-check.eval.out dry=$RUN_DIR/backfill-check.dry.out
  cli_run "$ev" backfill --cutoff $CUTOFF --export-keys "$PROS" --evaluate || { FAIL_LIST=" evaluate exited $LAST_RC"; [ "$DRY_ONLY" = 1 ] || stop_fail backfill-check; }
  cli_run "$dry" backfill --cutoff $CUTOFF --export-keys "$PROS" || true
  parse_out "$ev" "$RUN_DIR/backfill-check.eval.metrics"; parse_out "$dry" "$RUN_DIR/backfill-check.dry.metrics"
  local same=yes k; for k in matchedByPro linkedById ambiguous unmappable afterCutoff carriedOver; do
    [ "$(metric_of "$RUN_DIR/backfill-check.eval.metrics" backfill_before.$k)" = "$(metric_of "$RUN_DIR/backfill-check.dry.metrics" backfill_before.$k)" ] || same=no; done
  { cat "$RUN_DIR/backfill-check.eval.metrics"; printf 'derived.dryEqualsEvaluate\t%s\n' "$same"; } > "$RUN_DIR/backfill-check.dry2.metrics"
  compare backfill-check D "$RUN_DIR/backfill-check.dry2.metrics" || true
  if [ "$CMP_FAILS" -gt 0 ]; then
    if [ "$DRY_ONLY" = 1 ]; then ANYFAIL=1; set_state backfill-check DRY-FAIL; return 0; fi
    stop_fail backfill-check
  fi
  say "[backfill-check] PASS. STOP printed: backfill APPLY is deferred until after the loads (runbook order decision)."
  [ "$DRY_ONLY" = 1 ] && set_state backfill-check DRY-OK || set_state backfill-check DONE
}
step_tax_ids() {
  CURRENT=tax-ids
  should_run tax-ids || return 0
  already_done tax-ids && return 0
  say ""; say "== STEP tax-ids (optional; runbook recommendation: SKIP now, run later with Ryne present) =="
  local vault="no"
  aws dynamodb describe-table --table-name "CarrierTaxVault-$SUFFIX" >/dev/null 2>&1 && vault=yes
  say "  encrypted tax-ID vault deployed: $vault"
  if [ "$vault" = no ] || [ "$TARGET" != prod ]; then say "[tax-ids] skipped (vault not deployed or test mode)"; set_state tax-ids SKIPPED; return 0; fi
  [ "$DRY_ONLY" = 1 ] && { say "[tax-ids] dry-only: skipped"; return 0; }
  if ! ask_yn "Import tax IDs now? [y/N] (default N, even with --yes-if-all-pass)"; then say "[tax-ids] skipped by choice"; set_state tax-ids SKIPPED; return 0; fi
  local dry=$RUN_DIR/tax-ids.dry.out
  cli_run "$dry" tax-ids --source "$F_CARR"; parse_out "$dry" "$RUN_DIR/tax-ids.dry.metrics"
  compare tax-ids D "$RUN_DIR/tax-ids.dry.metrics" || true
  [ "$CMP_FAILS" -gt 0 ] && stop_fail tax-ids
  ask_yn "Apply tax-ids (values go encrypted to the vault)? [y/N]" || { say "[tax-ids] not applied"; set_state tax-ids SKIPPED; return 0; }
  export AW_PROD_CONFIRM=$TODAY-tax-ids
  cli_run "$RUN_DIR/tax-ids.apply.out" tax-ids --source "$F_CARR" --apply; local rc=$LAST_RC
  unset AW_PROD_CONFIRM
  [ "$rc" = 0 ] || { FAIL_LIST=" apply exited $rc"; stop_fail tax-ids; }
  set_state tax-ids DONE
}
BACKUP_ASKED=0
backup_gate() { # prodpre-importAljex(+Recon) backups needed by the offline file steps, the loads and the reconcile gate (prod only)
  [ "$TARGET" = prod ] || return 0
  [ "$DRY_ONLY" = 1 ] && return 0
  [ "$BACKUP_ASKED" = 1 ] && return 0
  BACKUP_ASKED=1
  say "  The importAljex gate needs fresh prodpre-importAljex-* on-demand backups (runbook 4c-1)."
  if ask_yn "Create/refresh those backups now (production CreateBackup, non-destructive)? [y/N]"; then
    BCAT_ALLOW_PROD=$TODAY node "$SCRIPTS/prodBackup.mjs" --target prod --i-mean-production --script importAljex,importAljexRecon --apply 2>&1 | scrub | tee -a "$TRANSCRIPT" | tail -5
  fi
}
step_loads() {
  CURRENT=loads
  should_run loads || return 0
  already_done loads && return 0
  say ""; say "== STEP loads (stage-export, then the importAljex plan and live pass) =="
  standard_step stage-export stage-export -- --file "$F_BIG"
  [ "$DRY_ONLY" = 1 ] || backup_gate
  recheck_env || stop_fail loads
  CURRENT=loads
  if [ "$DRY_ONLY" = 1 ] && [ "$TARGET" = prod ]; then say "  (dry-only: the loads plan needs the prodpre backups; running it anyway shows the gate message if they are missing)"; fi
  local name=loads
  local dry=$RUN_DIR/loads.dry.out dm=$RUN_DIR/loads.dry.metrics am=$RUN_DIR/loads.apply.metrics
  cli_run "$dry" loads --source "$F_BIG" --live-tag "$LOADS_TAG"
  if [ "$LAST_RC" != 0 ]; then
    FAIL_LIST=" the loads plan exited $LAST_RC: $(grep -i -E 'refus|RECONCILED|backup|gate|ended' "$dry" | head -2 | tr '\n' ' ')"
    [ "$DRY_ONLY" = 1 ] && { ANYFAIL=1; set_state loads DRY-FAIL; return 0; }
    stop_fail loads
  fi
  parse_out "$dry" "$dm"
  compare loads D "$dm" || true
  if [ "$CMP_FAILS" -gt 0 ]; then
    [ "$DRY_ONLY" = 1 ] && { ANYFAIL=1; set_state loads DRY-FAIL; return 0; }
    stop_fail loads
  fi
  [ "$DRY_ONLY" = 1 ] && { set_state loads DRY-OK; return 0; }
  [ "$TARGET" = prod ] || { say "[loads] test mode: apply not supported; skipped"; set_state loads TEST-SKIP; return 0; }
  confirm_apply loads || { say "[loads] not applied."; set_state loads DRY-OK; print_summary; exit 4; }
  recheck_env || stop_fail loads
  export AW_PROD_CONFIRM=$TODAY-loads
  cli_run "$RUN_DIR/loads.apply.out" loads --source "$F_BIG" --live-tag "$LOADS_TAG" --apply; local rc=$LAST_RC
  unset AW_PROD_CONFIRM
  if [ "$rc" != 0 ]; then
    grep -qi 'RECONCILED rehearsal' "$RUN_DIR/loads.apply.out" && say "STOP: importer gate message: $(grep -i 'RECONCILED rehearsal' "$RUN_DIR/loads.apply.out" | head -1)"
    FAIL_LIST=" the live pass exited $rc (resume: node scripts/awProd.mjs loads --suffix $SUFFIX --live-tag $LOADS_TAG --resume <JOBID> --apply)"; stop_fail loads
  fi
  parse_out "$RUN_DIR/loads.apply.out" "$am"
  compare loads A "$am" "$dm" || true
  [ "$CMP_FAILS" -gt 0 ] && stop_fail loads
  set_state loads DONE
  say "[loads] applied and verified: PASS"
}
step_reconcile() {
  CURRENT=reconcile
  should_run reconcile || return 0
  say ""; say "== STEP reconcile (reports only; writes RECONCILE jobs) =="
  if [ "$DRY_ONLY" = 1 ]; then say "[reconcile] dry-only: needs applied import jobs; skipped"; return 0; fi
  local ent src cust sj
  backup_gate
  cust=$(get_job customers)
  for ent in CUSTOMERS CARRIERS AP AR SHIPMENTS; do
    case "$ent" in CUSTOMERS) src=customers ;; CARRIERS) src=carriers ;; AP) src=ap-aging ;; AR) src=ar ;; SHIPMENTS) src=stage-export ;; esac
    sj=$(get_job "$src")
    if [ -z "$sj" ]; then FAIL_LIST=" no recorded job id for $src (run that step first)"; stop_fail "rec-$ent"; fi
    recheck_env || stop_fail reconcile
    confirm_apply "reconcile $ent" || { say "[reconcile] stopped"; print_summary; exit 4; }
    local extra=(); [ "$ent" = AR ] && extra=(--customers-job "$cust")
    local out=$RUN_DIR/rec-$ent.out
    export AW_PROD_CONFIRM=$TODAY-reconcile
    cli_run "$out" reconcile --entity "$ent" --source-job "$sj" --cutoff $CUTOFF ${extra[@]+"${extra[@]}"} --apply; local rc=$LAST_RC
    unset AW_PROD_CONFIRM
    [ "$rc" = 0 ] || { FAIL_LIST=" reconcile $ent exited $rc"; stop_fail "rec-$ent"; }
    parse_out "$out" "$RUN_DIR/rec-$ent.metrics"
    compare "rec-$ent" A "$RUN_DIR/rec-$ent.metrics" || true
    [ "$CMP_FAILS" -gt 0 ] && stop_fail "rec-$ent"
  done
  set_state reconcile DONE
  say "[reconcile] reports are in Settings > Data > Aljex reconciliation. Jenny signs off in the app."
}
final_checks() {
  [ "$DRY_ONLY" = 1 ] && return 0
  [ "$TARGET" = prod ] || return 0
  say ""; say "== no outbound e-mail check (runbook Step 6.5; counts only) =="
  local fc n
  fc=$(aws dynamodb scan --table-name "FactoringItem-$SUFFIX-NONE" --select COUNT --query Count --output text 2>/dev/null)
  if [ -n "$FC_BEFORE" ] && [ "$fc" = "$FC_BEFORE" ]; then printf '%s\t%s\t%s\t%s\t%s\n' final "FactoringItem count unchanged" "$FC_BEFORE" "$fc" PASS >> "$RESULTS"; say "  FactoringItem unchanged ($fc): PASS"
  else printf '%s\t%s\t%s\t%s\t%s\n' final "FactoringItem count unchanged" "${FC_BEFORE:-?}" "${fc:-?}" FAIL >> "$RESULTS"; say "  FactoringItem changed ${FC_BEFORE:-?} -> ${fc:-?}: FAIL"; ANYFAIL=1; fi
  n=$(aws dynamodb scan --table-name "ShipmentNotice-$SUFFIX-NONE" --select COUNT --filter-expression 'createdAt >= :t' --expression-attribute-values "{\":t\":{\"S\":\"$LOAD_START\"}}" --query Count --output text 2>/dev/null)
  if [ "$n" = 0 ]; then printf '%s\t%s\t%s\t%s\t%s\n' final "ShipmentNotice since load start" 0 "$n" PASS >> "$RESULTS"; say "  ShipmentNotice rows since start: 0: PASS"
  else printf '%s\t%s\t%s\t%s\t%s\n' final "ShipmentNotice since load start" 0 "${n:-?}" FAIL >> "$RESULTS"; say "  ShipmentNotice since start: ${n:-?}: FAIL (check the app: Shipments > Messages)"; ANYFAIL=1; fi
  say "  SES Send metric: compare against a normal day (runbook Step 6.5): aws cloudwatch get-metric-statistics --namespace AWS/SES --metric-name Send ..."
  verify_run
}

# ---- walk ---------------------------------------------------------------------------------------------------
step_preflight
node "$SCRIPTS/awProdRunHelper.mjs" pros "$F_BIG" "$PROS" >/dev/null 2>&1 || { FAIL_LIST=" could not build the export key list"; stop_fail preflight; }
step_settings
step_backfill_check
standard_step customers customers -- --file "$F_CUST" --cutoff $CUTOFF --plan
standard_step carriers carriers -- --file "$F_CARR" --cutoff $CUTOFF --plan
step_tax_ids
step_loads
standard_step backfill backfill -- --cutoff $CUTOFF --export-keys "$PROS"
standard_step ap-aging ap-aging -- --file "$F_APA" --cutoff $CUTOFF --plan
standard_step ap-expected ap-expected -- --file "$F_APE" --cutoff $CUTOFF --plan
standard_step ar ar -- --file "$F_AR" --cutoff $CUTOFF --plan
step_reconcile
final_checks
print_summary
if [ "$ANYFAIL" = 1 ]; then say "Result: NOT all numbers passed${DRY_FAIL_NOTES:+ (dry-only walk would stop at:$DRY_FAIL_NOTES)}"; exit 1; fi
say "Result: all steps passed."
exit 0
