/**
 * The DynamoDB models each production-gated script writes, in one place, because two things need the same list:
 * the script's own gate (`requireProd` checks a fresh backup of exactly these tables) and
 * `scripts/prodBackup.mjs` (creates those backups). A script that writes a table not listed here would be
 * writing without a backup; keep this list in step with the script.
 *
 * `readOnly: true` scripts write nothing and need no backup.
 * Names are the `__typename` model names; the table is `<Model>-<suffix>`.
 */

/** Every table the Aljex importer writes (engine WRITTEN_TABLES). */
export const ALJEX_IMPORT_MODELS = [
  'Shipment', 'Order', 'Load', 'LoadCarrier', 'LoadFinancials', 'LoadCharge', 'Customer', 'Location', 'Carrier',
  'Invoice', 'ArPayment', 'CarrierBill', 'ApPayment', 'ProClaim', 'TmsSettings', 'AuditLog', 'LegacyAljexRow',
];

/** @type {Record<string, {models: string[], readOnly?: boolean}>} */
export const PROD_WRITE_SETS = {
  importAljex: { models: ALJEX_IMPORT_MODELS },
  // `importAljex.mjs reconcile-entity --apply` publishes a RECONCILE job row (the only table it writes).
  importAljexRecon: { models: ['AljexImportJob'] },
  backfillApOpen: { models: ['LoadCarrier', 'AuditLog'] },
  backfillLegacyAr: { models: ['Order', 'AuditLog'] },
  backfillLaneSamples: { models: ['LaneRateSample', 'AuditLog'] },
  backfillOwnAssetDrivers: { models: ['LoadCarrier', 'Load', 'AuditLog'] },
  backfillShipmentDocuments: { models: ['ShipmentDocument', 'Customer', 'TmsSettings', 'Order', 'AuditLog'] },
  backfillCrm: { models: ['CrmAccount', 'CrmContact', 'CrmDomain', 'AuditLog'] },
  backfillProClaims: { models: ['ProClaim'] },
  backfillRevDivision: { models: ['OwnershipDivision', 'OwnershipRule', 'ShipmentView', 'Shipment', 'Load', 'AuditLog'] },
  backfillUserProfiles: { models: ['UserProfile', 'AuditLog'] },
  fixAljexBillNumbers: { models: ['Load', 'CarrierBill', 'AuditLog'] },
  checkDevDuplicates: { models: [], readOnly: true },
  seedTruckPhone: { models: ['TruckConfig'] },
  backfillCustomers: { models: ['Customer', 'Load'] },
  backfillLocations: { models: ['Load'] },
  backfillShipments: { models: ['Shipment', 'Order', 'Load', 'LoadCarrier', 'LoadFinancials', 'LoadCharge', 'ProClaim', 'AuditLog'] },
  seedDivisions: { models: ['Division', 'TmsSettings'] },
  seedRevDivisions: { models: ['OwnershipDivision', 'AuditLog'] },
  backfillDriverDocScans: { models: ['DriverSubmissionDoc', 'DriverSubmission'] },
  // `awRelease.mjs --apply`: Order release fields (arStatus, arStatusChangedAt, readyToInvoiceAt, updatedBy/At, version) + one AuditLog row per shipment.
  awRelease: { models: ['Order', 'AuditLog'] },
  // `awEquipRep.mjs --apply`: enrich-only Load.equipmentType, Order.equipmentType, Shipment.salesRepCode + one AuditLog row per shipment.
  awEquipRep: { models: ['Shipment', 'Load', 'Order', 'AuditLog'] },
  // `awSalesRepId.mjs --apply`: enrich-only Shipment.salesRepId + Order.customerRepId (where empty) + one AuditLog row per shipment.
  awSalesRepId: { models: ['Shipment', 'Order', 'AuditLog'] },
  // `awSalesRepFill.mjs --apply`: enrich-only Shipment.salesRepCode / salesRepId + Order.customerRepId on shipments with NO rep (from the Aljex Salesrep ID) + one AuditLog row per shipment.
  awSalesRepFill: { models: ['Shipment', 'Order', 'AuditLog'] },
  // `awSalesRepDivision.mjs --apply`: sales rep follows the revenue division (overwrites): Shipment.salesRepId/Code, Order.customerRepId, TmsSettings.divisionSalesReps + one AuditLog row per shipment.
  // `awIntakeClear.mjs --apply`: OPEN IntakeLoad rows whose shipment exists become MOVED (shipmentId/number) + one AuditLog row each.
  awIntakeClear: { models: ['IntakeLoad', 'Shipment', 'Order', 'AuditLog'] },
  // `awIntakeSweep.mjs --apply`: OPEN IntakeLoad rows for loads built today/yesterday become MOVED; the rest received on or before a cutoff become DISMISSED; one AuditLog row each.
  awIntakeSweep: { models: ['IntakeLoad', 'Shipment', 'Order', 'AuditLog'] },
  // `awCustomerSheet.mjs --apply`: Customer.billingMethod / apEmail / billingAddress (address only while empty) from Ryne's customer list sheet + one AuditLog row each.
  awCustomerSheet: { models: ['Customer', 'AuditLog'] },
  // `awCompanyPhones.mjs --apply`: the three Ivan Cartage CompanyPhone rows (only labels that do not exist) + AuditLog.
  awCompanyPhones: { models: ['CompanyPhone', 'AuditLog'] },
  // `awCustomersActivate.mjs --apply`: Customer.status DORMANT -> ACTIVE for stored-DORMANT customers that are not possible duplicates + one AuditLog row each.
  awCustomersActivate: { models: ['Customer', 'AuditLog'] },
  // `awPodToPdf.mjs --apply`: ACTIVE ShipmentDocument rows (any type) stored as JPEG/PNG point at a PDF made from the photo (new S3 object next to it, photo kept) + one AuditLog row each.
  awPodToPdf: { models: ['ShipmentDocument', 'AuditLog'] },
  // `awAssetsSubdivision.mjs --apply`: Shipment + Load revSubdivision (and revTagSource HAND -> INTAKE on intake stamps) for ASSETS shipments with a driver, only while empty + one AuditLog row per shipment.
  awAssetsSubdivision: { models: ['Shipment', 'Load', 'AuditLog'] },
  // `awTrackingAccepted.mjs --apply`: LoadCarrier.trackingAcceptedAt = the active tracking link's consentAt, only while empty (conditional update) + one AuditLog row each.
  awTrackingAccepted: { models: ['LoadCarrier', 'AuditLog'] },
  // `awDriverDelete.mjs --apply`: deletes the given Driver rows (with --detach: clears Load/LoadCarrier driver ids and deletes the driver's submissions first; releases its company phone) with an AuditLog row holding the row.
  awDriverDelete: { models: ['Driver', 'Load', 'LoadCarrier', 'DriverSubmission', 'DriverSubmissionDoc', 'CompanyPhone', 'AuditLog'] },
  awSalesRepDivision: { models: ['Shipment', 'Order', 'TmsSettings', 'AuditLog'] },
  // `awZakDriver.mjs --apply`: LoadCarrier.driverId/driverName/driverPhone on the own-asset leg of ZAK-coded PROs, only while empty + one AuditLog row per leg.
  awZakDriver: { models: ['LoadCarrier', 'AuditLog'] },
  awRenumberL: { models: ['Shipment', 'Load', 'Invoice', 'CarrierBill', 'SpotRequest', 'WorkflowRun', 'IntakeLoad', 'TrackingLink', 'Quote', 'LaneRateSample', 'Commission', 'AuditLog'] },
  // `awPreDelete.mjs --apply`: pre-2025 (Ship Date < 2025-01-01) migrated Aljex shipments and their children are deleted,
  // mixed ArPayment/ApPayment rows are edited, one AuditLog row per shipment is added. Never FactoringItem / TmsSettings.
  awPreDelete: { models: ['Shipment', 'Order', 'Load', 'LoadCarrier', 'LoadFinancials', 'LoadCharge', 'Invoice', 'CarrierBill', 'ProClaim', 'LegacyAljexRow', 'ArPayment', 'ApPayment', 'AuditLog'] },
  // `awDeletePayables.mjs --apply`: the 23 OPEN 2025 CarrierBill rows are deleted, ApPayment rows that paid them are edited/deleted (awPreDelete rule),
  // their LoadCarrier legs are released (AWAITING_INVOICE, no bill), one AuditLog row per bill. Never AR/Invoice/Load/Shipment/Order.
  awDeletePayables: { models: ['CarrierBill', 'ApPayment', 'LoadCarrier', 'AuditLog'] },
  // `awCarriers.mjs activate|billing|inactivate|delete|restore --apply` (union; each subcommand's own subset is SUB_MODELS in the script):
  // Carrier.status / billing fields / delete, CarrierPaymentMethod (billing, delete), CarrierContact + CarrierDocument (delete: child rows go with the carrier),
  // CarrierTaxVault (delete; NOT an Amplify model: `CarrierTaxVault-<apiId>`), one AuditLog row per carrier.
  awCarriers: { models: ['Carrier', 'CarrierContact', 'CarrierPaymentMethod', 'CarrierDocument', 'CarrierTaxVault', 'AuditLog'] },
  // `awRestoreDeleted.mjs --apply`: put-if-absent of the rows DELETE_SHIPMENTS exported (the models it deletes) + one AuditLog row per restored shipment.
  awRestoreDeleted: { models: ['ArPayment', 'ApPayment', 'LegacyAljexRow', 'Commission', 'FactoringItem', 'Invoice', 'CarrierBill', 'LaneRateSample', 'LoadFinancials', 'LoadCharge', 'LoadCheckCall', 'TrackingLink', 'ShipmentDocument', 'ShipmentNotice', 'ShipmentPosting', 'ShipmentMessage', 'LoadCarrier', 'Load', 'Order', 'Shipment', 'AuditLog'] },
  // `awLocationRename.mjs --apply`: the approved Location renames (name/street/city/state/zip + normalizedName/normalizedAddress, geocode cleared) + one AuditLog row per row;
  // `--with-stop-copies`: Load.stops[].name / originName / destinationName copies of the old name + one AuditLog row per Load.
  awLocationRename: { models: ['Location', 'Load', 'AuditLog'] },
  // `awLocationCleanup.mjs --apply`: Location.active=false for address-less unused rows (ARCHIVE); exact-duplicate Locations enriched/frozen (mergedIntoId, mergeJobId, active=false) and Load.stops[].locationId repointed to the survivor; one AuditLog row per write. `--rollback` reverses them from those rows.
  awLocationCleanup: { models: ['Location', 'Load', 'AuditLog'] },
  // `awCustomerEmail.mjs --apply`: enrich-only Customer.apEmail / invoiceCopyEmails / contactEmail (where empty) + one AuditLog row per customer.
  // `awDivisions.mjs drivers|retire-company|restore --apply` (union; per-subcommand subsets are SUB_MODELS in the script): Driver.driverType only (one AuditLog row per driver),
  // delete of the COMPANY OwnershipDivision row (exported first, refuses while referenced) + restore of it.
  awDivisions: { models: ['Driver', 'OwnershipDivision', 'AuditLog'] },
  awCustomerEmail: { models: ['Customer', 'AuditLog'] },
  // `awTruckFleet.mjs box-truck|owner-operator|rollback --apply`: Equipment.fleetGroup only (one truck per driver, conditional on the expected old value) + one AuditLog row per truck.
  awTruckFleet: { models: ['Equipment', 'AuditLog'] },
  // `awShipmentNumber.mjs --apply`: renumber post-cutover shipments (99xxx -> 20000...) in every table awRenumberL moves + TmsSettings.nextShipmentNumber.
  // `awCustomerBilling.mjs --apply`: Customer.billingMethod / apEmail / paymentTermsDays (conditional per customer) + one AuditLog row per customer.
  awCustomerBilling: { models: ['Customer', 'AuditLog'] },
  // `awCustomerBillingEmails.mjs --apply`: Customer.apEmail (OTR billing list; blank + non-FACTOR only) and Customer.noaEmail (notice-of-assignment; blank only), both conditional, + one AuditLog row per customer.
  awCustomerBillingEmails: { models: ['Customer', 'AuditLog'] },
  // `awInvoiceDocs.mjs --apply`: adds the missing `inv:<invoiceId>` INVOICE ShipmentDocument rows (put, attribute_not_exists(id)); never touches an existing row.
  awInvoiceDocs: { models: ['ShipmentDocument'] },
  // `awFactoringCustomerPaid.mjs --apply`: FactoringItem.customerPaidOn / customerPaymentRef on PROs 14749, 14700, 14538 only (conditional: still Pending with OTR and empty) + one AuditLog row each. Never status, shipment, invoice or payment.
  awFactoringCustomerPaid: { models: ['FactoringItem', 'AuditLog'] },
  awShipmentNumber: { models: ['Shipment', 'Load', 'Invoice', 'CarrierBill', 'SpotRequest', 'WorkflowRun', 'IntakeLoad', 'TrackingLink', 'Quote', 'LaneRateSample', 'Commission', 'AuditLog', 'TmsSettings'] },
};
