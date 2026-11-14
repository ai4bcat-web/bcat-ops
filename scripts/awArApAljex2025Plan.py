#!/usr/bin/env python3
"""AR/AP from Aljex, invoices dated 2025-01-01 on (Ryne 2026-11-14). PLANNER: reads the Aljex reports, the AP pay-run
ledger, the pre-2025-delete backup and a fresh prod scan, and writes plan.json for scripts/awArApAljex2025.mjs (which
re-reads every row live, backs up, writes conditionally and audits). Writes nothing to AWS.

  python3 scripts/awArApAljex2025Plan.py --live <dir of fresh scans> --out <plan.json> [--missing-bills] [--invoice-16]

Sections: A restore/create the shipments invoiced in 2025 that shipped before 2025 · B (flag) release + invoice the 16 ·
C AR fixes · D pay-to / method / ref on existing AP payments and bills · E AP paid date = AP workbook · F (flag) carrier
legs + bills for loads with none · G short pays closed with an AP credit · H list only.
"""
import argparse, collections, csv, datetime, hashlib, json, os, re, sys

ap = argparse.ArgumentParser()
ap.add_argument('--live', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--missing-bills', action='store_true', help='item 6: carrier legs + bills for loads with no bill (pending Ryne)')
ap.add_argument('--invoice-16', action='store_true', help='item 7: release + invoice the 16 Aljex-invoiced loads (pending Ryne)')
args = ap.parse_args()

UP = '/Users/adminoid/.claude/uploads/26abbbe7-3e85-44fd-af28-98612b9ceb5b/'
NEW_REPORT = UP + 'cacc6636-https___bcal.aljex.com_ptmp_yudondc.csv'
OLD_REPORT = UP + '8c09abd4-https___bcal.aljex.com_ptmp_692pmg5.csv'
LEDGER = os.path.expanduser('~/Downloads/aljex-ap-payment-ledger-2025-2026.csv')
ALIAS_OUT = os.path.expanduser('~/Downloads/aljex-payto-alias-map.csv')
BACKUP = os.path.expanduser('~/bcat-ops-backups/pre-delete-2025/')
ACTOR = 'aljex-arap-2025'
RUN = 'aljexarap2025'

def de(v):
    (t, x), = v.items()
    if t == 'S': return x
    if t == 'N': return int(x) if re.fullmatch(r'-?\d+', x) else float(x)
    if t == 'BOOL': return x
    if t == 'NULL': return None
    if t == 'M': return {k: de(w) for k, w in x.items()}
    if t == 'L': return [de(w) for w in x]
    if t in ('SS', 'NS'): return list(x)
    return x
def live(t): return [{k: de(v) for k, v in i.items()} for i in json.load(open(os.path.join(args.live, t + '.json')))['Items']]
def jl(n): return [json.loads(l) for l in open(BACKUP + n)] if os.path.exists(BACKUP + n) else []
def cents(v):
    v = str(v or '').replace(',', '').replace('$', '').strip()
    try: return round(float(v) * 100)
    except ValueError: return 0
def dt(s):
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{2,4})', str(s or '').strip())
    if not m: return None
    y = int(m.group(3)); y = y + 2000 if y < 100 else y
    return f'{y}-{int(m.group(1)):02d}-{int(m.group(2)):02d}'
noon = lambda d: f'{d}T12:00:00.000Z'
def add_days(d, n): return (datetime.date.fromisoformat(d) + datetime.timedelta(days=n)).isoformat()
norm = lambda s: re.sub(r'[^A-Z0-9]', '', str(s or '').upper())
SUF = re.compile(r'(INCORPORATED|INC|LLC|LL|CORPORATION|CORP|CO|COMPANY|LTD|SERVICES|SERVICE|GROUP|DBA.*)$')
def nn(s):
    s = norm(s)
    for _ in range(3): s = SUF.sub('', s)
    return s
def same(a, b):
    a, b = nn(a), nn(b); n = min(len(a), len(b), 10)
    return bool(a and b) and a[:n] == b[:n]
hid = lambda *p: hashlib.sha256(':'.join(map(str, p)).encode()).hexdigest()[:16]

# ── live state ────────────────────────────────────────────────────────────────────────────────────────────────────────
S = live('Shipment'); O = live('Order'); I = live('Invoice'); B = live('CarrierBill'); LC = live('LoadCarrier')
APP = live('ApPayment'); FACTOR_ITEMS = {f['id']: f for f in live('FactoringItem')}; CUSTOMER_CHARGES = collections.defaultdict(list)
for c in live('LoadChargeCustomer'): CUSTOMER_CHARGES[c.get('shipmentId')].append(c)
APP = APP; live_fin = {f['id']: f for f in live('LoadFinancials')}; ARP = live('ArPayment'); CAR = live('Carrier'); CU = live('Customer'); PC = live('ProClaim')
shipBy = collections.defaultdict(list)
for s in S: shipBy[str(s.get('number'))].append(s)
ordById = {o['id']: o for o in O}; ordByShip = collections.defaultdict(list)
for o in O: ordByShip[o.get('shipmentId')].append(o)
invById = {i['id']: i for i in I}
billById = {b['id']: b for b in B}; billsByShip = collections.defaultdict(list)
for b in B: billsByShip[b.get('shipmentId')].append(b)
lcById = {l['id']: l for l in LC}; lcByShip = collections.defaultdict(list)
for l in LC: lcByShip[l.get('shipmentId')].append(l)
appById = {p['id']: p for p in APP}
appsByBill = collections.defaultdict(list)
for p in APP:
    for a in p.get('applications') or []: appsByBill[a.get('billId')].append(p)
carById = {c['id']: c for c in CAR}; cusById = {c['id']: c for c in CU}
claimed = {p['id'] for p in PC}
carByName = collections.defaultdict(set)
for c in CAR:
    for n in (c.get('name'), c.get('dbaName')):
        if n: carByName[norm(n)].add(c['id'])
cusByName = collections.defaultdict(set)
for c in CU:
    if c.get('name'): cusByName[norm(c['name'])].add(c['id'])
def uniq(ids):
    ids = {i for i in ids if not (carById.get(i) or cusById.get(i) or {}).get('mergedIntoId')}
    return next(iter(ids)) if len(ids) == 1 else None
def carrier_by_name(v):
    n = norm(v)
    if not n: return None
    hit = uniq(carByName.get(n, set()))
    if hit: return hit
    pre = {i for k, ids in carByName.items() if k.startswith(n) for i in ids}
    return uniq(pre)

plan, listing, conflicts = [], [], []
def op(section, pro, kind, **kw): plan.append({'section': section, 'pro': pro, 'kind': kind, **kw})
def put(section, pro, table, row, audit=None):
    op(section, pro, 'put', table=table, id=row['id'], row=row, audit=audit)
def update(section, pro, table, row, set_, remove=(), audit=None, why=''):
    """Conditional on the row's updatedAt as scanned; the executor re-reads it and refuses a changed row."""
    op(section, pro, 'update', table=table, id=row['id'], expectUpdatedAt=row.get('updatedAt'), set=set_, remove=list(remove),
       before={k: row.get(k) for k in list(set_) + list(remove)}, audit=audit or {'action': 'ALJEX_ARAP_2025', 'why': why})
def invoke(section, pro, action, input_, expect=None, why=''):
    op(section, pro, 'invoke', action=action, input=input_, expect=expect or {}, why=why)
def conflict(section, pro, what): conflicts.append({'section': section, 'pro': pro, 'what': what})

# ── Aljex reports + ledger ─────────────────────────────────────────────────────────────────────────────────────────────
NEW = [x for x in csv.DictReader(open(NEW_REPORT, encoding='utf-8', errors='replace')) if x['Invoice Date'].strip()]
OLD = {x['Pro #'].strip(): x for x in csv.DictReader(open(OLD_REPORT, encoding='utf-8', errors='replace')) if x['Invoice Date'].strip()}
SCOPE = [x for x in NEW if (dt(x['Invoice Date']) or '') >= '2025-01-01' and x['Type'].strip() not in ('CRED', 'DEBT')]
byPro = {}
for x in SCOPE: byPro.setdefault(x['Pro #'].strip(), x)
LEDGER_ROWS = [x for x in csv.DictReader(open(LEDGER)) if x['Scope'] == '2025+ invoice']

# ── pay-to alias map (item 4) ──────────────────────────────────────────────────────────────────────────────────────────
PLACEHOLDER = {'ZELLE': 'ZELLE', 'ACH': 'ACH', 'SPREADSHEET': None, 'PAY VIA USHIP WEBSITE': None, '': None}
MANUAL = [  # (raw prefix after norm, canonical)
    ('TRIUMPH', 'TBK Bank, SSB DBA Triumph'), ('TBKBANK', 'TBK Bank, SSB DBA Triumph'),
    ('TAFS', 'TAFS, Inc.'), ('ECAPITAL', 'eCapital Freight Factoring Inc'),
    ('JDFACTORSCHICAGO', 'JD Factors (Chicago Office)'), ('JDFACTORSONTARIO', 'JD FACTORS (Ontario Office)'),
    ('JDFACTORS', 'JD Factors LLC'), ('JDFACTORSLLCILLINOIS', 'JD Factors LLC'),
    ('LOVESSOLUTIONS', "Love's Solutions, LLC"),
    ('WEXFLEETONE', 'WEX Fleet One Factoring, LLC'), ('FLEETONEFACTORING', 'WEX Fleet One Factoring, LLC'), ('WEXBANK', 'WEX Bank'),
    ('PHOENIXCAPITALGRO', 'Gulf Coast/PHOENIX CAPITAL GROUP LLC'), ('GULFCOASTPHOENIX', 'Gulf Coast/PHOENIX CAPITAL GROUP LLC'),
    ('ASSISTFINANCIAL', 'ASSIST FINANCIAL SERVICES INC'), ('OTRCAPITAL', 'OTR CAPITAL LLC'), ('RTSFINANCIAL', 'RTS Financial'),
    ('ALLPOINTSTRANSPORTEVANS', 'ALL POINTS TRANSPORT (EVANS)'), ('TRANSPORTATIONALLIANCEBANK', 'Transportation Alliance Bank Inc'),
]
MANUAL.sort(key=lambda m: -len(m[0]))
def riviera(raw): return 'Riviera Finance - ' + raw.split('-', 1)[1].strip().title() if '-' in raw else 'Riviera Finance'
alias = {}
for x in LEDGER_ROWS:
    raw = x['Pay to'].strip(); key = raw.upper()
    if key in alias: alias[key]['lines'] += 1; continue
    n = norm(raw)
    if key in PLACEHOLDER:
        alias[key] = {'raw': raw, 'kind': 'CARRIER', 'canonical': '', 'method': PLACEHOLDER[key], 'source': 'placeholder (not a payee)', 'lines': 1}; continue
    if x['Payee kind'] == 'CARRIER':
        alias[key] = {'raw': raw, 'kind': 'CARRIER', 'canonical': '', 'method': None, 'source': 'same as carrier', 'lines': 1}; continue
    canon, src = None, ''
    if n.startswith('RIVIERAFINANCE'): canon, src = riviera(raw), 'manual (office kept)'
    else:
        for pre, c in MANUAL:
            if n.startswith(pre): canon, src = c, 'manual alias'; break
    if not canon and x['Factor record match'] and x['Factor record match'] != 'AMBIGUOUS':
        canon, src = x['Factor record match'], 'factor record (MyCarrierPackets)'
    if not canon: canon, src = raw, 'kept as written (no factor record)'
    alias[key] = {'raw': raw, 'kind': 'FACTOR', 'canonical': canon, 'method': None, 'source': src, 'lines': 1}
with open(ALIAS_OUT, 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['Pay to as written in AP workbook', 'Lines', 'Treated as', 'Pay-to name BCAT will show', 'Payment method implied', 'Why'])
    for a in sorted(alias.values(), key=lambda a: (a['kind'], a['canonical'], a['raw'])):
        w.writerow([a['raw'] or '(blank)', a['lines'], 'Factor' if a['kind'] == 'FACTOR' else 'Carrier (direct)', a['canonical'] or '(the carrier)', a['method'] or '', a['source']])

def method_of(line, carrier_name):
    if 'ECHO' in norm(line['Vendor']) or 'ECHO' in norm(carrier_name) or 'ECHO' in norm(line['Pay to']): return 'CARD', 'ECHO is paid by Amex (Ryne)'
    m = (line['Pay mode'] + ' ' + line['Pay type']).upper()
    if 'AMEX' in m or 'CREDIT CARD' in m or re.search(r'\bCC\b', m): return 'CARD', 'card/Amex in workbook'
    if 'ZELLE' in m or line['Pay to'].strip().upper() == 'ZELLE': return 'ZELLE', 'Zelle in workbook'
    if 'CHECK' in line['Pay type'].upper(): return 'CHECK', 'check in workbook'
    if 'ACH' in m or 'DRAFT' in m or line['Pay to'].strip().upper() == 'ACH': return 'ACH', 'ACH/draft in workbook'
    if 'PREPAID' in m: return 'OTHER', 'prepaid in workbook'
    if 'QUICK PAY' in m: return 'ACH', 'quick pay (ACH) in workbook'
    return None, 'no method in workbook'

# ── D + E: pay-to, method, reference, paid date on existing AP payments and their bills ────────────────────────────────
linesByPayment = collections.defaultdict(list)
for x in LEDGER_ROWS:
    if x['BCAT match'] == 'matched to BCAT payment' and x['BCAT payment']: linesByPayment[x['BCAT payment']].append(x)
billTouch = {}   # bill id -> dict of fields to set (merged across payments)
billDates = collections.defaultdict(set)
lcPaid = {}
stats = collections.Counter()
for pid, lines in linesByPayment.items():
    p = appById.get(pid)
    if not p: conflict('D', lines[0]['PRO'], f'payment {pid} no longer in prod'); continue
    pros = sorted({l['PRO'] for l in lines})
    carrier = carById.get(p.get('carrierId')) or {}
    payees = {(alias[l['Pay to'].strip().upper()]['kind'], alias[l['Pay to'].strip().upper()]['canonical']) for l in lines}
    rawPayTo = sorted({l['Pay to'].strip() for l in lines if l['Pay to'].strip()})
    methods = {method_of(l, carrier.get('name') or l['Vendor']) for l in lines}
    dates = {l['Paid date'] for l in lines if l['Paid date']}
    refs = {l['Check/ref'].strip() for l in lines if l['Check/ref'].strip()}
    s = {}; notes = []
    if len(payees) == 1:
        kind, canon = next(iter(payees))
        if kind == 'FACTOR':
            remit = {**(p.get('remitTo') or {}), 'name': canon, 'factorName': canon}
            if p.get('payeeKind') != 'FACTOR' or (p.get('remitTo') or {}).get('name') != canon:
                s['payeeKind'] = 'FACTOR'; s['remitTo'] = remit
        else:
            if p.get('payeeKind') != 'CARRIER': s['payeeKind'] = 'CARRIER'
        placeholder = [r for r in rawPayTo if r.upper() in PLACEHOLDER]
        if placeholder: notes.append(f'AP workbook pay-to: {", ".join(placeholder)}')
    else:
        conflict('D', ' '.join(pros), f'payment {pid}: workbook lines disagree on pay-to: {rawPayTo}')
    ms = {m for m, _ in methods if m}
    if len(ms) == 1:
        m = next(iter(ms))
        if p.get('method') != m: s['method'] = m
    elif len(ms) > 1: conflict('D', ' '.join(pros), f'payment {pid}: workbook lines disagree on method: {sorted(ms)}')
    if len(refs) == 1 and not p.get('reference'): s['reference'] = next(iter(refs))
    elif len(refs) == 1 and p.get('reference') != next(iter(refs)): notes.append(f'AP workbook check/ref {next(iter(refs))}')
    if len(dates) == 1:
        d = next(iter(dates))
        cur = (p.get('paidAt') or '')[:10]
        if cur and cur != d and abs((datetime.date.fromisoformat(d) - datetime.date.fromisoformat(cur)).days) > 31:
            conflict('E', ' '.join(pros), f'payment {pid}: workbook paid date {d} is more than a month from BCAT/Aljex {cur}; date left as is')
        elif cur != d: s['paidAt'] = noon(d); stats['E payment date moved'] += 1
    elif len(dates) > 1: conflict('E', ' '.join(pros), f'payment {pid}: workbook lines have several paid dates {sorted(dates)}; date left as is')
    if notes:
        old = p.get('note') or ''
        add = '; '.join(n for n in notes if n not in old)
        if add: s['note'] = (old + ('; ' if old else '') + add)[:1000]
    if s:
        sec = 'E' if set(s) <= {'paidAt'} else 'D'
        update(sec, ' '.join(pros), 'ApPayment', p, s, why='AP workbook pay-to/method/ref/paid date (Ryne 2026-11-14 items 2-4)')
    # bills this payment applies to: pay-to follows the payment; paid date = latest payment date on the bill
    for a in p.get('applications') or []:
        bid = a.get('billId'); b = billById.get(bid)
        if not b: continue
        t = billTouch.setdefault(bid, {})
        if 'payeeKind' in s: t['payeeKind'] = s['payeeKind']
        if 'remitTo' in s: t['remitTo'] = {**(b.get('remitTo') or {}), 'name': s['remitTo']['name'], 'factorName': s['remitTo']['factorName']}
        billDates[bid].add((s.get('paidAt') or p.get('paidAt') or '')[:10])
for bid, t in billTouch.items():
    b = billById[bid]
    # every payment applied to the bill, with its (new) date, decides the bill's paid date
    ds = set()
    for p in appsByBill.get(bid, []):
        if p.get('kind') != 'PAYMENT' or p.get('reversedByPaymentId'): continue
        pl = [x for x in plan if x['kind'] == 'update' and x['table'] == 'ApPayment' and x['id'] == p['id']]
        ds.add(((pl[0]['set'].get('paidAt') if pl else None) or p.get('paidAt') or '')[:10])
    s = {}
    if t.get('payeeKind') and t['payeeKind'] != b.get('payeeKind'): s['payeeKind'] = t['payeeKind']
    if t.get('remitTo') and (b.get('remitTo') or {}).get('name') != t['remitTo']['name']: s['remitTo'] = t['remitTo']
    if t.get('payeeKind') == 'CARRIER' and b.get('remitTo') and (b.get('remitTo') or {}).get('factorName'):
        s['remitTo'] = {k: v for k, v in (b.get('remitTo') or {}).items() if k not in ('factorName',)}
    if b.get('status') == 'PAID' and ds:
        d = max(x for x in ds if x)
        if (b.get('paidAt') or '')[:10] != d:
            s['paidAt'] = noon(d)
            lc = lcById.get(b.get('loadCarrierId'))
            if lc and lc.get('invoiceId') in (None, bid) and lc.get('apStatus') == 'PAID' and (lc.get('apPaidAt') or '')[:10] != d:
                lcPaid[lc['id']] = (lc, d, b.get('shipmentNumber'))
    if s: update('D' if set(s) - {'paidAt'} else 'E', b.get('shipmentNumber'), 'CarrierBill', b, s, why='pay-to / paid date follow the AP workbook payment')
for lid, (lc, d, pro) in lcPaid.items():
    update('E', pro, 'LoadCarrier', lc, {'apPaidAt': noon(d)}, why='leg paid date follows its bill')

# ── C: AR fixes (item 8) ───────────────────────────────────────────────────────────────────────────────────────────────
def inv_of(pro): return invById.get(pro)
# ── K: 11836 back into the OTR factoring flow at $305 (Ryne 2026-11-14) ──────────────────────────────────────────────
# Not factored yet. The issued invoice (AR-sheet import, $375) prints our own remit-to, so Send to Factor refuses it
# ("addressed to pay us, not the factor; void and re-issue") — PREVIEW_FACTOR confirms; its release gate is clear.
# The app's own path: void it (admin), set the customer line haul to $305 (RECALC_CHARGES), and let the order sit in
# Ready to invoice (UNBILLED + delivered) for Ryne's batch Factor, which issues the replacement with OTR's remit-to and
# links the existing e-mail queue row (FactoringItem 11836, found by the load's aljexId). That row gets the order /
# shipment / customer ids so the queue shows ONE row for PRO 11836, not the order plus a stray $375 e-mail row.
i11836 = inv_of('11836')
fi11836 = FACTOR_ITEMS.get('11836')
ord11836 = ordById.get((i11836 or {}).get('orderId'))
sh11836 = next((s for s in shipBy.get('11836', []) if not s.get('voidedAt')), None)
if not (i11836 and ord11836 and sh11836): conflict('K', '11836', 'invoice, order or shipment missing')
elif i11836.get('status') != 'ISSUED' or (i11836.get('paidCents') or 0) or i11836.get('factoringItemId'):
    conflict('K', '11836', f"invoice is {i11836.get('status')} paid {i11836.get('paidCents')} factoringItem {i11836.get('factoringItemId')}; not voided")
elif fi11836 and (fi11836.get('otrInvoiceId') or fi11836.get('invoiceId')):
    conflict('K', '11836', f"FactoringItem 11836 already linked ({fi11836.get('invoiceId')}) or at OTR ({fi11836.get('otrInvoiceId')})")
else:
    invoke('K', '11836', 'VOID_INVOICE', {'invoiceId': '11836', 'reason': 'Not factored yet: amount corrected to $305 (Aljex) and re-billed through OTR factoring (Ryne 2026-11-14)'},
           expect={'table': 'Invoice', 'id': '11836', 'field': 'status', 'before': 'ISSUED', 'after': 'VOID'},
           why='void the $375 invoice that prints our remit-to; the order goes back to UNBILLED (Ready to invoice)')
    charge = [c for c in CUSTOMER_CHARGES.get(sh11836['id'], [])]
    if len(charge) != 1 or charge[0].get('amountCents') != 37500:
        conflict('K', '11836', f'customer charges are {[(c.get("code"), c.get("amountCents")) for c in charge]}; not repriced')
    else:
        c = charge[0]
        invoke('K', '11836', 'RECALC_CHARGES', {'shipmentId': sh11836['id'], 'expectedVersion': {'$live': ['Shipment', sh11836['id'], 'version']},
               'charges': [{'id': c['id'], 'side': 'CUSTOMER', 'code': c['code'], 'label': c.get('label') or 'Line haul', 'calculatedBy': 'FLAT', 'rateCents': 30500, 'count': 1}],
               'changeReason': 'Aljex amount is $305 (Ryne 2026-11-14)'},
               expect={'table': 'Order', 'id': ord11836['id'], 'field': 'revenueCents', 'before': 37500, 'after': 30500},
               why='customer line haul $375 → $305 (order revenue and financials follow)')
    if fi11836:
        update('K', '11836', 'FactoringItem', fi11836, {'orderId': ord11836['id'], 'shipmentId': sh11836['id'], 'customerId': ord11836.get('customerId')},
               why='one queue row for PRO 11836: the e-mail row is tied to its order, so Ready to invoice shows the order once; Send to Factor links the new invoice to it')
        plan[-1]['absent'] = ['invoiceId', 'otrInvoiceId']   # its readiness refresher rewrites updatedAt; what must hold is "still unlinked, not at OTR"
    listing.append({'section': 'K', 'pro': '11836', 'what': 'After this: Ready to invoice shows 11836 at $305 for STEAM LOGISTICS (factored, MC 894343). Ryne batch-Factors it; '
                    'the app issues the replacement invoice (number 11836-2, OTR remit-to) and links FactoringItem 11836. Nothing goes to OTR until Ryne submits.'})

for pro, want in (('13748', 90000), ('14096', 35000)):
    i = inv_of(pro)
    ok = i and i.get('totalCents') == want and i.get('status') == 'PAID' and i.get('paidCents') == want
    listing.append({'section': 'C', 'pro': pro, 'what': f"BCAT invoice {i.get('totalCents') if i else None} {i.get('status') if i else None}, paid {i.get('paidCents') if i else None}: {'matches' if ok else 'DOES NOT match'} Ryne's ${want/100:.2f}; no write"})
for pro in ('14379', '14664'):
    i = inv_of(pro); r = byPro.get(pro)
    if not i or not r: conflict('C', pro, 'invoice or Aljex row missing'); continue
    amt = cents(r['Amount Paid']); d = dt(r['Date Paid'])
    if i.get('status') == 'PAID': listing.append({'section': 'C', 'pro': pro, 'what': 'already paid in BCAT'}); continue
    if amt != i.get('balanceCents'): conflict('C', pro, f"Aljex paid {amt} but BCAT balance {i.get('balanceCents')}"); continue
    invoke('C', pro, 'RECORD_PAYMENT', {'customerId': i['customerId'], 'receivedAt': d, 'method': 'OTHER', 'reference': f'Aljex paid {d}',
           'amountCents': amt, 'applications': [{'invoiceId': pro, 'amountCents': amt}], 'note': f'Customer payment per Aljex ({d}); Ryne 2026-11-14',
           'clientRequestId': f'{RUN}-ar-{pro}'}, expect={'idTable': 'ArPayment', 'idPrefix': 'pay', 'party': i['customerId'], 'crid': f'{RUN}-ar-{pro}'},
           why=f'record ${amt/100:.2f} received {d}')

shortBills, shortLegs = {}, {}
# ── G: short pays closed to match Aljex (item 5) ───────────────────────────────────────────────────────────────────────
for pro in ['12464', '12631', '12659', '13156', '13405', '13551', '13780', '14223']:
    r = byPro.get(pro); ss = [s for s in shipBy.get(pro, []) if not s.get('voidedAt') and not s.get('deletedAt')]
    if not ss or not r: conflict('G', pro, 'shipment or Aljex row missing'); continue
    bills = [b for b in billsByShip[ss[0]['id']] if b.get('status') == 'PARTIAL']
    aljexPaid = cents(r['AP Paid Non-Comm'])
    if len(bills) != 1: conflict('G', pro, f'{len(bills)} PARTIAL bills'); continue
    b = bills[0]
    if (b.get('paidCents') or 0) != aljexPaid: conflict('G', pro, f"BCAT paid {b.get('paidCents')} vs Aljex paid {aljexPaid}; not closed"); continue
    diff = b.get('balanceCents') or 0
    if diff <= 0: continue
    lastPaid = max([(q.get('paidAt') or '')[:10] for q in appsByBill.get(b['id'], [])] or [dt(r['AP Paid Date']) or '2026-11-14'])
    # The app's own RECORD_AP_PAYMENT refuses these: an Aljex-imported leg never carries invoiceId = bill, which its leg
    # condition requires. So the end state of CREATE_AP_CREDIT + applying it is written directly, in the app's shape.
    cm, pay = f'apcm-aljex25-{pro}', f'app-aljex25-short-{pro}'
    why = f'Short pay closed to match Aljex: carrier paid ${aljexPaid/100:,.2f} of ${(b.get("netCents") or 0)/100:,.2f} (Ryne 2026-11-14)'
    aud = {'action': 'ALJEX_ARAP_2025_SHORT_PAY', 'why': why}
    put('G', pro, 'ApPayment', {'id': cm, 'carrierId': b['carrierId'], 'kind': 'CREDIT_MEMO', 'paidAt': noon(lastPaid), 'reference': f'Short pay {pro}',
        'amountCents': diff, 'appliedCents': diff, 'unappliedCents': 0, 'applications': [], 'creditApplications': [], 'loadCarrierId': b['loadCarrierId'],
        'note': why, 'createdBy': ACTOR}, aud)
    put('G', pro, 'ApPayment', {'id': pay, 'carrierId': b['carrierId'], 'payeeKind': b.get('payeeKind') or 'CARRIER', 'kind': 'PAYMENT', 'paidAt': noon(lastPaid),
        'method': 'OTHER', 'reference': f'Short pay {pro}', 'amountCents': 0, 'appliedCents': diff, 'unappliedCents': 0,
        'applications': [{'billId': b['id'], 'amountCents': diff, 'creditCents': diff}], 'creditApplications': [{'paymentId': cm, 'amountCents': diff}],
        'remittanceCount': 0, 'note': 'Applies the short-pay credit so the bill closes like Aljex (Ryne 2026-11-14)', 'createdBy': ACTOR}, aud)
    shortBills[b['id']] = {'creditedCents': (b.get('creditedCents') or 0) + diff, 'balanceCents': 0, 'status': 'PAID', 'paidAt': noon(lastPaid),
                           'version': (b.get('version') or 1) + 1, 'updatedBy': ACTOR}
    lc = lcById.get(b.get('loadCarrierId'))
    if lc: shortLegs[lc['id']] = {'apStatus': 'PAID', 'apBalanceCents': 0, 'apPaidAt': noon(lastPaid), 'apStatusChangedAt': noon(lastPaid), 'updatedBy': ACTOR}

def merge_update(section, pro, table, row, set_, remove, why):
    for o in plan:
        if o['kind'] == 'update' and o['table'] == table and o['id'] == row['id']:
            for k, v in set_.items():
                if k in ('paidAt', 'apPaidAt') and k in o['set']: continue   # the AP workbook date (E) wins
                o['set'][k] = v; o['before'][k] = row.get(k)
            o['remove'] = sorted(set(o['remove']) | set(remove)); o['section'] = section; o['audit']['why'] += '; ' + why
            return
    update(section, pro, table, row, set_, remove=remove, why=why)
for bid, st in shortBills.items():
    merge_update('G', billById[bid].get('shipmentNumber'), 'CarrierBill', billById[bid], st, ['apOpen'], 'short pay closed to match Aljex')
for lid, st in shortLegs.items():
    merge_update('G', None, 'LoadCarrier', lcById[lid], st, ['apOpen'], 'short pay closed to match Aljex')

# ── A: shipments invoiced in 2025 that shipped before 2025 (item 1) ───────────────────────────────────────────────────
missing = [p for p, r in byPro.items() if not shipBy.get(p)]
bk = {n: jl(n + '.delete.jsonl') for n in ['Shipment', 'Order', 'Load', 'LoadCarrier', 'LoadCharge', 'LoadFinancials', 'Invoice', 'CarrierBill', 'ProClaim', 'LegacyAljexRow', 'ArPayment', 'ApPayment']}
bkMod = {n: jl(n + '.modify.jsonl') for n in ['ArPayment', 'ApPayment']}
bkShip = {str(s['number']): s for s in bk['Shipment']}
restore = [p for p in missing if p in bkShip]; build = [p for p in missing if p not in bkShip]
rids = {bkShip[p]['id'] for p in restore}
# derived fields that later backfills added to every legacy row (salesRep*, customerRepId, equipmentType)
repByCus = collections.defaultdict(collections.Counter); eqByType = collections.defaultdict(collections.Counter); crepByCus = collections.defaultdict(collections.Counter)
for s in S:
    if s.get('salesRepId'): repByCus[s.get('customerId')][(s['salesRepId'], s.get('salesRepCode'))] += 1
for o in O:
    if o.get('customerRepId'): crepByCus[o.get('customerId')][o['customerRepId']] += 1
    t = next((r.get('value') for r in o.get('references') or [] if r.get('code') == 'ALJEX_TYPE'), None)
    if t and o.get('equipmentType'): eqByType[t][o['equipmentType']] += 1
def eq_for(t): c = eqByType.get(t); return c.most_common(1)[0][0] if c else None
DELETED_CARRIERS = {c['id']: c for c in (json.loads(l) for l in open(os.path.expanduser('~/bcat-ops-backups/pre-delete-carriers/20261109T144139/carriers.jsonl')))}
deletedCarByName = collections.defaultdict(set)
for c in DELETED_CARRIERS.values(): deletedCarByName[norm(c.get('name'))].add(c['id'])
carrier_restored = set()
def restore_carrier(cid, pro):
    """A carrier the 11-09 carrier clean-up deleted (no loads left then): put back INACTIVE so the restored leg/bill point at a real row."""
    c = DELETED_CARRIERS.get(cid)
    if not c: return False
    if cid not in carrier_restored:
        carrier_restored.add(cid)
        put('A', pro, 'Carrier', {**c, 'status': 'INACTIVE', 'updatedBy': ACTOR},
            audit={'action': 'ALJEX_ARAP_2025_RESTORE', 'why': 'carrier of a restored 2025-invoiced load; restored INACTIVE from the 11-09 carrier-delete backup'})
    carById[cid] = c
    return True
restored_inv, restored_bill = set(), set()
for p in restore:
    s0 = bkShip[p]; sid = s0['id']
    if p in claimed: conflict('A', p, 'PRO already claimed in prod; not restored'); continue
    cus = cusById.get(s0.get('customerId'))
    if not cus: conflict('A', p, f"customer {s0.get('customerId')} ({s0.get('customerName')}) no longer in prod; not restored"); continue
    aljexType = None
    for n in ['ProClaim', 'Shipment', 'Order', 'Load', 'LoadCarrier', 'LoadCharge', 'LoadFinancials', 'Invoice', 'CarrierBill', 'LegacyAljexRow']:
        rows = [x for x in bk[n] if x.get('shipmentId') == sid or (n == 'Shipment' and x.get('id') == sid) or (n == 'ProClaim' and x.get('id') == p)]
        for x in rows:
            x = dict(x)
            if n == 'Shipment':
                rep = repByCus.get(x.get('customerId'))
                if rep: (x['salesRepId'], x['salesRepCode']) = rep.most_common(1)[0][0]
            if n == 'Order':
                aljexType = next((r.get('value') for r in x.get('references') or [] if r.get('code') == 'ALJEX_TYPE'), None)
                cr = crepByCus.get(x.get('customerId'))
                if cr: x['customerRepId'] = cr.most_common(1)[0][0]
                if eq_for(aljexType): x['equipmentType'] = eq_for(aljexType)
            if n == 'Load' and eq_for(aljexType): x['equipmentType'] = eq_for(aljexType)
            if n in ('LoadCarrier', 'CarrierBill') and x.get('carrierId') and x['carrierId'] not in carById:
                if not restore_carrier(x['carrierId'], p):
                    conflict('A', p, f"{n} {x['id']}: carrier {x['carrierId']} ({x.get('carrierName')}) no longer in prod or in the carrier backup"); continue
            if n == 'Invoice': restored_inv.add(x['id'])
            if n == 'CarrierBill': restored_bill.add(x['id'])
            put('A', p, n, x, audit={'action': 'ALJEX_ARAP_2025_RESTORE', 'why': 'restored from the pre-2025 delete backup: invoiced in 2025 (Ryne 2026-11-14 item 1)'})
# payments of the restored invoices / bills: whole deleted payments come back (only their restored lines); payments that were
# trimmed by the delete get their removed lines added back
for n, key, keep in (('ArPayment', 'invoiceId', restored_inv), ('ApPayment', 'billId', restored_bill)):
    for x in bk[n]:
        apps = [a for a in x.get('applications') or [] if a.get(key) in keep]
        if not apps: continue
        y = dict(x); amt = sum(a['amountCents'] for a in apps)
        if len(apps) != len(x.get('applications') or []):
            y['applications'] = apps; y['amountCents'] = amt + (x.get('unappliedCents') or 0); y['appliedCents'] = amt
        put('A', '/'.join(sorted({str(a[key]) for a in apps})), n, y, audit={'action': 'ALJEX_ARAP_2025_RESTORE', 'why': 'payment of a restored invoice/bill'})
    for m in bkMod[n]:
        bef = m['before']; apps = [a for a in bef.get('applications') or [] if a.get(key) in keep]
        if not apps: continue
        cur = (appById if n == 'ApPayment' else {q['id']: q for q in ARP}).get(bef['id'])
        if not cur: conflict('A', bef['id'], f'{n} {bef["id"]} trimmed by the delete is gone from prod'); continue
        have = {(a.get(key)) for a in cur.get('applications') or []}
        add = [a for a in apps if a.get(key) not in have]
        if not add: continue
        amt = sum(a['amountCents'] for a in add)
        update('A', '/'.join(sorted({str(a[key]) for a in add})), n, cur, {'applications': (cur.get('applications') or []) + add,
               'amountCents': (cur.get('amountCents') or 0) + amt, 'appliedCents': (cur.get('appliedCents') or 0) + amt},
               why='lines removed by the pre-2025 delete added back for restored invoices/bills')
# restored payments take their pay-to / method / paid date from the AP workbook too (items 2-4)
ledByPro = collections.defaultdict(list)
for x in LEDGER_ROWS: ledByPro[x['PRO']].append(x)
putRows = {(o['table'], o['id']): o for o in plan if o['kind'] == 'put' and o['section'] == 'A'}
billPro = {o['id']: o['row'].get('shipmentNumber') for (t, _), o in putRows.items() if t == 'CarrierBill'}
for (t, _), o in list(putRows.items()):
    if t != 'ApPayment': continue
    row = o['row']; pros = sorted({billPro.get(a.get('billId')) for a in row.get('applications') or []} - {None})
    lines = [x for pr in pros for x in ledByPro.get(pr, [])]
    if not lines: continue
    car = carById.get(row.get('carrierId')) or {}
    payees = {(alias[l['Pay to'].strip().upper()]['kind'], alias[l['Pay to'].strip().upper()]['canonical']) for l in lines}
    ms = {m for m, _ in (method_of(l, car.get('name') or l['Vendor']) for l in lines) if m}
    ds = {l['Paid date'] for l in lines if l['Paid date']}
    if len(payees) == 1:
        kind, canon = next(iter(payees)); row['payeeKind'] = kind
        if kind == 'FACTOR': row['remitTo'] = {'name': canon, 'factorName': canon}
    else: conflict('A', ' '.join(pros), f"restored payment {row['id']}: workbook pay-to differs between lines; left as carrier")
    if len(ms) == 1: row['method'] = next(iter(ms))
    if len(ds) == 1: row['paidAt'] = noon(next(iter(ds)))
    elif len(ds) > 1: conflict('A', ' '.join(pros), f"restored payment {row['id']}: several workbook paid dates {sorted(ds)}; Aljex date kept")
    for a in row.get('applications') or []:
        bo = putRows.get(('CarrierBill', a.get('billId')))
        if not bo: continue
        b = bo['row']
        if row.get('payeeKind'): b['payeeKind'] = row['payeeKind']
        if row.get('remitTo'): b['remitTo'] = row['remitTo']
        if b.get('status') == 'PAID': b['paidAt'] = row['paidAt']
        lo = putRows.get(('LoadCarrier', b.get('loadCarrierId')))
        if lo and lo['row'].get('apStatus') == 'PAID': lo['row']['apPaidAt'] = row['paidAt']
# the PROs the delete never had (Aljex ship dates mistyped, e.g. 1/14/20 on a 2025 load): built from the two Aljex reports
for p in build:
    r = byPro[p]; o = OLD.get(p, {})
    if p in claimed: conflict('A', p, 'PRO already claimed in prod; not built'); continue
    cid = uniq(cusByName.get(norm(r['Customer']), set()))
    if not cid: conflict('A', p, f"customer '{r['Customer']}' not matched to exactly one BCAT customer; not built"); continue
    cus = cusById[cid]
    inv_d = dt(r['Invoice Date']); del_d = dt(r['Del Date']) or inv_d; ship_d = dt(r['Ship Date'])
    if not ship_d or ship_d > del_d or ship_d < add_days(del_d, -60): ship_d = del_d   # mistyped Aljex ship date
    amt = cents(r['Invoice Amount']); paid = cents(r['Amount Paid']); paid_d = dt(r['Date Paid'])
    own = norm(r['Carrier']).startswith('IVANCARTAGE') or norm(r['Carrier']) == 'BCAT'
    ids = {k: f'{k}-aljex25-{p}' for k in ('shp', 'ord', 'lod', 'lcr')}
    oc, ost, dc, dst = o.get('Pickup City', ''), o.get('Pickup State', ''), o.get('Consignee City', ''), o.get('Consignee State', '')
    origin = f'{oc}, {ost}'.strip(', '); dest = f'{dc}, {dst}'.strip(', ')
    mode = 'FTL'
    eq = eq_for(r['Type'].strip())
    refs = [{'code': 'CUSTOMER_REF', 'label': 'Customer ref', 'level': 'ORDER', 'value': r['Customer Ref #'].strip(), 'visibility': 'ALL'}] if r['Customer Ref #'].strip() else []
    refs += [{'code': 'ALJEX_TYPE', 'label': 'Aljex shipment type', 'level': 'ORDER', 'value': r['Type'].strip(), 'visibility': 'INTERNAL'},
             {'code': 'ALJEX_SOURCE', 'label': 'Source', 'level': 'ORDER', 'value': 'Aljex AR/AP report 2026-11-14', 'visibility': 'INTERNAL'}]
    base = {'createdBy': ACTOR, 'updatedBy': ACTOR}
    aud = {'action': 'ALJEX_ARAP_2025_CREATE', 'why': 'invoiced in 2025, not in BCAT (Ryne 2026-11-14 item 1)'}
    stops = json.dumps([
        {'id': f'stp-{p}-0', 'type': 'pickup', 'locationId': None, 'address': {'city': oc, 'state': ost, 'zip': o.get('Pickup Zip', '')} if oc else None, 'appt': noon(ship_d), 'apptType': 'tbd', 'driverId': None, 'sequence': 0, 'name': o.get('Pickup Name') or 'Not recorded (Aljex report)', 'city': origin},
        {'id': f'stp-{p}-1', 'type': 'delivery', 'locationId': None, 'address': {'city': dc, 'state': dst, 'zip': o.get('Consignee Zip', '')} if dc else None, 'appt': noon(del_d), 'apptType': 'tbd', 'driverId': None, 'sequence': 1, 'name': o.get('Consignee Name') or 'Not recorded (Aljex report)', 'city': dest}])
    rep = repByCus.get(cid); rep = rep.most_common(1)[0][0] if rep else (None, None)
    put('A', p, 'ProClaim', {'id': p, 'claimedAt': '', 'claimedBy': ACTOR, 'origin': 'LEGACY', 'loadId': ids['lod'], 'shipmentId': ids['shp']}, aud)
    put('A', p, 'Shipment', {**base, 'id': ids['shp'], 'number': p, 'status': 'DELIVERED', 'source': 'BACKFILL', 'legacyImported': True, 'legacySource': 'ALJEX', 'importRunId': RUN,
        'customerId': cid, 'customerName': cus['name'], 'deliveredAt': noon(del_d), 'pickupAppt': noon(ship_d), 'pickupMonth': ship_d[:7], 'originCity': oc, 'destinationCity': dc,
        'mode': mode, 'revDivision': 'BROKERAGE', 'revRuleId': 'aljex-import', 'revTagSource': 'RULE', 'loadIds': [ids['lod']], 'orderIds': [ids['ord']],
        'searchKey': ' '.join(x for x in [p, cus['name'].lower(), oc.lower(), dc.lower(), r['Customer Ref #'].strip().lower()] if x),
        'statusChangedAt': noon(del_d), 'statusChangedBy': ACTOR, 'version': 1, **({'salesRepId': rep[0], 'salesRepCode': rep[1]} if rep[0] else {})}, aud)
    paidFull = paid >= amt and amt > 0
    put('A', p, 'Order', {**base, 'id': ids['ord'], 'shipmentId': ids['shp'], 'customerId': cid, 'customerName': cus['name'], 'mode': mode, **({'equipmentType': eq} if eq else {}),
        'customerRateCents': amt, 'revenueCents': amt, 'references': refs, 'arStatus': 'PAID' if paidFull else 'UNPAID', 'arStatusChangedAt': noon(paid_d if paidFull and paid_d else inv_d),
        'arBalanceCents': max(amt - paid, 0), 'invoiceId': p, 'invoiceNumber': p, 'invoicedAt': noon(inv_d), **({'paidAt': noon(paid_d)} if paidFull and paid_d else {}),
        'pickupAppt': noon(ship_d), 'version': 1}, aud)
    put('A', p, 'Load', {**base, 'id': ids['lod'], 'shipmentId': ids['shp'], 'orderId': ids['ord'], 'loadNumber': p, 'aljexId': p, 'pickupNumber': r['Customer Ref #'].strip() or p, 'tmsId': r['Customer Ref #'].strip() or p, 'leg': 1, 'status': 'DELIVERED',
        'statusSource': 'BACKFILL', 'statusChangedAt': noon(del_d), 'statusChangedBy': ACTOR, 'deliveredAt': noon(del_d), 'pickupAppt': noon(ship_d), 'deliveryAppt': noon(del_d),
        'pickupMonth': ship_d[:7], 'customer': cus['name'], 'customerId': cid, 'divisionKey': 'BCAT_LOGISTICS', 'revDivision': 'BROKERAGE', 'revRuleId': 'aljex-import',
        'revTagSource': 'RULE', 'legacyImported': True, 'legacySource': 'ALJEX', **({'equipmentType': eq} if eq else {}), 'originCity': origin, 'destinationCity': dest,
        'originName': o.get('Pickup Name') or None, 'destinationName': o.get('Consignee Name') or None, 'stops': stops, 'rate': amt, 'readyToInvoice': False,
        'pickupApptType': 'tbd', 'deliveryApptType': 'tbd', 'trackingProvider': 'NONE', 'assignmentType': 'OWN_ASSET' if own else 'CARRIER', 'activeLoadCarrierId': ids['lcr'],
        'carrierName': r['Carrier'].strip()}, aud)
    cc = f'chg-aljex25-{p}-c'
    put('A', p, 'LoadCharge', {'id': cc, 'side': 'CUSTOMER', 'code': 'LINEHAUL', 'label': 'Line haul', 'calculatedBy': 'FLAT', 'rateCents': amt, 'count': 1, 'amountCents': amt,
        'isRate': True, 'loadId': ids['lod'], 'orderId': ids['ord'], 'shipmentId': ids['shp'], 'sortOrder': 0, 'createdBy': ACTOR}, aud)
    terms = int(cus.get('paymentTermsDays') or 30)
    put('A', p, 'Invoice', {'id': p, 'number': p, 'orderId': ids['ord'], 'shipmentId': ids['shp'], 'shipmentNumber': p, 'customerId': cid, 'customerName': cus['name'],
        'billTo': {'name': cus['name'], 'address': cus.get('billingAddress')}, 'divisionKey': 'BCAT_LOGISTICS', 'status': 'PAID' if paidFull else ('PARTIAL' if paid else 'ISSUED'),
        'invoiceDate': inv_d, 'invoiceMonth': inv_d[:7], 'issuedAt': noon(inv_d), 'issuedBy': ACTOR, 'dueAt': add_days(inv_d, terms), 'termsDays': terms, 'termsText': f'Net {terms}',
        'lines': [{'amountCents': amt, 'calculatedBy': 'FLAT', 'chargeId': cc, 'code': 'LINEHAUL', 'count': 1, 'label': 'Line haul', 'loadId': ids['lod'], 'rateCents': amt}],
        'references': [x for x in refs if x['visibility'] == 'ALL'], 'subtotalCents': amt, 'totalCents': amt, 'paidCents': min(paid, amt), 'writtenOffCents': 0,
        'balanceCents': max(amt - paid, 0), **({'arOpen': 'OPEN'} if amt - paid > 0 else {}), **({'paidAt': noon(paid_d)} if paidFull and paid_d else {}),
        'factored': False, 'attachDocumentIds': [], 'sentCount': 0, 'markedSentAt': noon(inv_d), 'markedSentBy': ACTOR,
        'markedSentNote': 'Carried over from Aljex (AR/AP report 2026-11-14)', 'legacyImported': True, 'createdBy': ACTOR, 'updatedBy': ACTOR, 'version': 1}, aud)
    if paid:
        put('A', p, 'ArPayment', {'id': f'arp-aljex25-{p}', 'customerId': cid, 'kind': 'PAYMENT', 'receivedAt': noon(paid_d or inv_d), 'method': 'OTHER', 'reference': 'Aljex',
            'amountCents': min(paid, amt), 'appliedCents': min(paid, amt), 'unappliedCents': 0, 'applications': [{'invoiceId': p, 'amountCents': min(paid, amt)}],
            'note': 'Customer payment per Aljex AR/AP report', 'createdBy': ACTOR}, aud)
    cost = 0
    if own:
        put('A', p, 'LoadCarrier', {**base, 'id': ids['lcr'], 'loadId': ids['lod'], 'shipmentId': ids['shp'], 'kind': 'OWN_ASSET', 'status': 'ACTIVE', 'sequence': 1,
            'carrierName': r['Carrier'].strip(), 'carrierRateCents': 0, 'costCents': 0, 'bookedAt': noon(ship_d), 'rateConStatus': 'NOT_SENT'}, aud)
    else:
        car_id = carrier_by_name(r['Carrier'])
        if not car_id:
            dc = deletedCarByName.get(norm(r['Carrier'])) or {i for k, ids in deletedCarByName.items() if k.startswith(norm(r['Carrier'])) for i in ids}
            if len(dc) == 1 and restore_carrier(next(iter(dc)), p): car_id = next(iter(dc))
        car = carById.get(car_id) if car_id else None
        if not car: conflict('A', p, f"carrier '{r['Carrier']}' not matched; leg + bill not built")
        else:
            cost = cents(r['AP Projected']); apPaid = cents(r['AP Paid Non-Comm']); apd = dt(r['AP Paid Date'])
            led = [x for x in LEDGER_ROWS if x['PRO'] == p]
            if led and led[0]['Paid date']: apd = led[0]['Paid date']
            kc = f'chg-aljex25-{p}-k'; bid = f"cb:{ids['lcr']}:1"
            a0 = alias.get(led[0]['Pay to'].strip().upper()) if led else None
            factor = a0 and a0['kind'] == 'FACTOR'
            settled = apPaid >= cost and cost > 0
            put('A', p, 'LoadCharge', {'id': kc, 'side': 'CARRIER', 'code': 'LINEHAUL', 'label': 'Line haul', 'calculatedBy': 'FLAT', 'rateCents': cost, 'count': 1, 'amountCents': cost,
                'isRate': True, 'loadCarrierId': ids['lcr'], 'loadId': ids['lod'], 'shipmentId': ids['shp'], 'sortOrder': 101, 'createdBy': ACTOR}, aud)
            put('A', p, 'LoadCarrier', {**base, 'id': ids['lcr'], 'loadId': ids['lod'], 'shipmentId': ids['shp'], 'kind': 'CARRIER', 'status': 'ACTIVE', 'sequence': 1,
                'carrierId': car['id'], 'carrierName': car['name'], 'carrierMc': (str(car.get('mcNumber') or '')).replace('MC', '').strip() or None, 'carrierRateCents': cost,
                'costCents': cost, 'bookedAt': noon(ship_d), 'rateConStatus': 'NOT_SENT', 'apStatus': 'PAID' if settled else 'TO_BE_PAID', 'apBalanceCents': max(cost - apPaid, 0),
                **({'apPaidAt': noon(apd)} if settled and apd else {'apOpen': 'OPEN'}), 'invoiceId': bid, 'chargesFinalizedAt': noon(del_d)}, aud)
            put('A', p, 'CarrierBill', {'id': bid, 'loadCarrierId': ids['lcr'], 'loadId': ids['lod'], 'shipmentId': ids['shp'], 'shipmentNumber': p, 'loadNumber': p,
                'carrierId': car['id'], 'carrierName': car['name'], 'carrierMc': None, 'payeeKind': 'FACTOR' if factor else 'CARRIER',
                **({'remitTo': {'name': a0['canonical'], 'factorName': a0['canonical']}} if factor else {}), 'divisionKey': 'BCAT_LOGISTICS',
                'status': 'PAID' if settled else 'TO_BE_PAID', 'billNumber': p, 'billDate': dt(r['AP Aging Date']) or del_d, 'billMonth': (dt(r['AP Aging Date']) or del_d)[:7],
                'recordedAt': noon(del_d), 'recordedBy': ACTOR, 'dueAt': add_days(dt(r['AP Aging Date']) or del_d, 30), 'termsDays': 30,
                'lines': [{'amountCents': cost, 'calculatedBy': 'FLAT', 'chargeId': kc, 'code': 'LINEHAUL', 'count': 1, 'label': 'Line haul', 'rateCents': cost}],
                'grossCents': cost, 'quickPayFeeCents': 0, 'netCents': cost, 'billedCents': cost, 'varianceCents': 0, 'paidCents': min(apPaid, cost), 'creditedCents': 0,
                'balanceCents': max(cost - apPaid, 0), **({'apOpen': 'OPEN'} if cost - apPaid > 0 else {}), 'approvedAt': noon(del_d), 'approvedBy': ACTOR,
                'approvalWarnings': ['LEGACY_IMPORT'], **({'paidAt': noon(apd)} if settled and apd else {}), 'markedSentNote': 'Carried over from Aljex (AR/AP report 2026-11-14)',
                'createdBy': ACTOR, 'updatedBy': ACTOR, 'version': 1}, aud)
            if apPaid:
                m = method_of(led[0], car['name'])[0] if led else None
                put('A', p, 'ApPayment', {'id': f'app-aljex25-{p}', 'carrierId': car['id'], 'payeeKind': 'FACTOR' if factor else 'CARRIER',
                    **({'remitTo': {'name': a0['canonical'], 'factorName': a0['canonical']}} if factor else {}), 'kind': 'PAYMENT', 'paidAt': noon(apd or del_d),
                    'method': m or 'OTHER', 'reference': (led[0]['Check/ref'] if led else '') or 'Aljex', 'amountCents': min(apPaid, cost), 'appliedCents': min(apPaid, cost),
                    'unappliedCents': 0, 'applications': [{'billId': bid, 'amountCents': min(apPaid, cost)}], 'note': 'Carrier payment per Aljex / AP workbook', 'createdBy': ACTOR}, aud)
    put('A', p, 'LoadFinancials', {'id': ids['lod'], 'loadId': ids['lod'], 'orderId': ids['ord'], 'shipmentId': ids['shp'], 'revenueCents': amt, 'customerRateCents': amt,
        'costCents': cost, 'carrierRateCents': cost, 'profitCents': amt - cost, 'marginBps': round((amt - cost) * 10000 / amt) if amt else 0, 'updatedBy': ACTOR, 'version': 1}, aud)

# ── B (flag, item 7): the 16 loads invoiced in Aljex but not released in BCAT ─────────────────────────────────────────
SIXTEEN = ['13029', '13571', '13650', '13983', '14112', '14311', '14458', '14619', '14896', '14915', '14920', '14924', '14925', '14926', '14928', '14930']
for p in SIXTEEN:
    r = byPro.get(p); ss = [s for s in shipBy.get(p, []) if not s.get('voidedAt') and not s.get('deletedAt')]
    if not r or not ss: conflict('B', p, 'shipment or Aljex row missing'); continue
    o = (ordByShip.get(ss[0]['id']) or [{}])[0]
    grp = 'AUTO SHIPPER: stays in load review' if 'AUTO SHIPPER' in r['Customer'] else 'Ivan Cartage: not factored or invoiced anywhere; flows through load review normally'
    listing.append({'section': 'B', 'pro': p, 'what': f"{r['Customer']}: item 7 closed, no writes ({grp})"})
    if args.invoice_16 and not o.get('invoiceId'):
        invoke('B', p, 'RELEASE_TO_BILLING', {'shipmentId': ss[0]['id']}, why='past load review')
        invoke('B', p, 'GENERATE_INVOICE', {'orderId': o['id'], 'invoiceDate': dt(r['Invoice Date'])}, expect={'table': 'Order', 'id': o['id'], 'field': 'invoiceId'},
               why='invoice dated with the Aljex invoice date; never e-mailed')

# ── F (flag, item 6): loads with outside-carrier AP in Aljex but no carrier bill in BCAT ─────────────────────────────
# Ryne 2026-11-14: add the Aljex carrier as the leg and create the bill (paid / owed / expected as Aljex has it; pay-to,
# paid date and method from the AP workbook). A load BCAT has as own fleet switches to the outside carrier only when Aljex
# shows that carrier paid or billed (AP paid or aging > 0); projected-only own-fleet loads stay as they are.
def proj_lines(r):
    out = []
    for k in range(1, 8):
        v = (r[f'Proj XP {k} Vendor'] or '').rstrip(); a = cents(r[f'Proj XP {k} Amount'])
        if not v.strip() and not a: continue
        out.append((v[:4].strip(), re.sub(r'\s+-?[\d,]*\.\d\d$', '', v[5:]).strip(), a))
    return out
def act_lines(r):
    out = []
    for k in range(1, 8):
        v = (r[f'Act XP {k} Vendor'] or '').rstrip(); a = cents(r[f'Act XP {k} Amount'])
        if not v.strip() and not a: continue
        out.append((re.sub(r'\s+-?[\d,]*\.\d\d$', '', v).strip(), a))
    return out
own_v = lambda v: norm(v).startswith('IVANCARTAGE') or norm(v) == 'BCAT'
def same_vendor(a, b):
    a, b = norm(a), norm(b)
    return bool(a and b) and (a.startswith(b[:8]) or b.startswith(a[:8]) or (len(b) >= 6 and b in a) or (len(a) >= 6 and a in b))
CODE_LABEL = {'LINE': ('LINEHAUL', 'Line haul'), 'FUEL': ('FUEL', 'Fuel surcharge'), 'DETN': ('DETENTION', 'Detention'), 'CHAS': ('CHASSIS', 'Chassis'),
              'PRPL': ('PREPULL', 'Pre-pull'), 'STOR': ('STORAGE', 'Storage'), 'MISC': ('OTHER', 'Miscellaneous'), 'LHS': ('LINEHAUL', 'Line haul'),
              'PERM': ('OTHER', 'Permit'), 'MAC': ('OTHER', 'Accessorial')}
LOADS = {l['id']: l for l in live('Load')}
CHG = collections.defaultdict(list)
for c in live('LoadChargeCarrier'): CHG[c.get('loadCarrierId')].append(c)
fstats = collections.Counter()
for p, r in sorted(byPro.items(), key=lambda kv: int(kv[0])):
    ss = [x for x in shipBy.get(p, []) if not x.get('voidedAt') and not x.get('deletedAt')]
    if not ss: continue
    sh = ss[0]
    if [b for b in billsByShip[sh['id']] if b.get('status') != 'VOID']: continue
    P_ = [(c, v, a) for c, v, a in proj_lines(r) if v and not own_v(v)]; A_ = [(v, a) for v, a in act_lines(r) if v and not own_v(v)]
    if not P_ and not A_: continue
    if cents(r['AP Projected']) == 0 and cents(r['AP Paid Non-Comm']) == 0: continue
    apPaid, aging, expected = cents(r['AP Paid Non-Comm']), cents(r['AP Aging']), cents(r['AP Expected'])
    lcs = [l for l in lcByShip[sh['id']] if l.get('status') == 'ACTIVE']
    ownLeg = next((l for l in lcs if l.get('kind') == 'OWN_ASSET'), None); carLeg = next((l for l in lcs if l.get('kind') == 'CARRIER'), None)
    where = 'own-fleet' if ownLeg and not carLeg else ('carrier leg, no bill' if carLeg else 'no leg')
    def held(why):
        fstats[f'held: {why}'] += 1
        listing.append({'section': 'F', 'pro': p, 'what': f"{r['Customer']} ({where}): {why}"})
    if not args.missing_bills: held('item 6 off'); continue
    if ownLeg and not carLeg and apPaid <= 0 and aging <= 0:
        held('Aljex has only a projected cost; own-fleet leg kept, no bill'); continue
    # the primary vendor: the LINE line's vendor, else the largest; other real vendors are listed, not built
    lineV = next((v for c, v, a in P_ if c == 'LINE'), None) or max(P_ or [(None, A_[0][0], 0)], key=lambda t: t[2])[1]
    others = {v for _, v, _ in P_ if not same_vendor(v, lineV)} | {v for v, _ in A_ if not same_vendor(v, lineV)}
    if others: conflict('F', p, f'second vendor(s) {sorted(others)} besides {lineV}; only {lineV} is built')
    car_id = carrier_by_name(lineV) or next((carrier_by_name(v) for v, _ in A_ if same_vendor(v, lineV) and carrier_by_name(v)), None)
    if not car_id:
        dc = {i for k, ids in deletedCarByName.items() if k.startswith(norm(lineV)) for i in ids}
        if len(dc) == 1 and restore_carrier(next(iter(dc)), p): car_id = next(iter(dc))
    car = carById.get(car_id) if car_id and car_id != 'AMBIG' else None
    if not car: conflict('F', p, f"carrier '{lineV}' not matched to exactly one BCAT carrier; not built"); fstats['conflict: carrier not matched'] += 1; continue
    mine = [(c, v, a) for c, v, a in P_ if same_vendor(v, lineV)]
    cost = sum(a for _, _, a in mine) or cents(r['AP Projected'])
    paid = sum(a for v, a in A_ if same_vendor(v, lineV)) if A_ else 0
    if not others and apPaid and paid != apPaid: paid = apPaid
    if paid > cost: cost = paid   # Aljex paid more than projected (accessorials posted at pay time)
    led = [x for x in LEDGER_ROWS if x['PRO'] == p and x['BCAT match'] == 'shipment in BCAT, no carrier bill']
    ledPaid = sum(round(float(x['Amount']) * 100) for x in led)
    if led and ledPaid != paid: conflict('F', p, f'workbook paid ${ledPaid/100:,.2f} vs Aljex paid ${paid/100:,.2f}; Aljex amount used, workbook lines kept as notes')
    paidDate = max([x['Paid date'] for x in led if x['Paid date']] or [dt(r['AP Paid Date']) or ''])
    billDate = dt(r['AP Aging Date']) or (sh.get('deliveredAt') or noon(dt(r['Del Date']) or dt(r['Invoice Date'])))[:10]
    a0 = alias.get(led[0]['Pay to'].strip().upper()) if led else None
    factor = bool(a0 and a0['kind'] == 'FACTOR')
    if paid >= cost and cost > 0: status = 'PAID'
    elif paid > 0: status = 'PARTIAL'
    elif aging > 0: status = 'TO_BE_PAID'
    else: status = 'IN_REVIEW'
    aud = {'action': 'ALJEX_ARAP_2025_BILL', 'why': f'carrier bill from Aljex (Ryne 2026-11-14 item 6): {status.lower()}'}
    load = LOADS.get((sh.get('loadIds') or [None])[0])
    if not load: conflict('F', p, 'shipment has no load row'); continue
    # the leg: reuse the shipment's carrier leg when it is the same carrier, else a new leg (own fleet switched to the carrier)
    if carLeg:
        if carLeg.get('carrierId') != car['id'] and not same_vendor(carLeg.get('carrierName'), lineV):
            conflict('F', p, f"BCAT leg carrier {carLeg.get('carrierName')} ≠ Aljex {lineV}; not built"); fstats['conflict: leg carrier differs'] += 1; continue
        legId = carLeg['id']; newLeg = False
        have = [c for c in CHG.get(legId, [])]
        if have and sum(c.get('amountCents') or 0 for c in have) != cost:
            conflict('F', p, f"leg charges ${sum(c.get('amountCents') or 0 for c in have)/100:,.2f} ≠ Aljex ${cost/100:,.2f}; not built"); fstats['conflict: leg charges differ'] += 1; continue
        charges = have
    else:
        legId = f'lcr-aljex25-{p}'; newLeg = True; charges = []
    if not charges:
        for i, (c, v, a) in enumerate(mine or [('LINE', lineV, cost)]):
            code, label = CODE_LABEL.get(c, ('OTHER', c or 'Carrier charge'))
            ch = {'id': f'chg-aljex25-{p}-k{i}', 'side': 'CARRIER', 'code': code, 'label': label, 'calculatedBy': 'FLAT', 'rateCents': a, 'count': 1, 'amountCents': a,
                  'isRate': code == 'LINEHAUL', 'loadCarrierId': legId, 'loadId': load['id'], 'shipmentId': sh['id'], 'sortOrder': 101 + i, 'createdBy': ACTOR}
            charges.append(ch); put('F', p, 'LoadCharge', ch, aud)
        extra = cost - sum(c['amountCents'] for c in charges)
        if extra:
            ch = {'id': f'chg-aljex25-{p}-kx', 'side': 'CARRIER', 'code': 'OTHER', 'label': 'Paid in Aljex beyond the projected cost', 'calculatedBy': 'FLAT', 'rateCents': extra,
                  'count': 1, 'amountCents': extra, 'isRate': False, 'loadCarrierId': legId, 'loadId': load['id'], 'shipmentId': sh['id'], 'sortOrder': 120, 'createdBy': ACTOR}
            charges.append(ch); put('F', p, 'LoadCharge', ch, aud)
    billId = f'cb:{legId}:1'
    settled = status == 'PAID'
    legSet = {'carrierRateCents': cost, 'costCents': cost, 'apStatus': 'PAID' if settled else ('TO_BE_PAID' if status in ('TO_BE_PAID', 'PARTIAL') else 'IN_REVIEW'),
              'apBalanceCents': max(cost - paid, 0), 'apStatusChangedAt': noon(paidDate or billDate), 'invoiceId': billId, 'chargesFinalizedAt': noon(billDate),
              **({'apPaidAt': noon(paidDate)} if settled and paidDate else {'apOpen': 'OPEN'})}
    if newLeg:
        put('F', p, 'LoadCarrier', {'id': legId, 'loadId': load['id'], 'shipmentId': sh['id'], 'kind': 'CARRIER', 'status': 'ACTIVE',
            'sequence': max([l.get('sequence') or 0 for l in lcByShip[sh['id']]] or [0]) + 1, 'carrierId': car['id'], 'carrierName': car['name'],
            'carrierMc': (str(car.get('mcNumber') or '')).replace('MC', '').strip() or None, 'bookedAt': noon(billDate), 'rateConStatus': 'NOT_SENT',
            'createdBy': ACTOR, 'updatedBy': ACTOR, **legSet}, aud)
        if ownLeg:
            update('F', p, 'LoadCarrier', ownLeg, {'status': 'BOUNCED', 'updatedBy': ACTOR},
                   why=f'own-fleet leg replaced by {car["name"]}: Aljex shows the outside carrier {"paid" if apPaid else "billed"} (Ryne 2026-11-14 item 6)')
            fstats['own fleet switched to carrier'] += 1
        update('F', p, 'Load', load, {'activeLoadCarrierId': legId, 'assignmentType': 'CARRIER', 'carrierName': car['name'], 'updatedBy': ACTOR},
               why='active leg is the Aljex carrier (item 6)')
    else:
        update('F', p, 'LoadCarrier', carLeg, {**legSet, 'updatedBy': ACTOR}, why='bill created for this leg (item 6)')
    put('F', p, 'CarrierBill', {'id': billId, 'loadCarrierId': legId, 'loadId': load['id'], 'shipmentId': sh['id'], 'shipmentNumber': p, 'loadNumber': p,
        'carrierId': car['id'], 'carrierName': car['name'], 'carrierMc': None, 'payeeKind': 'FACTOR' if factor else 'CARRIER',
        **({'remitTo': {'name': a0['canonical'], 'factorName': a0['canonical']}} if factor else {}), 'divisionKey': load.get('divisionKey'),
        'status': status, **({'datesPending': True} if status == 'IN_REVIEW' else {}), 'billNumber': None, 'billDate': billDate, 'billMonth': billDate[:7],
        'recordedAt': noon(billDate), 'recordedBy': ACTOR, 'dueAt': add_days(billDate, 30), 'termsDays': 30,
        'lines': [{'amountCents': c['amountCents'], 'calculatedBy': c.get('calculatedBy') or 'FLAT', 'chargeId': c['id'], 'code': c['code'], 'count': c.get('count') or 1,
                   'label': c['label'], 'rateCents': c.get('rateCents') or c['amountCents']} for c in charges],
        'grossCents': cost, 'quickPayFeeCents': 0, 'netCents': cost, 'billedCents': cost, 'varianceCents': 0, 'paidCents': min(paid, cost), 'creditedCents': 0,
        'balanceCents': max(cost - paid, 0), **({'apOpen': 'OPEN'} if cost - paid > 0 else {}), **({'approvedAt': noon(billDate), 'approvedBy': ACTOR} if status != 'IN_REVIEW' else {}),
        'approvalWarnings': ['ALJEX_ARAP_2025'], **({'paidAt': noon(paidDate)} if settled and paidDate else {}),
        'note': f"From Aljex AR/AP report: projected ${cost/100:,.2f}, paid ${paid/100:,.2f}, open ${aging/100:,.2f}, expected ${expected/100:,.2f}.",
        'createdBy': ACTOR, 'updatedBy': ACTOR, 'version': 1}, aud)
    # payments: one per workbook line when they add up to what Aljex paid, else one from Aljex
    pays = [(x, round(float(x['Amount']) * 100)) for x in led] if led and ledPaid == paid else ([(None, paid)] if paid else [])
    for n, (x, amt) in enumerate(pays):
        a = alias.get(x['Pay to'].strip().upper()) if x else None
        fac = bool(a and a['kind'] == 'FACTOR')
        m = method_of(x, car['name'])[0] if x else ('CARD' if 'ECHO' in norm(car['name']) else None)
        put('F', p, 'ApPayment', {'id': f'app-aljex25-{p}-{n + 1}', 'carrierId': car['id'], 'payeeKind': 'FACTOR' if fac else 'CARRIER',
            **({'remitTo': {'name': a['canonical'], 'factorName': a['canonical']}} if fac else {}), 'kind': 'PAYMENT',
            'paidAt': noon((x['Paid date'] if x else None) or paidDate or billDate), 'method': m or 'OTHER', 'reference': (x['Check/ref'] if x else '') or 'Aljex',
            'amountCents': amt, 'appliedCents': amt, 'unappliedCents': 0, 'applications': [{'billId': billId, 'amountCents': amt}], 'remittanceCount': 0,
            'note': 'Carrier payment per ' + ('AP workbook ' + x['Tab'] if x else 'Aljex AP paid'), 'createdBy': ACTOR}, aud)
    fin = live_fin.get(load['id'])
    rev = (fin or {}).get('revenueCents') or 0
    fset = {'costCents': cost, 'carrierRateCents': cost, 'profitCents': rev - cost, 'marginBps': round((rev - cost) * 10000 / rev) if rev else 0, 'updatedBy': ACTOR}
    if fin: update('F', p, 'LoadFinancials', fin, fset, why='carrier cost from Aljex (item 6)')
    else: conflict('F', p, 'no LoadFinancials row; cost not rolled up')
    fstats[f'built: {status}' + (' (own fleet switched)' if ownLeg and not carLeg else '')] += 1
    listing.append({'section': 'F', 'pro': p, 'what': f"{r['Customer']} ({where}): {car['name']} ${cost/100:,.2f} {status}" + (f", paid ${paid/100:,.2f} {paidDate}" if paid else '') + (f", pay to {a0['canonical']}" if factor else '')})
stats.update({f'F {k}': v for k, v in fstats.items()})

# ── H: list only ───────────────────────────────────────────────────────────────────────────────────────────────────────
for x in LEDGER_ROWS:
    if x['BCAT match'] in ('BCAT bill(s) on PRO, amount not matched',):
        listing.append({'section': 'H', 'pro': x['PRO'], 'what': f"workbook payment ${float(x['Amount']):,.2f} to {x['Pay to']} on {x['Paid date']} matches no BCAT payment amount"})

json.dump({'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'actor': ACTOR, 'run': RUN, 'flags': {'missingBills': args.missing_bills, 'invoice16': args.invoice_16},
           'ops': plan, 'conflicts': conflicts, 'listing': listing, 'stats': dict(stats)}, open(args.out, 'w'), default=str)
c = collections.Counter((o['section'], o['kind'], o.get('table') or o.get('action')) for o in plan)
for k in sorted(c): print(k, c[k])
print('conflicts', len(conflicts), collections.Counter(x['section'] for x in conflicts))
print('restore', len(restore), 'build', len(build), build)
print('alias', collections.Counter(a['source'] for a in alias.values()))
