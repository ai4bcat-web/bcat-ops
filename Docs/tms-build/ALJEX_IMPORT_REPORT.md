# Aljex import report

Run `aljexrun:20261104055134A`, generated 2026-11-04T06:03:38.693Z. Counts, sums and PRO numbers only: no names or cell values.

- **Reconciled to the cent:** YES
- **Every row accounted for (staged = created + matched + enriched + skipped + conflicts + errors):** YES
- **Open AR (Σ open invoice balances):** $309,468.34
- **Unapplied customer credit (overpayments):** $804.68
- **Open AP (derived; compare with the Aljex AP aging):** $149,396.86

## Counts per entity

| Entity | Staged | Created | Matched | Enriched | Skipped | Conflicts | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| CUSTOMER | 486 | 304 | 171 | 0 | 0 | 11 | 0 |
| CARRIER | 1672 | 383 | 0 | 0 | 1289 | 0 | 0 |
| LOCATION | 16300 | 2980 | 13320 | 0 | 0 | 0 | 0 |
| LOAD | 7917 | 6984 | 47 | 604 | 4 | 278 | 0 |
| MEMO_CRED | 281 | 281 | 0 | 0 | 0 | 0 | 0 |
| MEMO_DEBT | 122 | 119 | 0 | 0 | 3 | 0 | 0 |
| INVOICE | 7782 | 6881 | 0 | 604 | 0 | 297 | 0 |
| AR_PAYMENT | 2391 | 2391 | 0 | 0 | 0 | 0 | 0 |
| BILL | 1604 | 1604 | 0 | 0 | 0 | 0 | 0 |
| AP_PAYMENT | 1067 | 1067 | 0 | 0 | 0 | 0 | 0 |

## Reconciliation (file vs BCAT, dollars)

| Check | File | BCAT | Difference |
|---|---:|---:|---:|
| Σ LH revenue (imported loads) vs Σ order customer rate | 8,432,886.35 | 8,432,886.35 | 0.00 OK |
| Σ Invoice Amount (imported loads) vs Σ CUSTOMER charges | 9,347,426.72 | 9,347,426.72 | 0.00 OK |
| Σ Invoice Amount + memo adjustments + residuals (invoices written) vs Σ invoice totals | 9,710,003.68 | 9,710,003.68 | 0.00 OK |
| Σ payments received (invoices written) vs Σ AR payments | 9,401,340.02 | 9,401,340.02 | 0.00 OK |
| Σ applied CRED/DEBT memos (invoices written) vs Σ memo adjustment lines on invoices | -13,417.23 | -13,417.23 | 0.00 OK |
| Σ CRED/DEBT memos whose reference has no invoice (reported, not applied) | 2,750.00 |  | n/a |
| Σ Bal Due the memos do not explain vs Σ residual invoice lines | 0.00 | 0.00 | 0.00 OK |
| Σ positive Bal Due vs open invoice balances | 309,468.34 | 309,468.34 | 0.00 OK |
| Σ overpaid Bal Due vs unapplied customer credit | 804.68 | 804.68 | 0.00 OK |
| Σ Bal Due vs open AR net of unapplied credit | 308,663.66 | 308,663.66 | 0.00 OK |
| File: Σ invoice totals − Σ payments − Σ Bal Due (must be 0) | 0.00 | 0.00 | 0.00 OK |
| BCAT: Σ invoice totals − Σ AR payments − (open AR − unapplied) (must be 0) | 0.00 | 0.00 | 0.00 OK |
| Σ CRED memos referencing a load of this file vs −Σ load Credits column (cross-check) | -22,167.40 | -22,167.40 | 0.00 OK |
| Σ DEBT memos referencing a load of this file vs Σ load Debits column (cross-check) | 9,098.81 | 9,098.81 | 0.00 OK |
| Σ paid carrier expense (non-fee, bills written) vs Σ AP payments | 1,953,718.99 | 1,953,718.99 | 0.00 OK |
| Open AP (derived; compare with the Aljex AP aging) |  | 149,396.86 | n/a |
| Not imported (customer unresolved, no invoice written), 19 load(s): Σ invoice totals | 22,075.73 |  | n/a |
| Not imported (customer unresolved, no invoice written): Σ payments received | 8,575.73 |  | n/a |
| Not imported (live record disagrees on revenue/carrier, not enriched), 278 load(s): Σ invoice totals | 199,824.42 |  | n/a |
| Not imported (live record disagrees on revenue/carrier, not enriched): Σ payments received | 163,094.23 |  | n/a |
| Not imported (live record disagrees on revenue/carrier, not enriched): Σ memos | -2,401.36 |  | n/a |
| Σ invoice totals, every invoiced load of the file vs invoices written + the not-imported items above | 9,931,903.83 | 9,931,903.83 | 0.00 OK |
| Σ payments received, every invoiced load of the file vs AR payments + the not-imported items above | 9,573,009.98 | 9,573,009.98 | 0.00 OK |
| Σ applied CRED/DEBT memos, every invoiced load of the file vs memo lines written + the not-imported items above | -15,818.59 | -15,818.59 | 0.00 OK |

## AR memos (CRED / DEBT)

Memos are not shipments: each becomes an adjustment line on the invoice of the load its Reference # names.

- Memo rows: 403 (281 credits totalling $22,167.40, 122 debits totalling $9,098.81)
- Applied as invoice adjustment lines: 400
- Not applied (reference has no invoice): 3; memo PROs: 10343, 10689, 10690

## Warning and finding categories

| Category | Rows | Example PROs | Meaning |
|---|---:|---|---|
| TERMS_NOT_CONFIGURED | 6881 | 6000, 6002, 6003, 6004, 6005 | no customer/org payment terms configured; Net 30 assumed on the invoice |
| CARRIER_SNAPSHOT | 2161 | 6019, 6032, 6046, 6047, 6055 | carrier was not imported to the directory; the load keeps a name snapshot |
| CARRIER_SKIPPED | 1289 |  | carrier outside the activity window was not imported to the directory |
| ENRICH_MISMATCH | 278 | 13171, 13355, 13364, 13373, 13388 | a PRO already in BCAT disagrees with Aljex on revenue or carrier; no write |
| ZERO_INVOICE | 60 | 6056, 6119, 6140, 6503, 7198 | invoice date set but Invoice Amount is 0 (no invoice written) |
| NO_CUSTOMER | 28 | 6542, 7368, 7528, 7729, 8779 | the load has no customer account; imported without a customer and listed for review |
| SHIP_AFTER_DELIVERED | 27 | 6319, 6326, 6569, 6694, 6729 | Ship Date is after Delivered Date |
| INVOICE_NO_CUSTOMER | 19 | 6542, 7368, 7528, 7729, 10142 | the load has an invoice but no customer account; no invoice written |
| JUNK_DATE | 14 | 8095, 8178, 8326, 8368, 8438 | a date cell is impossible or outside 2000-2035 and was ignored |
| CUSTOMER_CONFLICT | 11 |  | a customer name matches several directory customers; not imported |
| NO_DELIVERY_STOP | 9 | 8779, 9774, 10555, 10588, 10793 |  |
| INVOICE_BEFORE_SHIP | 6 | 6319, 6326, 7396, 7674, 7897 | Invoice Date is before Ship Date |
| CARRIER_NO_IDENTIFIERS | 5 |  | carrier has no MC, DOT or SCAC |
| DUPLICATE_ROW_IDENTICAL | 4 | 7015, 7061, 7691, 8643 | a PRO repeats with a byte-identical row; the later copy was skipped |
| IVAN_DRIVER_UNMATCHED | 3 | 6353, 7140, 13407 | Ivan Cartage load names a driver that is not on the roster |
| MEMO_ORPHAN_REFERENCE_NOT_INVOICED | 3 | 10343, 10689, 10690 | memo Reference # names a load that has no invoice; not applied |
| BAD_WEIGHT | 2 | 7532, 13860 | weight is not a number and was left blank |
| MC_PREFIX_MX | 2 | 14332, 14368 | carrier MC prefix is MX |
| CARRIER_MX_PREFIX | 1 |  | carrier MC prefix is MX |

## Open items for the owner

1. 3 memo(s) name a Reference # that has no invoice (listed above, and in memos.csv). Decide whether each is an unapplied credit/debit or can be ignored.
2. 28 load(s) were imported with no customer. Assign a customer from the shipment page (PROs above).
3. 1289 carrier(s) outside the activity window were not imported to the directory (carriers-skipped.csv).
4. 3 Ivan Cartage load(s) name a driver who is not a unique roster match; the driver is in the leg note only.
5. Settings > Users: map the Aljex sales rep, creator, service rep and dispatcher codes to users, then reassign shipments by code. Until then salesRepId stays empty and the code is kept on each shipment.
6. Imported carriers are PENDING with no insurance, W-9, payment method or contacts beyond phone/email (not in the export): send a MyCarrierPackets packet before booking. Imported customers have no terms, credit limit or factoring flag (not in the export); all imported records are flagged legacy.
7. Invoice due dates use the customer terms, else the org default (the export has no terms). Payment method is CHECK (no column).


## Appendix: PROs that exist both in production (already on dev before the import) and in the Aljex file

Rule applied (Ryne, 2026-11-03): the production Load row is the operational source of truth and is kept as is; the import never rewrites a live Load/Shipment. Aljex finance (invoice, payments, bill, memo lines) is attached to the existing load when revenue and carrier agree (ENRICH), and nothing is written when they disagree (ENRICH_MISMATCH: listed for review). No PRO exists twice (scripts/checkDevDuplicates.mjs: 0 duplicate groups for Load.aljexId, shipment number, load number and invoice number).

- PROs in both: **929** (of 8316 distinct PROs in the file; 3580 PRO-bearing loads were on dev before the import).
- Aljex finance attached to the existing production load (enriched or matched): **651**.
- Disagree on revenue or carrier, nothing written (ENRICH_MISMATCH): **278**.
- PROs carried by both a pre-existing load and an import-created load (must be 0): **0**.

### Enriched / matched PROs

13320, 13397, 13421, 13448, 13459, 13469, 13476, 13484, 13492, 13505, 13506, 13512, 13513, 13517, 13518, 13521, 13523, 13527, 13528, 13529, 13530, 13531, 13536, 13538, 13539, 13542, 13543, 13545, 13546, 13549, 13550, 13555, 13557, 13558, 13564, 13566, 13569, 13570, 13573, 13581, 13584, 13587, 13589, 13590, 13591, 13596, 13598, 13599, 13611, 13617, 13620, 13629, 13631, 13633, 13638, 13641, 13646, 13648, 13653, 13656, 13660, 13667, 13668, 13670, 13671, 13674, 13676, 13677, 13680, 13682, 13683, 13686, 13687, 13690, 13694, 13698, 13700, 13701, 13702, 13705, 13706, 13707, 13708, 13710, 13711, 13718, 13719, 13721, 13725, 13726, 13730, 13737, 13738, 13739, 13741, 13750, 13751, 13752, 13753, 13766, 13771, 13774, 13782, 13786, 13788, 13789, 13791, 13793, 13800, 13804, 13805, 13806, 13809, 13810, 13812, 13813, 13816, 13818, 13819, 13822, 13823, 13827, 13833, 13840, 13842, 13843, 13844, 13845, 13846, 13847, 13848, 13850, 13860, 13868, 13873, 13874, 13883, 13884, 13886, 13887, 13888, 13889, 13890, 13891, 13893, 13894, 13895, 13896, 13897, 13906, 13909, 13912, 13916, 13918, 13919, 13920, 13921, 13924, 13929, 13933, 13935, 13937, 13939, 13945, 13946, 13948, 13950, 13951, 13956, 13965, 13966, 13971, 13972, 13973, 13974, 13975, 13976, 13979, 13980, 13985, 13990, 13992, 13993, 13994, 13995, 13997, 13998, 14002, 14003, 14004, 14005, 14009, 14011, 14012, 14013, 14014, 14015, 14016, 14019, 14024, 14025, 14026, 14032, 14033, 14036, 14037, 14039, 14041, 14042, 14044, 14045, 14047, 14049, 14052, 14055, 14056, 14057, 14058, 14059, 14060, 14063, 14064, 14068, 14073, 14076, 14077, 14080, 14081, 14082, 14083, 14090, 14097, 14098, 14101, 14102, 14105, 14108, 14109, 14110, 14111, 14113, 14114, 14116, 14117, 14118, 14119, 14122, 14126, 14128, 14129, 14130, 14131, 14135, 14136, 14137, 14138, 14139, 14140, 14142, 14143, 14150, 14152, 14157, 14158, 14160, 14161, 14162, 14167, 14172, 14173, 14177, 14178, 14179, 14180, 14186, 14190, 14191, 14192, 14196, 14197, 14199, 14200, 14203, 14204, 14206, 14208, 14211, 14212, 14214, 14215, 14218, 14224, 14225, 14226, 14227, 14229, 14231, 14235, 14236, 14237, 14238, 14239, 14240, 14241, 14243, 14244, 14245, 14246, 14249, 14250, 14251, 14252, 14253, 14256, 14257, 14260, 14261, 14264, 14265, 14269, 14270, 14272, 14276, 14282, 14285, 14286, 14289, 14290, 14292, 14294, 14295, 14296, 14300, 14301, 14302, 14303, 14304, 14307, 14309, 14315, 14316, 14317, 14319, 14321, 14323, 14325, 14326, 14327, 14329, 14333, 14334, 14335, 14339, 14340, 14341, 14342, 14343, 14344, 14345, 14346, 14347, 14348, 14349, 14350, 14352, 14353, 14354, 14358, 14361, 14365, 14367, 14369, 14370, 14372, 14376, 14377, 14381, 14384, 14387, 14388, 14389, 14392, 14399, 14403, 14405, 14408, 14409, 14414, 14415, 14424, 14426, 14427, 14431, 14432, 14436, 14441, 14446, 14448, 14451, 14452, 14453, 14455, 14457, 14459, 14464, 14467, 14469, 14471, 14477, 14478, 14479, 14502, 14504, 14505, 14507, 14508, 14511, 14512, 14514, 14515, 14517, 14518, 14519, 14523, 14524, 14526, 14528, 14529, 14530, 14533, 14534, 14535, 14536, 14538, 14539, 14541, 14542, 14545, 14546, 14547, 14548, 14549, 14550, 14553, 14556, 14559, 14561, 14564, 14567, 14568, 14569, 14570, 14571, 14573, 14577, 14579, 14584, 14587, 14589, 14590, 14592, 14593, 14595, 14596, 14597, 14599, 14601, 14604, 14611, 14612, 14613, 14614, 14615, 14617, 14618, 14624, 14625, 14626, 14627, 14629, 14631, 14632, 14636, 14637, 14638, 14639, 14641, 14643, 14644, 14645, 14646, 14647, 14648, 14649, 14650, 14651, 14652, 14653, 14655, 14657, 14658, 14659, 14660, 14663, 14665, 14666, 14667, 14668, 14669, 14670, 14671, 14672, 14674, 14676, 14677, 14678, 14679, 14680, 14684, 14688, 14689, 14690, 14691, 14694, 14696, 14698, 14700, 14701, 14705, 14706, 14708, 14710, 14711, 14712, 14713, 14714, 14718, 14719, 14721, 14725, 14726, 14729, 14731, 14733, 14734, 14737, 14738, 14739, 14743, 14744, 14745, 14746, 14747, 14748, 14749, 14750, 14756, 14761, 14762, 14763, 14766, 14769, 14773, 14779, 14800, 14801, 14802, 14803, 14804, 14805, 14806, 14807, 14808, 14811, 14813, 14814, 14817, 14818, 14819, 14820, 14821, 14822, 14823, 14824, 14825, 14826, 14827, 14829, 14830, 14833, 14834, 14835, 14836, 14837, 14838, 14841, 14844, 14845, 14849, 14850, 14851, 14852, 14853, 14856, 14857, 14858, 14859, 14861, 14862, 14864, 14865, 14867, 14868, 14869, 14870, 14871, 14872, 14873, 14874, 14875, 14877, 14878, 14879, 14880, 14881, 14882, 14883, 14884, 14885, 14886, 14887, 14888, 14889, 14890, 14891, 14893, 14894, 14895, 14896, 14897, 14899, 14901, 14902, 14903, 14905, 14906, 14907, 14908, 14909, 14911, 14912

### ENRICH_MISMATCH PROs (production row kept, Aljex finance NOT attached; review each)

13171, 13355, 13364, 13373, 13388, 13398, 13420, 13422, 13440, 13442, 13453, 13460, 13467, 13474, 13477, 13478, 13482, 13489, 13490, 13491, 13493, 13495, 13498, 13503, 13507, 13509, 13510, 13519, 13520, 13532, 13533, 13534, 13535, 13540, 13561, 13562, 13565, 13567, 13568, 13574, 13576, 13578, 13583, 13601, 13602, 13603, 13604, 13605, 13606, 13609, 13610, 13616, 13627, 13635, 13636, 13639, 13642, 13644, 13645, 13675, 13678, 13685, 13691, 13693, 13695, 13696, 13713, 13714, 13715, 13717, 13720, 13722, 13723, 13724, 13728, 13731, 13742, 13743, 13745, 13748, 13749, 13754, 13755, 13758, 13761, 13765, 13769, 13770, 13772, 13776, 13777, 13778, 13781, 13783, 13792, 13795, 13796, 13801, 13803, 13828, 13830, 13831, 13832, 13834, 13835, 13836, 13838, 13839, 13841, 13849, 13851, 13852, 13854, 13855, 13856, 13857, 13858, 13859, 13867, 13869, 13870, 13875, 13876, 13877, 13879, 13880, 13882, 13904, 13910, 13922, 13923, 13926, 13930, 13931, 13934, 13942, 13952, 13957, 13958, 13959, 13960, 13961, 13963, 13967, 13968, 13977, 13988, 13989, 13991, 13996, 14006, 14010, 14017, 14020, 14021, 14027, 14030, 14034, 14035, 14038, 14040, 14043, 14051, 14062, 14066, 14067, 14071, 14072, 14079, 14084, 14092, 14093, 14096, 14104, 14107, 14120, 14144, 14145, 14151, 14153, 14154, 14168, 14209, 14217, 14219, 14221, 14228, 14232, 14255, 14263, 14266, 14267, 14278, 14281, 14283, 14287, 14291, 14293, 14299, 14305, 14306, 14308, 14314, 14330, 14331, 14332, 14336, 14351, 14360, 14368, 14375, 14378, 14380, 14382, 14383, 14385, 14394, 14395, 14396, 14401, 14410, 14411, 14413, 14425, 14433, 14434, 14445, 14447, 14450, 14454, 14460, 14461, 14466, 14472, 14473, 14498, 14499, 14500, 14501, 14506, 14509, 14513, 14527, 14540, 14554, 14555, 14557, 14560, 14565, 14566, 14574, 14575, 14576, 14578, 14585, 14602, 14605, 14608, 14642, 14682, 14683, 14702, 14707, 14722, 14723, 14724, 14727, 14740, 14741, 14751, 14752, 14753, 14754, 14758, 14759, 14777, 14778, 14799
