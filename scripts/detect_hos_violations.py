#!/usr/bin/env python3
"""HOS/ELD Compliance Watchdog — queries bcat-ops for driver compliance alerts,
tracks 7-day rolling violation counts, and posts violations to Slack.

Read-only. Queries the bcat-ops AppSync GraphQL API for:
  - Unacknowledged ComplianceAlerts (last 24h)
  - Drivers with NON_COMPLIANT or EXPIRING_SOON compliance status
Tracks daily violation counts per driver in a 7-day rolling state file.

Authentication: Cognito USER_PASSWORD_AUTH using BCAT_EMAIL / BCAT_PASSWORD env vars
(same auth as detect_fuel_anomalies.py).

Usage:
    BCAT_EMAIL=ryne@bcatcorp.com BCAT_PASSWORD=... python3 detect_hos_violations.py
    BCAT_EMAIL=... BCAT_PASSWORD=... python3 detect_hos_violations.py --slack
    BCAT_EMAIL=... BCAT_PASSWORD=... python3 detect_hos_violations.py --json
"""

import json
import os
import sys
import datetime
import argparse
from typing import Optional
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

# ── Configuration ────────────────────────────────────────────────────────────────
APPSYNC_URL = "https://2ivs344vbvglblxbmjdd7pgi2q.appsync-api.us-east-1.amazonaws.com/graphql"
USER_POOL_ID = "us-east-1_IbPKPNJC9"
CLIENT_ID = "1qr651dshigrv8a6c338d4f709"
AWS_REGION = "us-east-1"

# State file for 7-day rolling violation tracking
STATE_FILE = Path.home() / ".hermes/state/hos-watchdog-state.json"

# ── GraphQL queries ──────────────────────────────────────────────────────────────

# Get all unacknowledged compliance alerts (the set is small)
LIST_ALERTS_QUERY = """
query ListComplianceAlerts {
  listComplianceAlerts(limit: 1000) {
    items {
      id entityType entityId entityName documentType documentTitle
      complianceDocumentId expirationDate severity acknowledged
      acknowledgedBy acknowledgedAt resolvedAt createdAt updatedAt
    }
  }
}
"""

# Get all drivers (with compliance status)
LIST_DRIVERS_QUERY = """
query ListDrivers {
  listDrivers(limit: 200) {
    items {
      id name active type driverType onboardingStatus complianceStatus
      cdl cdlExpiration medCardExpiration hireDate
      assignedTruckId email phone createdAt updatedAt
    }
  }
}
"""


def authenticate(email: str, password: str) -> str:
    """Sign in to Cognito and return the ID token."""
    client = boto3.client("cognito-idp", region_name=AWS_REGION)

    try:
        resp = client.initiate_auth(
            AuthFlow="USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": email, "PASSWORD": password},
            ClientId=CLIENT_ID,
        )
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code == "NotAuthorizedException":
            raise SystemExit(f"Authentication failed: invalid credentials ({e})") from e
        if code == "UserNotFoundException":
            raise SystemExit(f"Authentication failed: user not found ({e})") from e
        raise

    id_token = resp["AuthenticationResult"]["IdToken"]
    return id_token


def graphql_call(query: str, variables: dict, id_token: str) -> dict:
    """Make a GraphQL request to AppSync with Cognito auth."""
    import urllib.request

    body = json.dumps({"query": query, "variables": variables}).encode("utf-8")
    req = urllib.request.Request(
        APPSYNC_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": id_token,
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def fetch_drivers(id_token: str) -> list[dict]:
    """Fetch ALL drivers from AppSync."""
    result = graphql_call(LIST_DRIVERS_QUERY, {}, id_token)
    if result.get("errors"):
        raise SystemExit(f"GraphQL error: {result['errors'][0]['message']}")
    items = result.get("data", {}).get("listDrivers", {}).get("items", []) or []
    return items


def fetch_alerts(id_token: str) -> list[dict]:
    """Fetch ALL ComplianceAlert records from AppSync."""
    result = graphql_call(LIST_ALERTS_QUERY, {}, id_token)
    if result.get("errors"):
        raise SystemExit(f"GraphQL error: {result['errors'][0]['message']}")
    items = result.get("data", {}).get("listComplianceAlerts", {}).get("items", []) or []
    return items


# ── State file management ────────────────────────────────────────────────────────

def load_state() -> dict:
    """Load the 7-day rolling violation state from disk."""
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {"daily_counts": {}, "last_updated": None}


def save_state(state: dict):
    """Persist the violation state to disk."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    state["last_updated"] = datetime.datetime.now().isoformat()
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def update_rolling_counts(
    state: dict,
    today_iso: str,
    violation_drivers: set[str],
):
    """Add today's violations to the rolling state and prune days older than 7 days."""
    daily = state.get("daily_counts", {})

    # Add today's violations
    daily[today_iso] = {
        "drivers": sorted(violation_drivers),  # driver names
        "count": len(violation_drivers),
    }

    # Prune entries older than 7 days
    cutoff = (datetime.date.today() - datetime.timedelta(days=7)).isoformat()
    pruned = {k: v for k, v in daily.items() if k >= cutoff}
    state["daily_counts"] = pruned

    return state


def compute_7day_summary(state: dict) -> dict:
    """Compute per-driver 7-day rolling violation counts and total violation-days."""
    daily = state.get("daily_counts", {})
    driver_violation_days: dict[str, int] = {}
    total_violation_days = 0

    for date_str, day_data in sorted(daily.items()):
        drivers = day_data.get("drivers", [])
        total_violation_days += len(drivers)
        for driver_name in drivers:
            driver_violation_days[driver_name] = driver_violation_days.get(driver_name, 0) + 1

    return {
        "total_violation_days": total_violation_days,
        "drivers": dict(sorted(driver_violation_days.items(), key=lambda x: -x[1])),
        "days_tracked": len(daily),
    }


# ── Violation detection ──────────────────────────────────────────────────────────

def detect_violations(drivers: list[dict], alerts: list[dict]) -> dict:
    """Analyze drivers and alerts to find HOS/compliance violations.

    A driver is considered in violation if:
      - complianceStatus is NON_COMPLIANT or EXPIRING_SOON
      - Has unacknowledged CRITICAL or EXPIRED alerts
    """
    now = datetime.datetime.now(datetime.timezone.utc)
    today_iso = datetime.date.today().isoformat()
    yesterday_iso = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()

    # ── Find non-compliant/expiring drivers ──
    non_compliant_drivers = []
    for d in drivers:
        if not d.get("active"):
            continue
        cs = d.get("complianceStatus", "UNKNOWN")
        if cs in ("NON_COMPLIANT", "EXPIRING_SOON"):
            non_compliant_drivers.append({
                "name": d.get("name", "Unknown"),
                "driver_id": d.get("id"),
                "status": cs,
                "driver_type": d.get("driverType") or "UNCLASSIFIED",
                "cdl_expiration": d.get("cdlExpiration"),
                "med_card_expiration": d.get("medCardExpiration"),
                "assigned_truck_id": d.get("assignedTruckId"),
                "phone": d.get("phone"),
            })

    # ── Find unacknowledged severe alerts ──
    severe_alerts = []
    for a in alerts:
        if a.get("acknowledged"):
            continue
        if a.get("resolvedAt"):
            continue
        severity = a.get("severity", "")
        if severity not in ("CRITICAL", "EXPIRED"):
            continue
        # Only driver alerts (not truck)
        if a.get("entityType") != "DRIVER":
            continue
        severe_alerts.append({
            "driver_name": a.get("entityName", "Unknown"),
            "driver_id": a.get("entityId"),
            "alert_id": a.get("id"),
            "document_type": a.get("documentType"),
            "document_title": a.get("documentTitle"),
            "expiration_date": a.get("expirationDate"),
            "severity": severity,
            "created_at": a.get("createdAt"),
        })

    # ── Combine into unified violation list ──
    # Build a set of driver names in violation
    violation_names: set[str] = set()
    violation_details = []

    for d in non_compliant_drivers:
        violation_names.add(d["name"])
        violation_details.append({
            "driver": d["name"],
            "type": "compliance_status",
            "detail": f"Status: {d['status']}",
            "driver_type": d["driver_type"],
            "cdl_exp": d.get("cdl_expiration"),
            "med_exp": d.get("med_card_expiration"),
        })

    seen_alert_drivers = set()
    for a in severe_alerts:
        name = a["driver_name"]
        if name not in violation_names:
            violation_names.add(name)
        if (name, a["document_type"]) not in seen_alert_drivers:
            seen_alert_drivers.add((name, a["document_type"]))
            exp_str = a.get("expiration_date", "")[:10] if a.get("expiration_date") else "N/A"
            violation_details.append({
                "driver": name,
                "type": "document_alert",
                "detail": f"{a['severity']}: {a['document_title'] or a['document_type']} (expires {exp_str})",
                "alert_id": a["alert_id"],
            })

    return {
        "violation_drivers": sorted(violation_names),
        "violation_count": len(violation_names),
        "non_compliant": non_compliant_drivers,
        "severe_alerts": severe_alerts,
        "violations": violation_details,
        "total_drivers": len([d for d in drivers if d.get("active")]),
    }


# ── Slack message formatting ─────────────────────────────────────────────────────

def color_for_severity(severity: str) -> str:
    if severity == "EXPIRED":
        return "🔴"
    if severity == "CRITICAL":
        return "🟠"
    if severity == "URGENT":
        return "🟡"
    return "⚪"


def emoji_for_total(total: int) -> str:
    if total == 0:
        return "✅"
    if total <= 2:
        return "⚠️"
    return "🚨"


def format_slack_message(results: dict, _7day_summary: dict) -> str:
    """Format violations as a Slack markdown message."""
    today = datetime.date.today().isoformat()
    violations = results["violations"]
    vcount = results["violation_count"]

    lines = [
        f"{emoji_for_total(vcount)} *HOS / ELD Compliance Watchdog* — {today}",
    ]

    if vcount == 0:
        lines.append("✅ No HOS compliance violations detected in the last 24 hours.")
        lines.append(f"_{results['total_drivers']} active drivers monitored._")
        # Still show 7-day summary
        lines.append("")
        lines.append(format_7day_summary_lines(_7day_summary))
        return "\n".join(lines)

    lines.append(
        f"*{vcount} driver(s)* with compliance issues detected "
        f"(out of {results['total_drivers']} active)."
    )
    lines.append("")

    # Per-driver violation details
    for v in violations:
        lines.append(
            f"• *{v['driver']}*: {v['detail']}"
        )

    # Non-compliant drivers section
    if results["non_compliant"]:
        lines.append("")
        lines.append("*Non-Compliant / Expiring Drivers:*")
        for d in results["non_compliant"]:
            extra = []
            if d.get("cdl_expiration"):
                extra.append(f"CDL: {d['cdl_expiration']}")
            if d.get("med_card_expiration"):
                extra.append(f"Med: {d['med_card_expiration']}")
            extras = " | ".join(extra) if extra else ""
            lines.append(f"  • {d['name']} — {d['status']} ({d['driver_type']}) {extras}")

    # Unacknowledged severe alerts
    if results["severe_alerts"]:
        lines.append("")
        lines.append("*Unacknowledged CRITICAL / EXPIRED Alerts:*")
        for a in results["severe_alerts"][:10]:  # cap at 10
            exp = a.get("expiration_date", "")[:10] if a.get("expiration_date") else "?"
            lines.append(
                f"  {color_for_severity(a['severity'])} {a['driver_name']}: "
                f"{a['document_title'] or a['document_type']} expires {exp}"
            )
        if len(results["severe_alerts"]) > 10:
            lines.append(f"  … +{len(results['severe_alerts']) - 10} more")

    # 7-day rolling summary
    lines.append("")
    lines.append(format_7day_summary_lines(_7day_summary))

    return "\n".join(lines)


def format_7day_summary_lines(summary: dict) -> str:
    """Format the 7-day rolling summary section."""
    lines = [
        "*7-Day Rolling Violation Count:*",
        f"  • Total violation-days: {summary['total_violation_days']}",
        f"  • Days tracked: {summary['days_tracked']}",
    ]

    if summary["drivers"]:
        lines.append("  • Per-driver breakdown:")
        for driver, days in summary["drivers"].items():
            bar = "█" * days
            lines.append(f"    {driver}: {days}d {bar}")
    else:
        lines.append("  • No violations in the last 7 days. 🎉")

    return "\n".join(lines)


def format_human_output(results: dict, _7day_summary: dict) -> str:
    """Human-readable text output."""
    vcount = results["violation_count"]
    lines = [
        "HOS / ELD Compliance Watchdog Report",
        "=====================================",
        f"Date: {datetime.date.today().isoformat()}",
        f"Active drivers: {results['total_drivers']}",
        f"Drivers in violation: {vcount}",
        "",
    ]

    if vcount == 0:
        lines.append("✅ No compliance violations detected.")
    else:
        for v in results["violations"]:
            lines.append(f"  • {v['driver']}: {v['detail']}")

    lines.append("")
    lines.append("7-Day Rolling Summary:")
    lines.append(f"  Total violation-days: {_7day_summary['total_violation_days']}")
    lines.append(f"  Days tracked: {_7day_summary['days_tracked']}")
    if _7day_summary["drivers"]:
        for driver, days in _7day_summary["drivers"].items():
            lines.append(f"    {driver}: {days} day(s)")
    else:
        lines.append("  No violations in last 7 days.")

    return "\n".join(lines)


# ── Main ─────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="HOS/ELD compliance watchdog for bcat-ops")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")
    parser.add_argument("--slack", action="store_true", help="Output Slack-formatted markdown")
    parser.add_argument("--quiet", action="store_true", help="Silent on no violations (for cron)")
    args = parser.parse_args()

    email = os.environ.get("BCAT_EMAIL")
    password = os.environ.get("BCAT_PASSWORD")
    if not email or not password:
        print("Error: BCAT_EMAIL and BCAT_PASSWORD environment variables are required.", file=sys.stderr)
        print("       Source them from ~/.hermes/bcat-ops-credentials.env", file=sys.stderr)
        sys.exit(1)

    print(f"Authenticating as {email}...", file=sys.stderr)
    id_token = authenticate(email, password)

    print("Fetching drivers...", file=sys.stderr)
    drivers = fetch_drivers(id_token)
    print(f"  Fetched {len(drivers)} driver records.", file=sys.stderr)

    print("Fetching compliance alerts...", file=sys.stderr)
    alerts = fetch_alerts(id_token)
    print(f"  Fetched {len(alerts)} alert records.", file=sys.stderr)

    # Detect violations
    results = detect_violations(drivers, alerts)
    print(f"  Detected {results['violation_count']} driver(s) with violations.", file=sys.stderr)

    # Load state, update rolling counts, save
    state = load_state()
    today_iso = datetime.date.today().isoformat()
    state = update_rolling_counts(state, today_iso, set(results["violation_drivers"]))
    save_state(state)

    # Compute 7-day summary
    _7day_summary = compute_7day_summary(state)

    # Output
    if args.json:
        output = {
            "date": today_iso,
            "violations": results,
            "seven_day_rolling": _7day_summary,
        }
        print(json.dumps(output, indent=2, default=str))
    elif args.slack:
        msg = format_slack_message(results, _7day_summary)
        print(msg)
    else:
        # Quiet mode: only output if violations exist (for cron deliveries)
        if args.quiet and results["violation_count"] == 0:
            return
        print(format_human_output(results, _7day_summary))


if __name__ == "__main__":
    main()
