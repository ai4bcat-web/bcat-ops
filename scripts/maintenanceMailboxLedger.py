#!/usr/bin/env python3
"""Durable maintenance-invoice mailbox ledger and discovery helper.

Used by both the Hermes cron job (0e4a75121399) and the bcat-command-center iv2
job. Replaces the unreliable "Seen" flag with a durable ledger keyed by RFC822
Message-ID (or a raw-MIME hash fallback) and attachment fingerprints.

The helper DISCOVERS candidate messages and TRACKS them; it does not parse/OCR
or ingest. The caller extracts invoices and records the result:

  python3 scripts/maintenanceMailboxLedger.py discover --output /tmp/candidates.json
  # for each pending/failed candidate, extract invoices and ingest
  python3 scripts/maintenanceMailboxLedger.py mark \
      --message-id '<MESSAGE_ID>' --status done \
      --invoices '[{"sourceDocumentId":"...","vendor":"...","amount":...}]'

Stable sourceDocumentId convention:
  - Attachment-derived: att:<sha256-of-attachment-bytes>:<doc-index>
  - Body-derived:       body:<base64url(Message-ID)>:<doc-index>
doc-index is assigned by the extractor per distinct invoice document inside the
attachment/body (0 initially).
"""

import argparse
import base64
import datetime
import email
import email.utils
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_LEDGER = Path.home() / ".hermes" / "maintenance-invoice-ledger.json"
DEFAULT_WORK_DIR = Path("/tmp")
ALL_MAIL_FOLDER = "[Gmail]/All Mail"
DEFAULT_PAGE_SIZE = 500
REPAIRS_GROUP = "repairs@bcatcorp.com"
REPAIRS_LIST_ID = "repairs.bcatcorp.com"

# Known maintenance vendors/senders (subject-independent inclusion when they send attachments).
KNOWN_VENDOR_SENDERS = [
    "brotherhoodinbusiness@gmail.com",
    "mastermechanicjs22@gmail.com",
    "andytruckdoc@gmail.com",
    "billing@bestcareautotransport.com",
    "ivancartage4@icloud.com",
]

# Internal senders who might forward repair invoices.
INTERNAL_SENDERS = ["@bcatcorp.com"]

# Subject keywords that indicate maintenance invoices.
VENDOR_KEYWORDS = ["kriete", "truck doctor", "jamie", "brotherhood"]
TOPIC_KEYWORDS = [
    "repair order", "truck repair", "trailer repair", "work order", "shop",
    "mechanic", "tire", "parts", "labor", "brake", "oil change", "diesel",
    "transmission", "inspection", "alignment", "kingpin", "clutch", "def",
    "radiator", "alternator", "starter", "maintenance", "trk#", "trl#",
    "invoices available",
]

# Unrelated senders whose "invoice" emails should never be ingested.
SENDER_EXCLUDES = [
    "do-not-reply@relay.amazon.com",
    "wordpress@bestcareautotransport.com",
    "notifications@vercel.com",
    "welcome@openrouter.ai",
    "google-noreply@google.com",
    "google-maps-platform-noreply@google.com",
    "no-reply-aws@amazon.com",
    "invoices@billing.ngrok.com",
]

# Unrelated subject fragments.
SUBJECT_EXCLUDES = [
    "new invoice is available for work period",
    "please moderate",
    "load tender",
    "rate confirmation",
    "departing in the next",
    "load board - trip",
    "tender tms id",
    "your ai bill",
]


def log(msg):
    sys.stderr.write(f"[ledger] {msg}\n")


def strip_ansi(s):
    return re.sub(r"\x1b\[[0-9;]*m", "", s)


def parse_himalaya_json(raw):
    raw = strip_ansi(raw).strip()
    if not raw:
        return []
    idx = raw.find("[")
    if idx < 0:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return []
    return json.loads(raw[idx:])


def run_himalaya(args, timeout=120):
    """Run himalaya with the default account configured in ~/.config/himalaya/config.toml."""
    cmd = ["himalaya"] + args
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if res.returncode != 0:
        err = res.stderr.strip()
        # out-of-bounds page is end-of-data, not a hard error for the caller
        if "out of bound" in err:
            raise EndOfData(err)
        sys.stderr.write(err + "\n")
        raise subprocess.CalledProcessError(res.returncode, cmd, output=res.stdout, stderr=res.stderr)
    return res.stdout


class EndOfData(Exception):
    pass


def load_ledger(path):
    if not path.exists():
        return {"version": 1, "messages": {}}
    with open(path, "r") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_SH)
        except (OSError, AttributeError):
            pass
        data = json.load(f)
    if "messages" not in data:
        data["messages"] = {}
    return data


def save_ledger(path, ledger):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        with tempfile.NamedTemporaryFile(
            mode="w", dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False
        ) as tf:
            json.dump(ledger, tf, indent=2, sort_keys=True)
            tmp_path = tf.name
        os.replace(tmp_path, path)
    finally:
        os.close(fd)


def utcnow_iso():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()


def message_id_key(message_id):
    return (message_id or "").strip().strip("<>").strip()


def raw_hash_key(raw_bytes):
    return f"raw:{hashlib.sha256(raw_bytes).hexdigest()}"


def provisional_key(envelope):
    parts = [
        str(envelope.get("id") or ""),
        str(envelope.get("date") or ""),
        (envelope.get("from") or {}).get("addr") or "",
        envelope.get("subject") or "",
    ]
    return f"prov:{hashlib.sha256('|'.join(parts).encode()).hexdigest()}"


def addresses(header_value):
    if not header_value:
        return []
    out = []
    for raw in re.split(r"[,;]", str(header_value)):
        _, addr = email.utils.parseaddr(raw.strip())
        if addr:
            out.append(addr.lower())
    return out


def list_ids(msg):
    vals = msg.get_all("List-ID") or []
    vals += msg.get_all("List-Post") or []
    return [v.strip().lower().strip("<>") for v in vals]


def brief_headers(raw_mime):
    msg = email.message_from_string(raw_mime)
    message_id = message_id_key(str(msg.get("Message-ID") or ""))
    from_addr = email.utils.parseaddr(str(msg.get("From") or ""))[1].lower()
    tos = addresses(msg.get("To"))
    ccs = addresses(msg.get("Cc"))
    lids = list_ids(msg)
    subject = str(msg.get("Subject") or "")
    has_attachment = False
    for part in msg.walk():
        if part.get_filename() or (part.get_content_disposition() or "").startswith("attachment"):
            has_attachment = True
            break
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and not part.get_filename():
                try:
                    body = (part.get_payload(decode=True) or b"").decode("utf-8", "replace")
                except Exception:
                    body = ""
                break
    else:
        body = (msg.get_payload(decode=True) or b"").decode("utf-8", "replace")
    return {
        "message_id": message_id,
        "from_addr": from_addr,
        "to_addrs": tos,
        "cc_addrs": ccs,
        "list_ids": lids,
        "subject": subject,
        "has_attachment": has_attachment,
        "body": body,
    }


def sent_to_repairs_group(hdr):
    all_addrs = hdr["to_addrs"] + hdr["cc_addrs"]
    if any(REPAIRS_GROUP in a for a in all_addrs):
        return True
    for lid in hdr["list_ids"]:
        if REPAIRS_GROUP in lid or REPAIRS_LIST_ID in lid:
            return True
    return False


def is_candidate_envelope(envelope):
    """Cheap pre-filter: True if the envelope is worth exporting for header inspection."""
    subj = (envelope.get("subject") or "").lower()
    from_addr = ((envelope.get("from") or {}).get("addr") or "").lower()
    if any(e in subj for e in SUBJECT_EXCLUDES):
        return False
    if any(a in from_addr for a in SENDER_EXCLUDES):
        return False
    if any(a in from_addr for a in KNOWN_VENDOR_SENDERS + INTERNAL_SENDERS):
        return True
    if any(k in subj for k in VENDOR_KEYWORDS):
        return True
    if any(k in subj for k in TOPIC_KEYWORDS):
        return True
    return False


def is_candidate_full(hdr):
    """Full candidate decision after MIME headers are available."""
    subj_lower = hdr["subject"].lower()
    if any(e in subj_lower for e in SUBJECT_EXCLUDES):
        return False
    if hdr["from_addr"] in SENDER_EXCLUDES:
        return False

    # Any message actually delivered to the repairs group is a candidate.
    if sent_to_repairs_group(hdr):
        return True

    # Known vendors / internal forwarders are candidates if they carry an invoice signal.
    if any(a in hdr["from_addr"] for a in KNOWN_VENDOR_SENDERS + INTERNAL_SENDERS):
        if hdr["has_attachment"]:
            return True
        body_lower = hdr["body"].lower()
        if any(k in subj_lower for k in TOPIC_KEYWORDS + VENDOR_KEYWORDS):
            return True
        if any(k in body_lower for k in ["invoice", "repair", "parts", "labor", "work order"]):
            return True

    # Fallback keyword match for non-repairs, non-internal senders.
    if any(k in subj_lower for k in VENDOR_KEYWORDS):
        return True
    if any(k in subj_lower for k in TOPIC_KEYWORDS):
        return True
    return False


def parse_email(raw_mime):
    msg = email.message_from_string(raw_mime)
    message_id = message_id_key(str(msg.get("Message-ID") or ""))
    attachments = []
    for part in msg.walk():
        if not part.get_filename() and not (part.get_content_disposition() or "").startswith("attachment"):
            continue
        payload = part.get_payload(decode=True) or b""
        ctype = part.get_content_type() or "application/octet-stream"
        attachments.append(
            {
                "name": part.get_filename() or "unnamed",
                "contentType": ctype,
                "size": len(payload),
                "fingerprint": hashlib.sha256(payload).hexdigest(),
            }
        )
    return message_id, attachments


def body_source_document_id(message_id, doc_index=0):
    normalized = message_id_key(message_id)
    encoded = base64.urlsafe_b64encode(normalized.encode("utf-8")).decode("ascii").rstrip("=")
    return f"body:{encoded}:{doc_index}"


def attachment_source_document_id(fingerprint, doc_index=0):
    return f"att:{fingerprint}:{doc_index}"


def query_repairs_group(folder, page_size=DEFAULT_PAGE_SIZE):
    """Return all envelopes addressed to the repairs group, independent of subject.

    Uses himalaya's `to repairs@bcatcorp.com` IMAP search.
    """
    results = []
    for page in range(1, 50):
        try:
            raw = run_himalaya(
                [
                    "envelope", "list",
                    "--folder", folder,
                    "--page", str(page),
                    "--page-size", str(page_size),
                    "--output", "json",
                    "to", REPAIRS_GROUP,
                ],
                timeout=120,
            )
        except EndOfData:
            break
        data = parse_himalaya_json(raw)
        log(f"repairs query page {page}: {len(data)} envelopes")
        if not data:
            break
        results.extend(data)
        if len(data) < page_size:
            break
    return results


def query_all_mail_by_keyword(work_dir, page_size=DEFAULT_PAGE_SIZE, max_pages=30):
    """Return envelopes from All Mail that match subject/vendor keywords."""
    results = []
    maybe_truncated = False
    for page in range(1, max_pages + 1):
        path = work_dir / f"mailbox_p{page}.json"
        try:
            raw = run_himalaya(
                [
                    "envelope", "list",
                    "--folder", ALL_MAIL_FOLDER,
                    "--page", str(page),
                    "--page-size", str(page_size),
                    "--output", "json",
                ],
                timeout=120,
            )
        except EndOfData:
            break
        path.write_text(raw, encoding="utf-8", errors="replace")
        data = parse_himalaya_json(raw)
        log(f"keyword scan page {page}: {len(data)} envelopes")
        if not data:
            break
        for m in data:
            if is_candidate_envelope(m):
                results.append(m)
        if len(data) < page_size:
            break
        if page == max_pages:
            maybe_truncated = True
    if maybe_truncated:
        raise RuntimeError(
            f"max_pages ({max_pages}) reached with full pages; All Mail may be truncated. "
            "Increase max_pages or reduce page_size."
        )
    return results


def export_message(uid, folder, work_dir=None):
    """Export a single message. If work_dir is provided, caches to work_dir/exports/<uid>.eml."""
    if work_dir:
        cache_dir = work_dir / "exports"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path = cache_dir / f"{uid}.eml"
        if cache_path.exists():
            return cache_path.read_bytes()
    raw = run_himalaya(
        ["message", "export", "--folder", folder, str(uid), "--full"],
        timeout=120,
    )
    result = raw.encode("utf-8", "replace")
    if work_dir:
        cache_path.write_bytes(result)
    return result


def build_meta(envelope):
    return {
        "uid": envelope.get("id"),
        "from_addr": (envelope.get("from") or {}).get("addr"),
        "from_name": (envelope.get("from") or {}).get("name"),
        "subject": envelope.get("subject"),
        "date": envelope.get("date"),
    }


def discover(ledger, ledger_path, work_dir, max_pages=30, include_done=False):
    work_dir.mkdir(parents=True, exist_ok=True)

    repairs_messages = query_repairs_group(ALL_MAIL_FOLDER)
    keyword_messages = query_all_mail_by_keyword(work_dir, max_pages=max_pages)
    by_uid = {}
    for m in repairs_messages + keyword_messages:
        uid = m.get("id")
        if uid is None or uid in by_uid:
            continue
        by_uid[uid] = m

    candidates = []
    skipped_done = 0
    failures = 0

    for uid, envelope in sorted(by_uid.items(), key=lambda kv: kv[0]):
        meta = build_meta(envelope)
        raw = None
        dirty = False
        try:
            raw = export_message(uid, ALL_MAIL_FOLDER, work_dir)
            hdr = brief_headers(raw.decode("utf-8", "replace"))
        except Exception as e:
            failures += 1
            key = provisional_key(envelope)
            ledger["messages"].setdefault(key, {"firstSeen": utcnow_iso(), "meta": meta})
            ledger["messages"][key].update({"lastTried": utcnow_iso(), "status": "failed", "error": f"export/header parse failed: {e}"})
            save_ledger(ledger_path, ledger)
            continue

        message_id = hdr["message_id"] or raw_hash_key(raw)

        if not is_candidate_full(hdr):
            continue

        try:
            _message_id, attachments = parse_email(raw.decode("utf-8", "replace"))
        except Exception as e:
            failures += 1
            ledger["messages"].setdefault(message_id, {"firstSeen": utcnow_iso(), "meta": meta})
            ledger["messages"][message_id].update({"lastTried": utcnow_iso(), "status": "failed", "error": f"MIME parse failed: {e}"})
            save_ledger(ledger_path, ledger)
            continue

        suggested = []
        for att in attachments:
            suggested.append(attachment_source_document_id(att["fingerprint"], 0))
        if not attachments:
            suggested.append(body_source_document_id(message_id, 0))

        entry = ledger["messages"].setdefault(message_id, {"firstSeen": utcnow_iso()})
        entry.update(
            {
                "meta": meta,
                "attachments": attachments,
                "status": entry.get("status", "pending"),
            }
        )
        save_ledger(ledger_path, ledger)
        status = entry.get("status", "pending")

        if status == "done":
            skipped_done += 1
            if not include_done:
                continue
        elif status == "failed":
            pass  # retry candidate

        candidates.append(
            {
                "messageId": message_id,
                "uid": uid,
                "folder": ALL_MAIL_FOLDER,
                "status": status,
                "suggestedSourceDocumentIds": suggested,
                "attachments": attachments,
                "meta": meta,
            }
        )

    # Refresh counts from ledger
    counts = {"pending": 0, "failed": 0, "done": 0, "skipped": 0}
    for entry in ledger["messages"].values():
        counts[entry.get("status", "pending")] = counts.get(entry.get("status", "pending"), 0) + 1

    return {
        "candidates": candidates,
        "counts": {
            "scannedEnvelopes": len(by_uid),
            "candidateMessages": len(candidates) + skipped_done,
            "pendingOrFailed": len(candidates),
            "doneSkipped": skipped_done,
            "exportParseFailures": failures,
            "ledger": counts,
        },
    }, failures


def cmd_discover(args):
    ledger_path = Path(args.ledger)
    ledger = load_ledger(ledger_path)
    work_dir = Path(args.work_dir)

    result, failures = discover(
        ledger,
        ledger_path,
        work_dir,
        max_pages=args.max_pages,
        include_done=args.include_done,
    )

    save_ledger(ledger_path, ledger)
    output = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
    print(output)
    if failures:
        sys.exit(1)


def cmd_mark(args):
    ledger_path = Path(args.ledger)
    ledger = load_ledger(ledger_path)
    message_id = message_id_key(args.message_id)

    entry = ledger["messages"].setdefault(message_id, {"firstSeen": utcnow_iso()})
    entry["lastTried"] = utcnow_iso()
    entry["status"] = args.status

    if args.error:
        entry["error"] = args.error
    elif "error" in entry:
        del entry["error"]

    invoices = []
    if args.invoices:
        invoices = json.loads(args.invoices)
        if not isinstance(invoices, list):
            raise SystemExit("--invoices must be a JSON array")
    if invoices:
        entry["invoices"] = invoices
    elif "invoices" in entry:
        del entry["invoices"]

    save_ledger(ledger_path, ledger)
    print(json.dumps({"messageId": message_id, "status": args.status}, indent=2))


def cmd_status(args):
    ledger = load_ledger(Path(args.ledger))
    counts = {}
    for entry in ledger["messages"].values():
        counts[entry.get("status", "pending")] = counts.get(entry.get("status", "pending"), 0) + 1
    print(json.dumps({"ledger": str(args.ledger), "counts": counts}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", "-l", default=str(DEFAULT_LEDGER), help="Path to ledger JSON")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_discover = subparsers.add_parser("discover", help="Find PENDING/FAILED maintenance invoice candidates")
    p_discover.add_argument("--output", "-o", help="Write candidate JSON to file; otherwise stdout")
    p_discover.add_argument("--work-dir", default=str(DEFAULT_WORK_DIR), help="Cache himalaya page dumps")
    p_discover.add_argument("--max-pages", type=int, default=30, help="Stop after N empty pages (raise if cap reached with data)")
    p_discover.add_argument("--include-done", action="store_true", help="Include already-done messages in output")
    p_discover.set_defaults(func=cmd_discover)

    p_mark = subparsers.add_parser("mark", help="Record the outcome for a message")
    p_mark.add_argument("--message-id", required=True, help="RFC822 Message-ID (with or without angle brackets)")
    p_mark.add_argument("--status", required=True, choices=["pending", "done", "failed", "skipped"], help="New ledger status")
    p_mark.add_argument("--invoices", help="JSON array of ingested invoice records with sourceDocumentId")
    p_mark.add_argument("--error", help="Failure reason (preserved for retry)")
    p_mark.set_defaults(func=cmd_mark)

    p_status = subparsers.add_parser("status", help="Show ledger summary")
    p_status.set_defaults(func=cmd_status)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
