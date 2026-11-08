# Step AS — Carrier Sales MC lookup: directory standing, setup packet, MCP e-mail addresses

Ryne, 2026-11-05: "On the carrier sales page, I looked up an MC and it doesn't show me if the
carrier is already set up with us and active and it also doesn't give the ability to send setup
packet via my carrier packet. Make this more clear and also: when you send the setup packet, it
should send to the same email addresses that my carrier packets populates."
Dev only. Touches `src/features/tms/carrierSales/OffersHub.tsx`, `CarrierLadderCard.tsx`,
`CoverCarrierDialog.tsx`, `FindInvitePage.tsx`, `mcpFind.ts` (MCP_SEND_INVITE), `mcpReview.ts`.

## 1. MC lookup result card (Carrier Sales, Cover dialog, ladder card, Find & Invite)
One shared **CarrierLookupCard** used everywhere an MC/DOT is looked up. It always answers three
questions at the top, in this order, as labelled badges with one line of detail each:

| Question | Source | Badge |
|---|---|---|
| **In our directory?** | Carrier table by MC, then DOT | `Set up with us` (green) + carrier name, status (ACTIVE / INACTIVE / DO NOT USE / PENDING), last load date, loads in 12 months · or `Not in directory` (gray) |
| **Packet standing** | mcpPacketStanding + carrierRisk.packetComplete | `Packet complete` (green) · `Packet invited <date>` (blue) · `No packet` (orange) · `Stub, no MCP call` (gray) |
| **MCP vetting** | PreviewCarrier (live) | Authority, insurance (cargo / liability / amounts, expiry), safety rating, risk score; red badge when any is failing or expired |

Rules:
- "Active with us" means Carrier.status = ACTIVE **and** packet complete. Show it as one green line
  `Active with us — ready to cover` so nobody has to combine two badges.
- Directory hit shows the carrier's dispatch contacts and e-mails we hold, and a link to the
  carrier page.
- Not in directory: show MCP's legal name, DBA, address, phone and **the e-mail addresses MCP
  returns** (see §3), plus the actions below.

## 2. Actions on the card (same on every surface)
- **Send setup packet** (primary when no packet): always available when MCP is live and the
  carrier has at least one e-mail from §3; never disabled because the offer row lacks a hand-typed
  e-mail. Confirmation popover lists the recipient address(es) with checkboxes (all checked by
  default) and an "add another address" field; the user can untick but the default is MCP's list.
- **Cover with this carrier** (primary when packet complete and status ACTIVE): opens the Step AM
  ladder with the carrier preselected.
- **Open carrier** (directory hit) / **Add to directory** (no hit: creates the PENDING row from
  MCP's record without inviting, for carriers who will complete the packet later).
- **Re-send packet** when standing is INVITED and older than 3 days.
- Hover title on a disabled action always says why (no MCP credential, no e-mail, DO NOT USE).

## 3. Setup packet goes to the addresses MyCarrierPackets populates
- Extend the MCP adapter's PreviewCarrier/GetCarrier mapping (`mcpAdapter.ts`, `mcpProfile.ts`) to
  capture every e-mail MCP returns for the carrier: FMCSA e-mail on the authority record, MCP
  profile / packet contact e-mails, dispatch and billing contacts. Store them on the review card
  (`mcpReview.ts` buildReviewCard → `emails: Array<{address, source, label}>`, deduped,
  lower-cased) so the UI and the Lambda read the same list.
- `MCP_SEND_INVITE` (`mcpFind.ts`) accepts `emails: string[]` (keep `email` for compatibility).
  Default when the caller passes none: the MCP list from §3. Validate each with
  `validateInviteEmail`; send one EmailPacketInvitation per address, or one call with all
  recipients if the MCP API accepts several (check the Integration Guide; prefer one call).
  Log every address on the Carrier row, in the audit and on the shipment thread.
- Hand-typed addresses are additive, never the only path. Offers Hub `setup()` stops requiring
  `q.carrierEmail`; `sendSetupPacket` carries `emails`.
- Stub mode (no credential): the card says `Stub, no MCP call`, lists no e-mails, and the send
  action is disabled with that reason.

## 4. Done when
- Looking up MC 274623 (Ivan Cartage, in directory) on Carrier Sales shows `Set up with us ·
  ACTIVE` and packet standing on the first line; looking up an MC not in the directory shows
  `Not in directory`, MCP's e-mails, and an enabled **Send setup packet**.
- One live invitation on dev sent to the MCP-populated address list for a test carrier (Ryne's
  test MC or ai4bcat@gmail.com if MCP returns it), logged on the carrier row and the load thread;
  evidence in `Docs/tms-build/EMAIL_LIVE_TEST.md`.
- Unit tests: card states (directory hit active / inactive / not found × packet complete /
  invited / none / stub); MCP_SEND_INVITE with default list, with unticked address, with
  additive hand-typed address; no invite when the list is empty.
- BUILD_LOG entry "## Step AS deployed" with the job number; DEMO_WALKTHROUGH Carrier Sales
  screenshots refreshed.
