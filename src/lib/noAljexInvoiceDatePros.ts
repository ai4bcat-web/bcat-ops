/**
 * PROs of the imported Aljex shipments that sat in Docs needed with NO Aljex invoice date (possible unbilled freight):
 * 41 of the 62 in docs-needed-imported-2026-11-08.csv. PRO keys only. The Aljex invoice date is not stored on any
 * Order/Shipment field, so this one qualifier cannot be derived and ships as data; everything else about the
 * "Review billing" flag is derived (see reviewBilling.ts).
 */
export const NO_ALJEX_INVOICE_DATE_PROS: readonly string[] = ["8779", "9204", "9774", "10793", "10905", "11836", "13029", "13143", "13175", "13365", "13571", "13650", "13652", "13704", "13983", "14061", "14112", "14311", "14312", "14313", "14355", "14356", "14458", "14520", "14537", "14588", "14600", "14619", "14697", "14699", "14720", "14809", "14815", "14855", "14860", "14863", "14892", "14900", "14904", "14914", "14918"]
