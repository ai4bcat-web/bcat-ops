#!/usr/bin/env python3
"""Fuel Price Anomaly Detector — flags overpay fuel transactions >15% above fleet average.

Read-only. Queries the bcat-ops AppSync GraphQL API for fuel transactions (last 30 days),
computes fleet average price/gallon per fuel type, flags transactions exceeding the
threshold, and outputs flagged transactions as JSON.

Authentication: Cognito USER_PASSWORD_AUTH using BCAT_EMAIL / BCAT_PASSWORD env vars
(same auth as iv1 ingestFuelReport.mjs).

Usage:
    BCAT_EMAIL=ryne@bcatcorp.com BCAT_PASSWORD=... python3 detect_fuel_anomalies.py
    BCAT_EMAIL=... BCAT_PASSWORD=... python3 detect_fuel_anomalies.py --threshold 15
    BCAT_EMAIL=... BCAT_PASSWORD=... python3 detect_fuel_anomalies.py --days 30 --threshold 15 --json
"""

import json
import os
import sys
import datetime
import argparse
from typing import Optional

import boto3
from botocore.exceptions import ClientError

# ── Configuration ────────────────────────────────────────────────────────────────
APPSYNC_URL = "https://2ivs344vbvglblxbmjdd7pgi2q.appsync-api.us-east-1.amazonaws.com/graphql"
USER_POOL_ID = "us-east-1_IbPKPNJC9"
CLIENT_ID = "1qr651dshigrv8a6c338d4f709"
AWS_REGION = "us-east-1"

# Fuel types recognized as real fuel (matches bcat-ops isFuelTx / FUEL_ITEM_TYPES)
FUEL_ITEM_TYPES = {"ULSD", "FUEL", "DEFD", "BIO", "B5", "B20", "REG", "PREM", "DSL"}

# ── GraphQL queries ──────────────────────────────────────────────────────────────
LIST_FUEL_QUERY = """
query ListFuelTransactions($startDate: String, $endDate: String) {
  listFuelTransactions(limit: 10000, filter: {
    transactionDate: { between: [$startDate, $endDate] }
  }) {
    items {
      id transactionDate cardNumber invoiceNumber unitNumber truckId driverName
      odometer locationName city state fees fuelType itemCategory pricePerUnit quantity amount
      currency sourceFile importedAt createdAt updatedAt
    }
  }
}
"""

# Fallback: if AppSync filter isn't supported, list everything and filter client-side.
LIST_ALL_QUERY = """
query ListFuelTransactions {
  listFuelTransactions(limit: 10000) {
    items {
      id transactionDate cardNumber invoiceNumber unitNumber truckId driverName
      odometer locationName city state fees fuelType itemCategory pricePerUnit quantity amount
      currency sourceFile importedAt createdAt updatedAt
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


def is_fuel(tx: dict) -> bool:
    """Check if a transaction is genuine fuel (mirrors driverFuel.isFuelTx)."""
    cat = (tx.get("itemCategory") or "").strip()
    if cat:
        return cat == "FUEL"
    return (tx.get("fuelType") or "").upper().strip() in FUEL_ITEM_TYPES


def fetch_fuel_transactions(id_token: str, days: int) -> list[dict]:
    """Fetch fuel transactions from the last N days."""
    end_date = datetime.date.today()
    start_date = end_date - datetime.timedelta(days=days)
    start_iso = start_date.isoformat()
    end_iso = end_date.isoformat()

    # Try with date filter first; fall back to unfiltered if AppSync rejects the filter
    for attempt, (query, variables) in enumerate(
        [
            (LIST_FUEL_QUERY, {"startDate": start_iso, "endDate": end_iso}),
            (LIST_ALL_QUERY, {}),
        ],
        1,
    ):
        try:
            result = graphql_call(query, variables, id_token)
        except Exception as e:
            if attempt < 2:
                print(f"[warn] Filtered query failed ({e}), falling back to unfiltered...", file=sys.stderr)
                continue
            raise

        if result.get("errors"):
            msg = result["errors"][0].get("message", str(result["errors"]))
            if attempt < 2 and ("filter" in msg.lower() or "between" in msg.lower()):
                print(f"[warn] Filter not supported by backend, retrying unfiltered...", file=sys.stderr)
                continue
            raise SystemExit(f"GraphQL error: {msg}")

        items = result.get("data", {}).get("listFuelTransactions", {}).get("items", []) or []
        break
    else:
        # Shouldn't happen (both attempts either break or raise), but satisfy the type checker
        raise SystemExit("Failed to fetch fuel transactions: unexpected error")

    # If unfiltered query was used, filter client-side
    if days:
        items = [tx for tx in items if tx.get("transactionDate", "") >= start_iso and tx.get("transactionDate", "") <= end_iso]

    # Filter to real fuel only
    fuel_txs = [tx for tx in items if is_fuel(tx)]

    return fuel_txs


def dedup_transactions(txs: list[dict]) -> list[dict]:
    """De-duplicate using invoice-agnostic key (date|card|fuelType|amount|quantity)."""
    seen = set()
    deduped = []
    for tx in txs:
        key = (
            f"{tx.get('transactionDate', '')}|"
            f"{tx.get('cardNumber', '')}|"
            f"{tx.get('fuelType', '')}|"
            f"{tx.get('amount', 0)}|"
            f"{tx.get('quantity', 0)}"
        )
        if key not in seen:
            seen.add(key)
            deduped.append(tx)
    return deduped


def normalize_card(card: Optional[str]) -> str:
    """Digits only, leading zeros stripped for card matching."""
    import re
    return re.sub(r"\D", "", (card or "")).lstrip("0")


def detect_anomalies(txs: list[dict], threshold_pct: float) -> dict:
    """Compute fleet averages and flag overpay transactions.

    Returns: {
        "fleet_averages": {fuelType: {"avg_price_per_unit": float, "count": int, "total_gallons": float}},
        "flags": [flag, ...],
        "summary": {...}
    }
    """
    # Group by fuel type for averaging
    by_fuel_type: dict[str, list[dict]] = {}
    for tx in txs:
        ft = (tx.get("fuelType") or "UNKNOWN").upper().strip()
        by_fuel_type.setdefault(ft, []).append(tx)

    fleet_averages = {}
    for ft, group in sorted(by_fuel_type.items()):
        prices = [tx["pricePerUnit"] for tx in group if tx.get("pricePerUnit", 0) > 0]
        total_gallons = sum(tx.get("quantity", 0) for tx in group)
        if prices:
            avg = sum(prices) / len(prices)
        else:
            avg = 0.0
        fleet_averages[ft] = {
            "avg_price_per_unit": round(avg, 4),
            "count": len(group),
            "total_gallons": round(total_gallons, 2),
        }

    flags = []
    for tx in txs:
        ft = (tx.get("fuelType") or "UNKNOWN").upper().strip()
        ppu = tx.get("pricePerUnit", 0)
        avg_info = fleet_averages.get(ft, {})
        fleet_avg = avg_info.get("avg_price_per_unit", 0)

        if fleet_avg <= 0 or ppu <= 0:
            continue

        overpay_pct = ((ppu - fleet_avg) / fleet_avg) * 100
        if overpay_pct > threshold_pct:
            overpay_amount = round((ppu - fleet_avg) * tx.get("quantity", 0), 2)
            flags.append({
                "id": tx.get("id"),
                "transaction_date": tx.get("transactionDate"),
                "truck_unit": tx.get("unitNumber") or (f"TRK-{normalize_card(tx.get('cardNumber'))}" if tx.get("cardNumber") else "Unknown"),
                "truck_id": tx.get("truckId"),
                "driver": tx.get("driverName"),
                "location": f"{tx.get('city', '')} {tx.get('state', '')}".strip(),
                "fuel_type": ft,
                "price_per_gallon": ppu,
                "fleet_average": round(fleet_avg, 4),
                "overpay_pct": round(overpay_pct, 2),
                "overpay_amount": overpay_amount,
                "gallons": tx.get("quantity", 0),
                "total_cost": tx.get("amount", 0),
            })

    # Sort by overpay percentage descending
    flags.sort(key=lambda f: f["overpay_pct"], reverse=True)

    return {
        "fleet_averages": fleet_averages,
        "flags": flags,
        "summary": {
            "total_transactions": len(txs),
            "total_flagged": len(flags),
            "threshold_pct": threshold_pct,
            "date_range_days": (datetime.date.today() - datetime.date.fromisoformat(min(tx.get("transactionDate", "2000-01-01")[:10] for tx in txs))).days
                if txs else 0,
        },
    }


def format_slack_message(results: dict) -> str:
    """Format flagged transactions as a Slack message."""
    flags = results["flags"]
    summary = results["summary"]
    averages = results["fleet_averages"]

    if not flags:
        return (
            f":fuelpump: *Fuel Anomaly Report* — {datetime.date.today().isoformat()}\n"
            f"✅ No overpay transactions detected (>15% above fleet average).\n"
            f"_{summary['total_transactions']} transactions analyzed across {len(averages)} fuel types._"
        )

    lines = [
        f":warning: *Fuel Anomaly Report* — {datetime.date.today().isoformat()}",
        f"*{len(flags)} overpay transaction(s)* detected (>15% above fleet average) out of {summary['total_transactions']} analyzed.",
        "",
    ]

    for flag in flags:
        loc = flag["location"] or "Unknown location"
        unit = flag["truck_unit"] or "Unknown unit"
        lines.append(
            f"• *{unit}*: ${flag['price_per_gallon']:.2f}/gal in {loc} "
            f"— {flag['overpay_pct']:.0f}% above fleet avg (${flag['fleet_average']:.2f}/gal). "
            f"Overpay: ${flag['overpay_amount']:.2f}"
        )

    lines.append("")
    lines.append("*Fleet Averages (30-day):*")
    for ft, info in sorted(averages.items()):
        lines.append(f"  • {ft}: ${info['avg_price_per_unit']:.2f}/gal ({info['count']} txns, {info['total_gallons']:.1f} gal)")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Fuel price anomaly detector for bcat-ops")
    parser.add_argument("--threshold", type=float, default=15.0, help="Overpay threshold percent (default: 15)")
    parser.add_argument("--days", type=int, default=30, help="Lookback window in days (default: 30)")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of formatted text")
    parser.add_argument("--slack", action="store_true", help="Output Slack-formatted markdown message")
    args = parser.parse_args()

    email = os.environ.get("BCAT_EMAIL")
    password = os.environ.get("BCAT_PASSWORD")
    if not email or not password:
        print("Error: BCAT_EMAIL and BCAT_PASSWORD environment variables are required.", file=sys.stderr)
        print("       Source them from ~/.hermes/bcat-ops-credentials.env", file=sys.stderr)
        sys.exit(1)

    print(f"Authenticating as {email}...", file=sys.stderr)
    id_token = authenticate(email, password)

    print(f"Fetching fuel transactions (last {args.days} days)...", file=sys.stderr)
    txs = fetch_fuel_transactions(id_token, args.days)
    print(f"  Fetched {len(txs)} fuel transactions.", file=sys.stderr)

    deduped = dedup_transactions(txs)
    if len(deduped) < len(txs):
        print(f"  De-duplicated: {len(txs)} → {len(deduped)} unique.", file=sys.stderr)

    if not deduped:
        print("No fuel transactions found in the lookback window.", file=sys.stderr)
        if args.json:
            print(json.dumps({"fleet_averages": {}, "flags": [], "summary": {"total_transactions": 0, "total_flagged": 0}}))
        else:
            print("No fuel transactions found in the lookback window.")
        return

    results = detect_anomalies(deduped, args.threshold)

    if args.json:
        print(json.dumps(results, indent=2, default=str))
    elif args.slack:
        print(format_slack_message(results))
    else:
        # Default: human-readable output
        summary = results["summary"]
        print(f"\nFuel Anomaly Detection Report")
        print(f"=============================")
        print(f"Period: last {args.days} days ({summary['date_range_days']} days of data)")
        print(f"Transactions analyzed: {summary['total_transactions']}")
        print(f"Threshold: {summary['threshold_pct']}% above fleet average")
        print(f"Flagged: {summary['total_flagged']}")
        print()

        print("Fleet Averages (price/gallon):")
        for ft, info in sorted(results["fleet_averages"].items()):
            print(f"  {ft:6s}: ${info['avg_price_per_unit']:.4f}/gal  ({info['count']} txns, {info['total_gallons']:.1f} gal)")

        if results["flags"]:
            print(f"\n⚠️  Flagged Overpay Transactions (>{(args.threshold)}% above fleet average):")
            for flag in results["flags"]:
                print(f"  {flag['truck_unit']:12s} | {flag['transaction_date']} | {flag['location']:30s} | "
                      f"${flag['price_per_gallon']:.2f}/gal | "
                      f"+{flag['overpay_pct']:.1f}% | overpay: ${flag['overpay_amount']:.2f} | "
                      f"{flag['gallons']:.1f} gal | ${flag['total_cost']:.2f} total")
        else:
            print(f"\n✅ No overpay transactions detected.")


if __name__ == "__main__":
    main()