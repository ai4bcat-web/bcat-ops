# Dev e-mail live test

## Investigation (2026-11-04, read-only AWS)

**Root cause.** Dev e-mail never reached SES. `backend.ts` (dev guard) attached an explicit IAM `Deny ses:*` on `*` to every Lambda role; an explicit deny beats the `Allow ses:SendEmail/SendRawEmail` the e-mail Lambdas also have. Confirmed on the deployed `tmsShipmentActions` role. The rate con and invoice code then recorded `NOT_SENT` with the MIME in CloudWatch, exactly as designed. Nothing was wrong on the SES side.

**SES account (us-east-1, shared with production):** sending enabled, **production access ON** (not sandbox), 50,000/24h, 14/s. Identities: `bcatcorp.com` (verified domain), `ai4bcat@gmail.com` (verified), `Ryne@bcatcorp.com` (verified), `noreply@bcatcorp.com` (FAILED, not used by dev). Dev's `tmsShipmentActions`, `tmsFinanceActions` and `tmsTrackingActions` use `FROM_ADDRESS=ai4bcat@gmail.com`, a verified identity in the same region, so no from-address change is needed and no identity was created or changed.

**Fix (repo, needs a dev deploy):** the dev deny is now conditional: `Deny ses:*` when ANY recipient (`ses:Recipients`, To/Cc/Bcc) is not `ai4bcat@gmail.com` or `ai4bcat+*@gmail.com` (`ForAnyValue:StringNotLike`). Proven with `aws iam simulate-custom-policy`: `[mailbox, mailbox+tracking]` -> allowed; `[mailbox, other]` -> explicitDeny; `[other]` -> explicitDeny. Code: `amplify/devRuleGuard.ts` (`devSesDeny`), `amplify/backend.ts`, tests in `amplify/devRuleGuard.test.ts`.

Also: `SEND_RATE_CON` now stores the SES MessageId on the `ShipmentMessage` row (`providerRef`); before it was dropped.

## Reply threading
SES overwrites the `Message-ID` header on every send. Implemented (repo, needs deploy):
- `SEND_RATE_CON` stores SES's id in `providerRef` and sets the row's `messageId` to the wire form `<SESMessageId@email.amazonses.com>`, so the `shipmentMessagesByMessageId` index resolves a reply's `In-Reply-To` / `References`.
- The rate-con subject carries a stable `[ref <shipmentId>]` token.
- `shipment-email-intake` precedence: plus-address `ai4bcat+tracking.<shipmentId>@` > own Message-ID / `In-Reply-To` / `References` (newest first) > subject `[ref]`. If sources disagree the plus-address (else the next) wins, the response carries `conflict:true` and the ingest input a `routingNote`. A reply matching nothing stays 422/unthreaded.
- Unit tests (`shipment-email-intake/handler.test.ts`): SES id in In-Reply-To with no plus-address; subject-ref only; plus beats In-Reply-To and subject with conflict flagged; In-Reply-To beats subject; unrelated reply unthreaded. `shipmentThread.test.ts`: subject token round-trip.
- Second bug found by the live run: the deployed intake role lacked `lambda:InvokeFunction` on tmsTrackingActions (the resource-policy grant has an `aws:SourceArn` condition a role never satisfies) -> every routed reply returned 502. Identity grant added in `backend.ts`.

## Live run status (honest)
Real sends proven on dev (deploy 162): rate con and invoice both `SENT` through SES to the allow-listed mailbox, SES MessageIds recorded in the runs below. Reply ingest and the In-Reply-To check FAIL on the deployed code (502 IAM / 422 not yet deployed) and the run is marked INCOMPLETE: re-run after the next deploy. Early runs ABORTED were harness fixture gaps (invoice needs an assigned carrier, a RATE_CON document and a recorded bill), fixed. Each run sent one rate con (and the last, one invoice) to the mailbox; a leftover fixture shipment from a failed cleanup was voided by hand.

## Production sending (Ryne, not done here)
Production already has SES production access and a verified `bcatcorp.com` domain. For any new sending address on that domain nothing more is needed. If DKIM/SPF/DMARC were never confirmed: in SES console > Identities > bcatcorp.com confirm DKIM "Successful" (3 CNAMEs in DNS), set a custom MAIL FROM domain (e.g. `mail.bcatcorp.com`: MX `10 feedback-smtp.us-east-1.amazonses.com` + TXT `v=spf1 include:amazonses.com ~all`), and publish `_dmarc.bcatcorp.com TXT "v=DMARC1; p=none; rua=mailto:<mailbox>"` then move to `quarantine` once reports are clean. Rate cons and invoices on prod should send from a `@bcatcorp.com` address (the code's `FROM_ADDRESS` is `ai4bcat@gmail.com`, a Gmail address, which fails DMARC alignment for strict receivers).

## Live run 2026-11-04T23:35:27.095Z — ABORTED: Not ready for accounting: No carrier or driver assigned

Recipient: the single allow-listed mailbox only. Ids and statuses; no other addresses.

```json
{
  "rateCon": {
    "shipmentId": "shp-5d092a50-1a0d-4903-9ef9-f60a0a1870b1",
    "loadCarrierId": "lcr-c82ae558-57f2-46a3-874e-66cb4ba7a32f",
    "messageRowId": "msg:shp-5d092a50-1a0d-4903-9ef9-f60a0a1870b1:25040bf8-92af-48ea-bf57-81df038b835b",
    "status": "SENT",
    "sesMessageId": "010001a1a8eaab5a-f0b555e7-8ad3-4967-a9da-c85b33c7cf69-000000",
    "storedMessageIdHeader": "<s.shp-5d092a50-1a0d-4903-9ef9-f60a0a1870b1.1.mw2r8ann@bcatcorp.com>",
    "threadKey": "tracking+shp-5d092a50-1a0d-4903-9ef9-f60a0a1870b1",
    "error": null
  },
  "invoice": {},
  "reply": {
    "intakeStatus": 401,
    "routedShipmentMatches": false,
    "inboundRowId": null,
    "inboundThreadKey": null,
    "strippedAliasStatus": 401
  }
}
```

```
PASS  fixture customer created — 1793835308744-q6ann2wqk
PASS  SEND_RATE_CON returned SENT — loadCarrier lcr-c82ae558-57f2-46a3-874e-66cb4ba7a32f
PASS  rate con SENT through SES — SES MessageId 010001a1a8eaab5a-f0b555e7-8ad3-4967-a9da-c85b33c7cf69-000000
PASS  every rate con recipient is inside the allow-listed mailbox — to 1, cc 2
PASS  stored Message-ID header and per-load thread key — <s.shp-5d092a50-1a0d-4903-9ef9-f60a0a1870b1.1.mw2r8ann@bcatcorp.com> · tracking+shp-5d092a50-1a0d-4903-9ef9-f60a0a1870b1
FAIL  reply routed by the plus address to the right shipment — HTTP 401 {"error":"unauthorized"}
FAIL  inbound reply landed on the same per-load thread key — no inbound row
FAIL  reply with the plus alias stripped threads by In-Reply-To — HTTP 401 {"error":"unauthorized"}
PASS  fixture shipment voided — shp-5d092a50-1a0d-4903-9ef9-f60a0a1870b1
PASS  fixture shipment voided — shp-22ade5db-053d-4da0-99da-5e1089e14548
PASS  temp admin identity deleted
```

## Live run 2026-11-04T23:35:57.499Z — ABORTED: UnknownError

Recipient: the single allow-listed mailbox only. Ids and statuses; no other addresses.

```json
{
  "rateCon": {
    "shipmentId": "shp-61194b0b-108f-4a23-b445-b8f93d3ce17f",
    "loadCarrierId": "lcr-78b773e2-c795-4e44-a9e6-352668fa7ed3",
    "messageRowId": "msg:shp-61194b0b-108f-4a23-b445-b8f93d3ce17f:d0259f9f-c871-471e-981a-115d82fa27cc",
    "status": "SENT",
    "sesMessageId": "010001a1a8eb4d27-08536a2e-cbd3-4a14-b674-894798bfd6af-000000",
    "storedMessageIdHeader": "<s.shp-61194b0b-108f-4a23-b445-b8f93d3ce17f.1.mw2r96nb@bcatcorp.com>",
    "threadKey": "tracking+shp-61194b0b-108f-4a23-b445-b8f93d3ce17f",
    "error": null
  },
  "invoice": {},
  "reply": {}
}
```

```
PASS  fixture customer created — 1793835350664-hkvrqsyhw
PASS  SEND_RATE_CON returned SENT — loadCarrier lcr-78b773e2-c795-4e44-a9e6-352668fa7ed3
PASS  rate con SENT through SES — SES MessageId 010001a1a8eb4d27-08536a2e-cbd3-4a14-b674-894798bfd6af-000000
PASS  every rate con recipient is inside the allow-listed mailbox — to 1, cc 2
PASS  stored Message-ID header and per-load thread key — <s.shp-61194b0b-108f-4a23-b445-b8f93d3ce17f.1.mw2r96nb@bcatcorp.com> · tracking+shp-61194b0b-108f-4a23-b445-b8f93d3ce17f
PASS  fixture shipment voided — shp-61194b0b-108f-4a23-b445-b8f93d3ce17f
PASS  temp admin identity deleted
```

## Live run 2026-11-04T23:36:33.325Z — ABORTED: Not ready for accounting: Missing document: RATE_CON; Carrier charges not settled: Vetted Transport LLC — record the carrier bill first

Recipient: the single allow-listed mailbox only. Ids and statuses; no other addresses.

```json
{
  "rateCon": {
    "shipmentId": "shp-cef06299-ff79-4016-9121-215fb52f881c",
    "loadCarrierId": "lcr-526bf617-b080-4a03-b59e-9eebc543a2a7",
    "messageRowId": "msg:shp-cef06299-ff79-4016-9121-215fb52f881c:24640247-4a8f-46f9-a149-ba1ad4627933",
    "status": "SENT",
    "sesMessageId": "010001a1a8eba872-4069fb9f-e580-45e8-8a57-4dbe6c6ae0a8-000000",
    "storedMessageIdHeader": "<s.shp-cef06299-ff79-4016-9121-215fb52f881c.1.mw2r9ool@bcatcorp.com>",
    "threadKey": "tracking+shp-cef06299-ff79-4016-9121-215fb52f881c",
    "error": null
  },
  "invoice": {},
  "reply": {
    "intakeStatus": 502,
    "routedShipmentMatches": false,
    "inboundRowId": null,
    "inboundThreadKey": null,
    "strippedAliasStatus": 422
  }
}
```

```
PASS  fixture customer created — 1793835373442-eofjre2ng
PASS  SEND_RATE_CON returned SENT — loadCarrier lcr-526bf617-b080-4a03-b59e-9eebc543a2a7
PASS  rate con SENT through SES — SES MessageId 010001a1a8eba872-4069fb9f-e580-45e8-8a57-4dbe6c6ae0a8-000000
PASS  every rate con recipient is inside the allow-listed mailbox — to 1, cc 2
PASS  stored Message-ID header and per-load thread key — <s.shp-cef06299-ff79-4016-9121-215fb52f881c.1.mw2r9ool@bcatcorp.com> · tracking+shp-cef06299-ff79-4016-9121-215fb52f881c
FAIL  reply routed by the plus address to the right shipment — HTTP 502 {"error":"invoke failed","detail":"User: arn:aws:sts::273354631837:assumed-role/amplify-d3dejqzs77khq6-de-shipmentemaili
FAIL  inbound reply landed on the same per-load thread key — no inbound row
FAIL  reply with the plus alias stripped threads by In-Reply-To — HTTP 422 {"error":"Could not route to a shipment"}
PASS  fixture shipment voided — shp-cef06299-ff79-4016-9121-215fb52f881c
PASS  fixture shipment voided — shp-16964b7b-0910-40bb-b75c-83561ca3264a
PASS  temp admin identity deleted
```

## Live run 2026-11-04T23:38:24.469Z — INCOMPLETE: not every step ran and returned ids; 4 check(s) FAILED

Recipient: the single allow-listed mailbox only. Ids and statuses; no other addresses.

```json
{
  "rateCon": {
    "shipmentId": "shp-d6a42500-1e10-46ea-9adf-4274efd8a041",
    "loadCarrierId": "lcr-c146daf6-b3f2-4036-af05-3d014e303e07",
    "messageRowId": "msg:shp-d6a42500-1e10-46ea-9adf-4274efd8a041:f6a05c5d-ae72-4d04-b825-a54631458611",
    "status": "SENT",
    "sesMessageId": "010001a1a8ed49bc-a6001ad5-941e-4475-b87f-e9f567e473b5-000000",
    "storedMessageIdHeader": "<s.shp-d6a42500-1e10-46ea-9adf-4274efd8a041.1.mw2rbz3i@bcatcorp.com>",
    "threadKey": "tracking+shp-d6a42500-1e10-46ea-9adf-4274efd8a041",
    "error": null
  },
  "invoice": {
    "shipmentId": "shp-5c1a4485-6665-48a1-8f6d-00a9dfc44669",
    "invoiceId": "20004",
    "noticeId": "inv:20004:1",
    "status": "SENT",
    "sesMessageId": "010001a1a8ed884b-0a75d88f-c076-43e5-9389-8861170b2c14-000000",
    "error": null
  },
  "reply": {
    "intakeStatus": 502,
    "routedShipmentMatches": false,
    "inboundRowId": null,
    "inboundThreadKey": null,
    "strippedAliasStatus": 422
  }
}
```

```
PASS  fixture customer created — 1793835481062-9rcuun6ma
PASS  SEND_RATE_CON returned SENT — loadCarrier lcr-c146daf6-b3f2-4036-af05-3d014e303e07
PASS  rate con SENT through SES — SES MessageId 010001a1a8ed49bc-a6001ad5-941e-4475-b87f-e9f567e473b5-000000
PASS  every rate con recipient is inside the allow-listed mailbox — to 1, cc 2
PASS  stored Message-ID header and per-load thread key — <s.shp-d6a42500-1e10-46ea-9adf-4274efd8a041.1.mw2rbz3i@bcatcorp.com> · tracking+shp-d6a42500-1e10-46ea-9adf-4274efd8a041
FAIL  reply routed by the plus address to the right shipment — HTTP 502 {"error":"invoke failed","detail":"User: arn:aws:sts::273354631837:assumed-role/amplify-d3dejqzs77khq6-de-shipmentemaili
FAIL  inbound reply landed on the same per-load thread key — no inbound row
FAIL  reply with the plus alias stripped threads by In-Reply-To — HTTP 422 {"error":"Could not route to a shipment"}
PASS  fixture invoice generated — 20004
PASS  invoice SENT through SES — SES MessageId 010001a1a8ed884b-0a75d88f-c076-43e5-9389-8861170b2c14-000000 · notice inv:20004:1
PASS  every invoice recipient is inside the allow-listed mailbox — to 1, cc 0
PASS  fixture shipment voided — shp-d6a42500-1e10-46ea-9adf-4274efd8a041
FAIL  fixture shipment voided — shp-5c1a4485-6665-48a1-8f6d-00a9dfc44669: Vetted Transport LLC has a carrier bill on this shipment; void the bill first, then void the shipmen
PASS  temp admin identity deleted
```

## Live run 2026-11-05T00:01:32.070Z — ALL PASSED

Recipient: the single allow-listed mailbox only. Ids and statuses; no other addresses.

```json
{
  "rateCon": {
    "shipmentId": "shp-ad6a8047-3aab-468d-b15c-9599bf992327",
    "loadCarrierId": "lcr-61958f3c-1b48-456a-ab6d-a658a15b8986",
    "messageRowId": "msg:shp-ad6a8047-3aab-468d-b15c-9599bf992327:92eacce5-ee66-4e98-9e85-f3ca64946238",
    "status": "SENT",
    "sesMessageId": "010001a1a902221c-49f16525-1517-45c0-b907-662483fdcb82-000000",
    "storedMessageIdHeader": "<010001a1a902221c-49f16525-1517-45c0-b907-662483fdcb82-000000@email.amazonses.com>",
    "threadKey": "tracking+shp-ad6a8047-3aab-468d-b15c-9599bf992327",
    "error": null
  },
  "invoice": {
    "shipmentId": "shp-40770f8f-d713-437f-88cd-a6d74feb08f6",
    "invoiceId": "20005",
    "noticeId": "inv:20005:1",
    "status": "SENT",
    "sesMessageId": "010001a1a902a60f-8bad4b69-dbbe-436e-84de-1e97d75d00a9-000000",
    "error": null
  },
  "reply": {
    "intakeStatus": 200,
    "routedShipmentMatches": true,
    "inboundRowId": "msg:shp-ad6a8047-3aab-468d-b15c-9599bf992327:6002e1ce-a0ca-4d6f-8b64-bc47a86b68de",
    "inboundThreadKey": "tracking+shp-ad6a8047-3aab-468d-b15c-9599bf992327",
    "strippedAliasStatus": 200
  }
}
```

```
PASS  fixture customer created — 1793836837929-462ntjik1
PASS  SEND_RATE_CON returned SENT — loadCarrier lcr-61958f3c-1b48-456a-ab6d-a658a15b8986
PASS  rate con SENT through SES — SES MessageId 010001a1a902221c-49f16525-1517-45c0-b907-662483fdcb82-000000
PASS  every rate con recipient is inside the allow-listed mailbox — to 1, cc 2
PASS  stored Message-ID header and per-load thread key — <010001a1a902221c-49f16525-1517-45c0-b907-662483fdcb82-000000@email.amazonses.com> · tracking+shp-ad6a8047-3aab-468d-b15c-9599bf992327
PASS  reply routed by the plus address to the right shipment — HTTP 200
PASS  inbound reply landed on the same per-load thread key — tracking+shp-ad6a8047-3aab-468d-b15c-9599bf992327
PASS  reply with the plus alias stripped threads by In-Reply-To — HTTP 200
PASS  fixture invoice generated — 20005
PASS  invoice SENT through SES — SES MessageId 010001a1a902a60f-8bad4b69-dbbe-436e-84de-1e97d75d00a9-000000 · notice inv:20005:1
PASS  every invoice recipient is inside the allow-listed mailbox — to 1, cc 0
PASS  fixture carrier bill voided — cb:lcr-25d13acf-0ea2-42de-819a-e148f0a93839:1
PASS  fixture shipment voided — shp-ad6a8047-3aab-468d-b15c-9599bf992327
PASS  fixture shipment voided — shp-40770f8f-d713-437f-88cd-a6d74feb08f6
PASS  temp admin identity deleted
```

## Live run 2026-11-05T10:41:28.399Z — ABORTED: Not ready for accounting: Missing sales rep

Recipient: the single allow-listed mailbox only. Ids and statuses; no other addresses.

```json
{
  "rateCon": {
    "shipmentId": "shp-66adc04f-6e21-49e9-844c-0d621ba171cc",
    "loadCarrierId": "lcr-2b5587af-ac7f-4f52-9aba-96379734e10e",
    "messageRowId": "msg:shp-66adc04f-6e21-49e9-844c-0d621ba171cc:2178b172-9446-489e-b73f-eabc7228895a",
    "status": "SENT",
    "sesMessageId": "010001a1ab4c4f1a-3cc2c7ee-4803-4440-ac90-6bac966f057d-000000",
    "storedMessageIdHeader": "<010001a1ab4c4f1a-3cc2c7ee-4803-4440-ac90-6bac966f057d-000000@email.amazonses.com>",
    "threadKey": "tracking+shp-66adc04f-6e21-49e9-844c-0d621ba171cc",
    "error": null
  },
  "invoice": {},
  "reply": {
    "intakeStatus": 200,
    "routedShipmentMatches": true,
    "inboundRowId": "msg:shp-66adc04f-6e21-49e9-844c-0d621ba171cc:f6c52426-107e-4a72-9b96-cdbd148e8826",
    "inboundThreadKey": "tracking+shp-66adc04f-6e21-49e9-844c-0d621ba171cc",
    "strippedAliasStatus": 200
  }
}
```

```
PASS  fixture customer created — 1793875262066-ezfq3tfpc
PASS  SEND_RATE_CON returned SENT — loadCarrier lcr-2b5587af-ac7f-4f52-9aba-96379734e10e
PASS  rate con SENT through SES — SES MessageId 010001a1ab4c4f1a-3cc2c7ee-4803-4440-ac90-6bac966f057d-000000
PASS  every rate con recipient is inside the allow-listed mailbox — to 1, cc 2
PASS  stored Message-ID header and per-load thread key — <010001a1ab4c4f1a-3cc2c7ee-4803-4440-ac90-6bac966f057d-000000@email.amazonses.com> · tracking+shp-66adc04f-6e21-49e9-844c-0d621ba171cc
PASS  reply routed by the plus address to the right shipment — HTTP 200
PASS  inbound reply landed on the same per-load thread key — tracking+shp-66adc04f-6e21-49e9-844c-0d621ba171cc
PASS  reply with the plus alias stripped threads by In-Reply-To — HTTP 200
PASS  fixture carrier bill voided — cb:lcr-1a8b35eb-b288-405b-886b-c0fe66e56cfc:1
PASS  fixture shipment voided — shp-66adc04f-6e21-49e9-844c-0d621ba171cc
PASS  fixture shipment voided — shp-0fa91813-1f4f-4d16-8f13-471929296d91
PASS  temp admin identity deleted
```

## Live run 2026-11-05T10:44:07.080Z — ALL PASSED

Recipient: the single allow-listed mailbox only. Ids and statuses; no other addresses.

```json
{
  "rateCon": {
    "shipmentId": "shp-68997274-4b3c-4f37-9e67-aec22262ff3a",
    "loadCarrierId": "lcr-cb77335c-06c4-4849-b5a2-a5b27884f366",
    "messageRowId": "msg:shp-68997274-4b3c-4f37-9e67-aec22262ff3a:1e648eb4-90fb-4a93-bb97-ffaf17799618",
    "status": "SENT",
    "sesMessageId": "010001a1ab4eb663-39ab10f1-70a4-4304-bd70-d48cf2cbfcb6-000000",
    "storedMessageIdHeader": "<010001a1ab4eb663-39ab10f1-70a4-4304-bd70-d48cf2cbfcb6-000000@email.amazonses.com>",
    "threadKey": "tracking+shp-68997274-4b3c-4f37-9e67-aec22262ff3a",
    "error": null
  },
  "invoice": {
    "shipmentId": "shp-226841ba-7bd9-486b-b4b6-0fa7ba3f249c",
    "invoiceId": "20007",
    "noticeId": "inv:20007:1",
    "status": "SENT",
    "sesMessageId": "010001a1ab4eff5e-8dd6ef9b-c78c-40f9-b871-60e45b917317-000000",
    "error": null
  },
  "reply": {
    "intakeStatus": 200,
    "routedShipmentMatches": true,
    "inboundRowId": "msg:shp-68997274-4b3c-4f37-9e67-aec22262ff3a:bce28534-e969-44d7-8e8d-58cf959deb13",
    "inboundThreadKey": "tracking+shp-68997274-4b3c-4f37-9e67-aec22262ff3a",
    "strippedAliasStatus": 200
  }
}
```

```
PASS  fixture customer created — 1793875417983-em2e0w9ho
PASS  SEND_RATE_CON returned SENT — loadCarrier lcr-cb77335c-06c4-4849-b5a2-a5b27884f366
PASS  rate con SENT through SES — SES MessageId 010001a1ab4eb663-39ab10f1-70a4-4304-bd70-d48cf2cbfcb6-000000
PASS  every rate con recipient is inside the allow-listed mailbox — to 1, cc 2
PASS  stored Message-ID header and per-load thread key — <010001a1ab4eb663-39ab10f1-70a4-4304-bd70-d48cf2cbfcb6-000000@email.amazonses.com> · tracking+shp-68997274-4b3c-4f37-9e67-aec22262ff3a
PASS  reply routed by the plus address to the right shipment — HTTP 200
PASS  inbound reply landed on the same per-load thread key — tracking+shp-68997274-4b3c-4f37-9e67-aec22262ff3a
PASS  reply with the plus alias stripped threads by In-Reply-To — HTTP 200
PASS  fixture invoice generated — 20007
PASS  invoice SENT through SES — SES MessageId 010001a1ab4eff5e-8dd6ef9b-c78c-40f9-b871-60e45b917317-000000 · notice inv:20007:1
PASS  every invoice recipient is inside the allow-listed mailbox — to 1, cc 0
PASS  fixture carrier bill voided — cb:lcr-7323e631-96d2-4c12-8571-c550291bacac:1
PASS  fixture shipment voided — shp-68997274-4b3c-4f37-9e67-aec22262ff3a
PASS  fixture shipment voided — shp-226841ba-7bd9-486b-b4b6-0fa7ba3f249c
PASS  temp admin identity deleted
```

## Live run 2026-11-05T11:07:57.001Z — ALL PASSED

Recipient: the single allow-listed mailbox only. Ids and statuses; no other addresses.

```json
{
  "rateCon": {
    "shipmentId": "shp-3b1f0d87-7c16-4c5e-8e78-46be34b0e5d8",
    "loadCarrierId": "lcr-5e0d4f16-39ab-4e32-9f4a-cd2cb53077f1",
    "messageRowId": "msg:shp-3b1f0d87-7c16-4c5e-8e78-46be34b0e5d8:959736ec-8bb1-4033-9e95-6989b084ff49",
    "status": "SENT",
    "sesMessageId": "010001a1ab6460cb-19d3e709-a219-4dd2-99b3-6ee8fbcecfc9-000000",
    "storedMessageIdHeader": "<010001a1ab6460cb-19d3e709-a219-4dd2-99b3-6ee8fbcecfc9-000000@email.amazonses.com>",
    "threadKey": "tracking+shp-3b1f0d87-7c16-4c5e-8e78-46be34b0e5d8",
    "error": null
  },
  "invoice": {
    "shipmentId": "shp-95827d0c-6510-43c2-8e22-e1f4bc72d89e",
    "invoiceId": "20022",
    "noticeId": "inv:20022:1",
    "status": "SENT",
    "sesMessageId": "010001a1ab64c947-1f916bc6-10c1-48c2-8cf4-23de71d227f3-000000",
    "error": null
  },
  "reply": {
    "intakeStatus": 200,
    "routedShipmentMatches": true,
    "inboundRowId": "msg:shp-3b1f0d87-7c16-4c5e-8e78-46be34b0e5d8:fb7fd0cf-e856-4aa0-bbf3-828580c842f8",
    "inboundThreadKey": "tracking+shp-3b1f0d87-7c16-4c5e-8e78-46be34b0e5d8",
    "strippedAliasStatus": 200
  }
}
```

```
PASS  fixture customer created — 1793876836773-xlay95zhx
PASS  SEND_RATE_CON returned SENT — loadCarrier lcr-5e0d4f16-39ab-4e32-9f4a-cd2cb53077f1
PASS  rate con SENT through SES — SES MessageId 010001a1ab6460cb-19d3e709-a219-4dd2-99b3-6ee8fbcecfc9-000000
PASS  every rate con recipient is inside the allow-listed mailbox — to 1, cc 2
PASS  stored Message-ID header and per-load thread key — <010001a1ab6460cb-19d3e709-a219-4dd2-99b3-6ee8fbcecfc9-000000@email.amazonses.com> · tracking+shp-3b1f0d87-7c16-4c5e-8e78-46be34b0e5d8
PASS  reply routed by the plus address to the right shipment — HTTP 200
PASS  inbound reply landed on the same per-load thread key — tracking+shp-3b1f0d87-7c16-4c5e-8e78-46be34b0e5d8
PASS  reply with the plus alias stripped threads by In-Reply-To — HTTP 200
PASS  fixture invoice generated — 20022
PASS  invoice SENT through SES — SES MessageId 010001a1ab64c947-1f916bc6-10c1-48c2-8cf4-23de71d227f3-000000 · notice inv:20022:1
PASS  every invoice recipient is inside the allow-listed mailbox — to 1, cc 0
PASS  fixture carrier bill voided — cb:lcr-798b418c-f1ea-4110-b9e4-527e9ceee21a:1
PASS  fixture shipment voided — shp-3b1f0d87-7c16-4c5e-8e78-46be34b0e5d8
PASS  fixture shipment voided — shp-95827d0c-6510-43c2-8e22-e1f4bc72d89e
PASS  temp admin identity deleted
```

## 2026-11-05 - Step AS live invitation (dev, job 179)

- `node scripts/devVerifyAS.mjs --live-invite`, run once. MC 274623 only; MyCarrierPackets returned **1** address for it (source MCP_APPROVED), and it is not ai4bcat. So the default-list path was NOT used: the call named `ai4bcat@gmail.com` explicitly (`emails: ['ai4bcat@gmail.com']`) and nothing was sent to MCP's own address.
- EmailPacketInvitation: sent=true, mode LIVE, MCP HTTP status 200, 1 recipient (ai4bcat@gmail.com).
- Ivan Cartage was not in the dev directory, so the call used `ensureCarrier`: the PENDING row was created from MCP's record after the invitation (it is now status PENDING, mcpStatus INVITED), and the invitation is logged on it. It also noted the invitation on the first listed dev shipment's thread.
- Read back through the API afterwards (separate script; the harness's own read-back crashed on a GraphQL variable type and an audit scan limit, both fixed in `devVerifyAS.mjs`, not re-run because a second invitation is not allowed): carrier row stamped (mcpInvitedAt set, mcpInvitedTo only ai4bcat, mcpStatus INVITED); audit `MCP_SEND_INVITE` on the carrier with emails only ai4bcat; one thread note "MyCarrierPackets packet invitation" to ai4bcat only.
- Result: PASSED for the invitation and its three logs, as read back by hand. The harness's own AS04 read-back step has not run to green, so this is not recorded as ALL PASSED.
- Default-list (all MCP addresses) sending is proven by unit tests only, not live, because MCP's list for this carrier is a real address.
