#!/usr/bin/env python3
"""AR/AP from Aljex, round 2 (Ryne 2026-11-14, invoices dated 2025-01-01 on). PLANNER for scripts/awArApAljex2025.mjs.

  python3 scripts/awArApAljex2025Split.py --live <dir of fresh scans> --out <plan.json> --review <review.csv>

Per PRO with a pay-to, payment or bill-amount difference against Aljex / the AP workbooks:
  M  several carriers on one bill → one leg + bill per Aljex vendor, each with its own pay-to and payments; the
     vendor's charges move to its leg; amounts reconcile to Aljex per vendor.
  S  one carrier: pay-to per workbook line (a payment shared with other loads is split, never repainted for all);
     bill lines and amount to Aljex (paid lines when Aljex paid more than projected); missing workbook payments added.
Anything that cannot be decided unambiguously is written to the review CSV, not to prod.
"""
import argparse, collections, csv, datetime, json, os, re, sys

ap = argparse.ArgumentParser()
ap.add_argument('--live', required=True); ap.add_argument('--out', required=True); ap.add_argument('--review', required=True)
args = ap.parse_args()
UP = '/Users/adminoid/.claude/uploads/26abbbe7-3e85-44fd-af28-98612b9ceb5b/'
REPORT = UP + 'cacc6636-https___bcal.aljex.com_ptmp_yudondc.csv'
LEDGER = os.path.expanduser('~/Downloads/aljex-ap-payment-ledger-2025-2026.csv')
ALIAS_CSV = os.path.expanduser('~/Downloads/aljex-payto-alias-map.csv')
AUDIT = os.path.expanduser('~/Downloads/aljex-ap-ar-audit-after-import-2026-11-14.csv')
PREV_PLAN = args.out.replace('plan-split', 'plan-final')
ACTOR = 'aljex-arap-2025'

def de(v):
    (t, x), = v.items()
    if t == 'S': return x
    if t == 'N': return int(x) if re.fullmatch(r'-?\d+', x) else float(x)
    if t == 'BOOL': return x
    if t == 'NULL': return None
    if t == 'M': return {k: de(w) for k, w in x.items()}
    if t == 'L': return [de(w) for w in x]
    return x
def live(t): return [{k: de(v) for k, v in i.items()} for i in json.load(open(os.path.join(args.live, t + '.json')))['Items']]
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
norm = lambda s: re.sub(r'[^A-Z0-9]', '', str(s or '').upper())
def same(a, b):
    a, b = norm(a), norm(b)
    return bool(a and b) and (a.startswith(b[:8]) or b.startswith(a[:8]) or (len(b) >= 6 and b in a) or (len(a) >= 6 and a in b))
own_v = lambda v: norm(v).startswith('IVANCARTAGE') or norm(v) == 'BCAT'
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

# ── state ──
S = {str(s['number']): s for s in live('Shipment') if not s.get('voidedAt') and not s.get('deletedAt')}
LCs = collections.defaultdict(list); lcById = {}
for l in live('LoadCarrier'): LCs[l['shipmentId']].append(l); lcById[l['id']] = l
Bs = collections.defaultdict(list); billById = {}
for b in live('CarrierBill'):
    billById[b['id']] = b
    if b.get('status') != 'VOID': Bs[b['shipmentId']].append(b)
APP = live('ApPayment'); appById = {p['id']: p for p in APP}
WORK = {}
def W(p):
    if p['id'] not in WORK: WORK[p['id']] = {'applications': list(p.get('applications') or []), 'amountCents': p['amountCents'], 'appliedCents': p['appliedCents']}
    return WORK[p['id']]
appsByBill = collections.defaultdict(list)
for p in APP:
    if p.get('kind') != 'PAYMENT' or p.get('reversedByPaymentId'): continue
    for a in p.get('applications') or []: appsByBill[a.get('billId')].append(p)
CH = collections.defaultdict(list)
for ch in live('LoadChargeCarrier'): CH[ch.get('loadCarrierId')].append(ch)
CAR = live('Carrier'); carById = {c['id']: c for c in CAR}
carByName = collections.defaultdict(set)
for c in CAR:
    for n in (c.get('name'), c.get('dbaName')):
        if n: carByName[norm(n)].add(c['id'])
def carrier_for(v):
    n = norm(v)
    if not n: return None
    hit = {i for k, ids in carByName.items() if k == n or k.startswith(n) or (len(n) >= 10 and n.startswith(k[:10]) and len(k) >= 10) for i in ids}
    hit = {i for i in hit if not carById[i].get('mergedIntoId')}
    if len(hit) == 1: return next(iter(hit))
    if hit: return None
    # a carrier the 11-09 clean-up deleted (no loads then): restore it INACTIVE from that backup, as round 1 did
    dz = [c for c in DELETED if norm(c.get('name')).startswith(n) or (len(n) >= 10 and norm(c.get('name')).startswith(n[:10]))]
    if len(dz) != 1: return None
    c = dz[0]
    if c['id'] not in carById:
        carById[c['id']] = c
        RESTORE.append(c)
    return c['id']
DELETED = [json.loads(l) for l in open(os.path.expanduser('~/bcat-ops-backups/pre-delete-carriers/20261109T144139/carriers.jsonl'))]
RESTORE = []
FIN = {f['id']: f for f in live('LoadFinancials')}
REP = {}
for x in csv.DictReader(open(REPORT, encoding='utf-8', errors='replace')):
    if x['Invoice Date'].strip() and (dt(x['Invoice Date']) or '') >= '2025-01-01' and x['Type'].strip() not in ('CRED', 'DEBT'): REP.setdefault(x['Pro #'].strip(), x)
LED = collections.defaultdict(list)
for x in csv.DictReader(open(LEDGER)):
    if x['Scope'] == '2025+ invoice': LED[x['PRO']].append(x)
ALIAS = {}
for x in csv.DictReader(open(ALIAS_CSV)):
    raw = x['Pay to as written in AP workbook']; raw = '' if raw == '(blank)' else raw
    ALIAS[raw.upper()] = ('FACTOR' if x['Treated as'] == 'Factor' else 'CARRIER', x['Pay-to name BCAT will show'] if x['Treated as'] == 'Factor' else '')
def payee(line):
    k, n = ALIAS.get(line['Pay to'].strip().upper(), ('CARRIER', ''))
    return k, n
def method_of(line, carrier_name):
    if 'ECHO' in norm(line['Vendor']) or 'ECHO' in norm(carrier_name): return 'CARD'
    m = (line['Pay mode'] + ' ' + line['Pay type']).upper()
    if 'AMEX' in m or 'CREDIT CARD' in m or re.search(r'\bCC\b', m): return 'CARD'
    if 'ZELLE' in m or line['Pay to'].strip().upper() == 'ZELLE': return 'ZELLE'
    if 'CHECK' in line['Pay type'].upper(): return 'CHECK'
    if 'ACH' in m or 'DRAFT' in m or 'QUICK PAY' in m: return 'ACH'
    return 'OTHER'

# the PROs in scope: the audit's pay-to / total-paid / bill-amount / missing-payment gaps + the first run's held pay-to conflicts
AUD = {x['PRO']: x for x in csv.DictReader(open(AUDIT))}
LABS = ['AP pay-to: factor in ledger, BCAT bill says carrier direct', 'AP ledger: total paid differs from BCAT', 'AP: bill amount differs', 'AP ledger: payment amount not in BCAT']
scope = {p for p, x in AUD.items() if any(l in x['Gaps'] for l in LABS)}
prev = json.load(open(PREV_PLAN))
for cf in prev['conflicts']:
    if cf['section'] == 'D': scope |= set(cf['pro'].split())
scope = {p for p in scope if p in REP and p in S}

plan, review = [], []
rows = {}   # (table, id) -> current row for updates merged per row
sets = collections.OrderedDict()
def put(sec, pro, table, row, why):
    plan.append({'section': sec, 'pro': pro, 'kind': 'put', 'table': table, 'id': row['id'], 'row': row, 'audit': {'action': 'ALJEX_ARAP_2025_SPLIT', 'why': why}})
def upd(sec, pro, table, row, set_, why, remove=()):
    k = (table, row['id'])
    if k in sets:
        o = sets[k]; o['set'].update(set_); o['remove'] = sorted(set(o['remove']) | set(remove)); o['audit']['why'] += '; ' + why
        for f in set_: o['before'].setdefault(f, row.get(f))
        return
    o = {'section': sec, 'pro': pro, 'kind': 'update', 'table': table, 'id': row['id'], 'expectUpdatedAt': row.get('updatedAt'), 'set': dict(set_), 'remove': list(remove),
         'before': {f: row.get(f) for f in list(set_) + list(remove)}, 'audit': {'action': 'ALJEX_ARAP_2025_SPLIT', 'why': why}}
    sets[k] = o; plan.append(o)
def rv(pro, kind, what, decision=''): review.append({'PRO': pro, 'Kind': kind, "What's going on": what, 'Decision needed': decision})
m = lambda v: f'${(v or 0) / 100:,.2f}'

def vendors(r):
    g = []
    for code, v, a in proj_lines(r):
        if own_v(v): continue
        for x in g:
            if same(x['v'], v): x['proj'].append((code, a)); break
        else: g.append({'v': v, 'proj': [(code, a)], 'act': []})
    for v, a in act_lines(r):
        if own_v(v): continue
        for x in g:
            if same(x['v'], v): x['act'].append(a); break
        else: g.append({'v': v, 'proj': [], 'act': [a]})
    for x in g:
        x['projT'] = sum(a for _, a in x['proj']); x['paid'] = sum(x['act']); x['target'] = max(x['projT'], x['paid'])
        x['led'] = []
    return g

def match_lines(want, have):
    """Pick bill lines (chargeId, amount) whose amounts are exactly the wanted amounts; None if not unambiguous."""
    pool = list(have); got = []
    for a in want:
        if a == 0: continue
        hit = [l for l in pool if l['amountCents'] == a]
        if not hit: return None
        got.append(hit[0]); pool.remove(hit[0])
    return got

stats = collections.Counter()
for pro in sorted(scope, key=int):
    r = REP[pro]; sh = S[pro]
    bills = Bs.get(sh['id'], [])
    G = vendors(r)
    led = LED.get(pro, [])
    for l in led:
        g = next((x for x in G if same(x['v'], l['Vendor'])), None) if l['Vendor'].strip() else next((x for x in G if round(float(l['Amount']) * 100) in (x['paid'], *x['act'])), None)
        if g: g['led'].append(l)
        else:
            stats['review: workbook vendor not in Aljex lines'] += 1
    if len(bills) != 1:
        rv(pro, 'shape', f'{len(bills)} live carrier bills on the load', 'Which bill each Aljex vendor belongs to'); stats['review: not one bill'] += 1; continue
    b = bills[0]; leg = lcById.get(b['loadCarrierId'])
    if not leg: rv(pro, 'shape', 'bill has no leg row'); continue
    if any(0 < x['paid'] < x['projT'] for x in G):
        rv(pro, 'short paid', '; '.join(f"{x['v']}: projected {m(x['projT'])}, Aljex paid {m(x['paid'])}" for x in G if 0 < x['paid'] < x['projT'])
           + f"; BCAT bill {m(b.get('netCents'))} paid {m(b.get('paidCents'))} ({b['status']})", 'Close at the Aljex paid amount, or keep the projected amount open'); stats['review: short paid'] += 1; continue
    prim = next((x for x in G if same(x['v'], b.get('carrierName'))), None)
    if prim:
        for x in [x for x in G if x is not prim and norm(x['v']).startswith('DEMURRAGE')]:
            # a charge description in Aljex's vendor column, not a carrier: it stays on the primary carrier's bill
            prim['proj'] += x['proj']; prim['act'] += x['act']; prim['led'] += x['led']
            prim['projT'] += x['projT']; prim['paid'] += x['paid']; prim['target'] += x['target']; G.remove(x)
    if not prim:
        rv(pro, 'carrier', f"BCAT bill carrier {b.get('carrierName')} is not one of Aljex's vendors ({', '.join(x['v'] for x in G)})", 'Which carrier is right'); stats['review: bill carrier not in Aljex'] += 1; continue
    others = [x for x in G if x is not prim and x['target']]
    lines = [{'chargeId': l.get('chargeId'), 'amountCents': l.get('amountCents'), 'code': l.get('code'), 'label': l.get('label'), 'line': l} for l in (b.get('lines') or [])]
    chargeById = {c['id']: c for c in CH.get(leg['id'], [])}
    pays = appsByBill.get(b['id'], [])
    appl = [(p, next(a for a in p['applications'] if a['billId'] == b['id'])) for p in pays]
    # ── M: one leg + bill per extra vendor ──
    newBills = {}
    ok = True; moved = set()
    for x in others:
        cid = carrier_for(x['v']) or next((carrier_for(l['Vendor']) for l in x['led'] if carrier_for(l['Vendor'])), None)
        if not cid:
            rv(pro, 'multi-carrier', f"Aljex vendor {x['v']} ({m(x['target'])}) matches no single BCAT carrier", 'Which carrier record it is'); ok = False; stats['review: vendor carrier not matched'] += 1; break
        want = [a for _, a in x['proj'] if a] if x['projT'] >= x['paid'] else x['act']
        got = match_lines(want, [l for l in lines if l['chargeId'] not in moved])
        if got is None:
            rv(pro, 'multi-carrier', f"{x['v']}: Aljex lines {[a/100 for a in want]} are not separate lines on the BCAT bill", 'Split the charges by hand'); ok = False; stats['review: lines not separable'] += 1; break
        moved |= {l['chargeId'] for l in got}
        # payments for this vendor: BCAT applications equal to the vendor's paid total, or to its workbook lines
        targets = [round(float(l['Amount']) * 100) for l in x['led']] if x['led'] and sum(round(float(l['Amount']) * 100) for l in x['led']) == x['paid'] else ([x['paid']] if x['paid'] else [])
        picks = []
        avail = [pa for pa in appl if id(pa) not in {id(q) for q in picks}]
        for t in targets:
            hit = [pa for pa in appl if pa[1]['amountCents'] == t and all(pa is not q for q in picks) and all(pa is not q for nb in newBills.values() for q in nb['picks'])]
            if not hit: picks = None; break
            picks.append(hit[0])
        if picks is None:
            rv(pro, 'multi-carrier', f"{x['v']}: no BCAT payment of exactly {[m(t) for t in targets]} to move to its bill", 'How the payment splits between carriers'); ok = False; stats['review: payment not separable'] += 1; break
        newBills[x['v']] = {'x': x, 'carrierId': cid, 'lines': got, 'picks': picks}
    if not ok: continue
    primLines = [l for l in lines if l['chargeId'] not in moved]
    primTotal = sum(l['amountCents'] for l in primLines)
    # ── S part (and the primary vendor of M): amounts to Aljex ──
    add_lines = []
    if prim['paid'] > prim['projT'] and primTotal != prim['target']:
        # Aljex paid lines the projection never had: add the paid lines the bill is missing
        pool = [l['amountCents'] for l in primLines]; extra = []
        for a in prim['act']:
            if a in pool: pool.remove(a)
            else: extra.append(a)
        if primTotal + sum(extra) == prim['target']: add_lines = extra
    if primTotal + sum(add_lines) != prim['target']:
        rv(pro, 'bill amount', f"{prim['v']}: BCAT lines {m(primTotal)} vs Aljex {m(prim['target'])} (projected {m(prim['projT'])}, paid {m(prim['paid'])})", 'Which amount and lines are right'); stats['review: amount not reconcilable'] += 1; continue
    movedApps = {id(pa) for nb in newBills.values() for pa in nb['picks']}
    primApps = [pa for pa in appl if id(pa) not in movedApps]
    primApplied = sum(a['amountCents'] for _, a in primApps)
    newPay = []
    if prim['paid'] > primApplied:
        missing = prim['paid'] - primApplied
        cand = [l for l in prim['led'] if round(float(l['Amount']) * 100) == missing] or ([prim['led'][0]] if len(prim['led']) == 1 and round(float(prim['led'][0]['Amount']) * 100) >= missing else [])
        if not cand:
            rv(pro, 'payment', f"{prim['v']}: Aljex paid {m(prim['paid'])}, BCAT applied {m(primApplied)}; no workbook line of {m(missing)}", 'Add the missing payment, and with which date and pay-to'); stats['review: missing payment unmatched'] += 1; continue
        newPay.append((cand[0], missing))
    elif primApplied > prim['paid'] and prim['paid'] > 0:
        rv(pro, 'payment', f"{prim['v']}: BCAT applied {m(primApplied)} but Aljex paid {m(prim['paid'])}", 'Reverse the extra?'); stats['review: BCAT paid more'] += 1; continue

    # ── writes ──
    why = 'Aljex / AP workbook per vendor (Ryne 2026-11-14)'
    load = {'id': b['loadId']}
    seq = max([l.get('sequence') or 0 for l in LCs[sh['id']]] or [1])
    for v, nb in newBills.items():
        x = nb['x']; car = carById[nb['carrierId']]; seq += 1
        legId = f'lcr-aljex25s-{pro}-{seq}'; billId = f'cb:{legId}:1'
        tot = sum(l['amountCents'] for l in nb['lines']); paid = sum(pa[1]['amountCents'] for pa in nb['picks'])
        led_for = list(x['led']) or [None] * len(nb['picks'])
        lastPaid = max([((l['Paid date'] if l and l['Paid date'] else None) or (pa[0].get('paidAt') or '')[:10]) for pa, l in zip(nb['picks'], led_for)] or [''])
        ldl = x['led'][0] if x['led'] else None
        kind, fname = payee(ldl) if ldl else ('CARRIER', '')
        settled = paid >= tot
        put('M', pro, 'LoadCarrier', {'id': legId, 'loadId': b['loadId'], 'shipmentId': sh['id'], 'kind': 'CARRIER', 'status': 'ACTIVE', 'sequence': seq, 'carrierId': car['id'],
            'carrierName': car['name'], 'carrierMc': str(car.get('mcNumber') or '').replace('MC', '').strip() or None, 'carrierRateCents': tot, 'costCents': tot,
            'bookedAt': leg.get('bookedAt') or noon(b['billDate']), 'rateConStatus': 'NOT_SENT', 'apStatus': 'PAID' if settled else 'TO_BE_PAID', 'apBalanceCents': max(tot - paid, 0),
            'apStatusChangedAt': noon(lastPaid or b['billDate']), 'invoiceId': billId, 'chargesFinalizedAt': leg.get('chargesFinalizedAt') or noon(b['billDate']),
            **({'apPaidAt': noon(lastPaid)} if settled and lastPaid else {'apOpen': 'OPEN'}), 'createdBy': ACTOR, 'updatedBy': ACTOR}, f'{v} on its own leg: ' + why)
        for l in nb['lines']:
            ch = chargeById.get(l['chargeId'])
            if ch: upd('M', pro, 'LoadCharge', ch, {'loadCarrierId': legId, 'updatedBy': ACTOR}, f'charge moves to the {car["name"]} leg')
        put('M', pro, 'CarrierBill', {**{k: b.get(k) for k in ('loadId', 'shipmentId', 'shipmentNumber', 'loadNumber', 'divisionKey', 'billDate', 'billMonth', 'dueAt', 'termsDays', 'recordedAt', 'recordedBy', 'approvedAt', 'approvedBy')},
            'id': billId, 'loadCarrierId': legId, 'carrierId': car['id'], 'carrierName': car['name'], 'carrierMc': None, 'payeeKind': kind,
            **({'remitTo': {'name': fname, 'factorName': fname}} if kind == 'FACTOR' else {}), 'status': 'PAID' if settled else ('PARTIAL' if paid else 'TO_BE_PAID'),
            'billNumber': None, 'lines': [l['line'] for l in nb['lines']], 'grossCents': tot, 'quickPayFeeCents': 0, 'netCents': tot, 'billedCents': tot, 'varianceCents': 0,
            'paidCents': min(paid, tot), 'creditedCents': 0, 'balanceCents': max(tot - paid, 0), **({'apOpen': 'OPEN'} if tot > paid else {}),
            **({'paidAt': noon(lastPaid)} if settled and lastPaid else {}), 'approvalWarnings': ['ALJEX_ARAP_2025'],
            'note': f'Split from bill {b["id"]}: Aljex shows {car["name"]} as its own carrier on this load.', 'createdBy': ACTOR, 'updatedBy': ACTOR, 'version': 1},
            f'{v} gets its own bill: ' + why)
        for (p, a), ldl in zip(nb['picks'], x['led'] or [None] * len(nb['picks'])):
            k2, n2 = payee(ldl) if ldl else ('CARRIER', '')
            meta = {'payeeKind': k2, **({'remitTo': {'name': n2, 'factorName': n2}} if k2 == 'FACTOR' else {}), **({'method': method_of(ldl, car['name'])} if ldl else {}),
                    **({'paidAt': noon(ldl['Paid date'])} if ldl and ldl['Paid date'] else {})}
            if len(W(p)['applications']) == 1:
                upd('M', pro, 'ApPayment', p, {'carrierId': car['id'], 'applications': [{**a, 'billId': billId}], **meta}, f'payment belongs to {car["name"]}', remove=['remitTo'] if k2 == 'CARRIER' else [])
            else:
                w = W(p); rest = [q for q in w['applications'] if not (q['billId'] == a['billId'] and q['amountCents'] == a['amountCents'])]
                w.update(applications=rest, amountCents=w['amountCents'] - a['amountCents'], appliedCents=w['appliedCents'] - a['amountCents'])
                upd('M', pro, 'ApPayment', p, {'applications': rest, 'amountCents': w['amountCents'], 'appliedCents': w['appliedCents']},
                    f'{m(a["amountCents"])} for PRO {pro} moves to its own payment to {car["name"]}')
                put('M', pro, 'ApPayment', {'id': f'app-aljex25s-{pro}-{car["id"][-6:]}', 'carrierId': car['id'], 'kind': 'PAYMENT', 'paidAt': meta.get('paidAt') or p['paidAt'],
                    'method': meta.get('method') or p.get('method') or 'OTHER', 'reference': p.get('reference'), 'amountCents': a['amountCents'], 'appliedCents': a['amountCents'],
                    'unappliedCents': 0, 'applications': [{**a, 'billId': billId}], 'remittanceCount': 0, 'payeeKind': k2,
                    **({'remitTo': {'name': n2, 'factorName': n2}} if k2 == 'FACTOR' else {}), 'note': f'Split from payment {p["id"]} (Aljex check run)', 'createdBy': ACTOR},
                    f'{car["name"]} payment split out of {p["id"]}')
        stats['M carriers split out'] += 1
    # primary bill: what is left + added paid lines + new payments; pay-to per its workbook line
    newLines = [l['line'] for l in primLines]
    for i, a in enumerate(add_lines):
        cid = f'chg-aljex25s-{pro}-{i}'
        put('S', pro, 'LoadCharge', {'id': cid, 'side': 'CARRIER', 'code': 'OTHER', 'label': 'Paid in Aljex beyond the projected cost', 'calculatedBy': 'FLAT', 'rateCents': a, 'count': 1,
            'amountCents': a, 'isRate': False, 'loadCarrierId': leg['id'], 'loadId': b['loadId'], 'shipmentId': sh['id'], 'sortOrder': 130 + i, 'createdBy': ACTOR}, 'Aljex paid line missing on the bill')
        newLines.append({'amountCents': a, 'calculatedBy': 'FLAT', 'chargeId': cid, 'code': 'OTHER', 'count': 1, 'label': 'Paid in Aljex beyond the projected cost', 'rateCents': a})
    total = prim['target']
    paidNow = primApplied + sum(x for _, x in newPay)
    lastDates = [(p.get('paidAt') or '')[:10] for p, _ in primApps] + [l['Paid date'] for l, _ in newPay]
    pl = prim['led'][0] if prim['led'] else None
    pk, pn = payee(pl) if pl else (b.get('payeeKind') or 'CARRIER', ((b.get('remitTo') or {}).get('name') or ''))
    bset = {}
    if newBills or add_lines: bset.update({'lines': newLines, 'grossCents': total, 'netCents': total, 'billedCents': total, 'varianceCents': 0})
    if newBills or add_lines or newPay:
        bset.update({'paidCents': min(paidNow, total), 'balanceCents': max(total - paidNow - (b.get('creditedCents') or 0), 0),
                     'status': 'PAID' if paidNow + (b.get('creditedCents') or 0) >= total else ('PARTIAL' if paidNow else b['status']), 'version': (b.get('version') or 1) + 1})
        if bset['status'] == 'PAID' and max(lastDates or ['']): bset['paidAt'] = noon(max(lastDates))
    if pl and (pk != b.get('payeeKind') or (pk == 'FACTOR' and (b.get('remitTo') or {}).get('name') != pn)):
        bset['payeeKind'] = pk
        if pk == 'FACTOR': bset['remitTo'] = {**(b.get('remitTo') or {}), 'name': pn, 'factorName': pn}
    if bset: upd('S', pro, 'CarrierBill', b, {**bset, 'updatedBy': ACTOR}, why, remove=['apOpen'] if bset.get('status') == 'PAID' else [])
    if newBills or add_lines:
        upd('S', pro, 'LoadCarrier', leg, {'costCents': total, 'carrierRateCents': total, 'apBalanceCents': bset.get('balanceCents', b.get('balanceCents')), 'updatedBy': ACTOR}, why)
        if add_lines:
            fin = FIN.get(b['loadId'])
            if fin:
                cost = sum((nb_['x']['target']) for nb_ in newBills.values()) + total
                rev = fin.get('revenueCents') or 0
                upd('S', pro, 'LoadFinancials', fin, {'costCents': cost, 'carrierRateCents': cost, 'profitCents': rev - cost, 'marginBps': round((rev - cost) * 10000 / rev) if rev else 0, 'updatedBy': ACTOR}, why)
    # pay-to per workbook line on the primary's own payments (split a shared payment instead of repainting it)
    for p, a in primApps:
        ln = next((l for l in prim['led'] if round(float(l['Amount']) * 100) == a['amountCents']), None) or (prim['led'][0] if len(prim['led']) == 1 else None)
        if not ln: continue
        k2, n2 = payee(ln)
        if k2 == p.get('payeeKind') and (k2 == 'CARRIER' or (p.get('remitTo') or {}).get('name') == n2): continue
        w = W(p); others_on_p = [q for q in w['applications'] if q['billId'] != b['id']]
        if not others_on_p:
            upd('S', pro, 'ApPayment', p, {'payeeKind': k2, **({'remitTo': {'name': n2, 'factorName': n2}} if k2 == 'FACTOR' else {})}, 'pay-to per the AP workbook', remove=['remitTo'] if k2 == 'CARRIER' else [])
        else:
            w.update(applications=others_on_p, amountCents=w['amountCents'] - a['amountCents'], appliedCents=w['appliedCents'] - a['amountCents'])
            upd('S', pro, 'ApPayment', p, {'applications': others_on_p, 'amountCents': w['amountCents'], 'appliedCents': w['appliedCents']},
                f'{m(a["amountCents"])} for PRO {pro} was paid to {n2 or "the carrier"}: moved to its own payment')
            put('S', pro, 'ApPayment', {'id': f'app-aljex25s-{pro}-p{p["id"][-6:]}', 'carrierId': p['carrierId'], 'kind': 'PAYMENT', 'paidAt': noon(ln['Paid date']) if ln['Paid date'] else p['paidAt'],
                'method': method_of(ln, b.get('carrierName')), 'reference': p.get('reference'), 'amountCents': a['amountCents'], 'appliedCents': a['amountCents'], 'unappliedCents': 0,
                'applications': [a], 'remittanceCount': 0, 'payeeKind': k2, **({'remitTo': {'name': n2, 'factorName': n2}} if k2 == 'FACTOR' else {}),
                'note': f'Split from payment {p["id"]}: the AP workbook shows a different pay-to for this load', 'createdBy': ACTOR}, 'shared payment split by pay-to')
        stats['S pay-to fixed'] += 1
    for ln, amt in newPay:
        k2, n2 = payee(ln)
        put('S', pro, 'ApPayment', {'id': f'app-aljex25s-{pro}-add', 'carrierId': b['carrierId'], 'kind': 'PAYMENT', 'paidAt': noon(ln['Paid date'] or b['billDate']),
            'method': method_of(ln, b.get('carrierName')), 'reference': ln['Check/ref'] or 'AP workbook', 'amountCents': amt, 'appliedCents': amt, 'unappliedCents': 0,
            'applications': [{'billId': b['id'], 'amountCents': amt}], 'remittanceCount': 0, 'payeeKind': k2, **({'remitTo': {'name': n2, 'factorName': n2}} if k2 == 'FACTOR' else {}),
            'note': f'AP workbook payment missing in BCAT ({ln["Tab"]})', 'createdBy': ACTOR}, 'missing workbook payment')
        stats['S payment added'] += 1
    if add_lines: stats['S bill amount corrected'] += 1
    stats['PROs written'] += 1

for c in RESTORE:
    plan.insert(0, {'section': 'M', 'pro': None, 'kind': 'put', 'table': 'Carrier', 'id': c['id'], 'row': {**c, 'status': 'INACTIVE', 'updatedBy': ACTOR},
                    'audit': {'action': 'ALJEX_ARAP_2025_RESTORE', 'why': 'carrier of a split-out leg; restored INACTIVE from the 11-09 carrier-delete backup'}})
json.dump({'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'actor': ACTOR, 'ops': plan, 'conflicts': [], 'listing': [], 'stats': dict(stats)}, open(args.out, 'w'), default=str)
with open(args.review, 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=['PRO', 'Kind', "What's going on", 'Decision needed']); w.writeheader(); w.writerows(review)
print('scope', len(scope)); print(json.dumps(dict(stats), indent=0))
print(collections.Counter((o['kind'], o['table']) for o in plan))
