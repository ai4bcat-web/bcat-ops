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
  // `awZakDriver.mjs --apply`: LoadCarrier.driverId/driverName/driverPhone on the own-asset leg of ZAK-coded PROs, only while empty + one AuditLog row per leg.
  awZakDriver: { models: ['LoadCarrier', 'AuditLog'] },
  // `awPreDelete.mjs --apply`: pre-2025 (Ship Date < 2025-01-01) migrated Aljex shipments and their children are deleted,
  // mixed ArPayment/ApPayment rows are edited, one AuditLog row per shipment is added. Never FactoringItem / TmsSettings.
  awPreDelete: { models: ['Shipment', 'Order', 'Load', 'LoadCarrier', 'LoadFinancials', 'LoadCharge', 'Invoice', 'CarrierBill', 'ProClaim', 'LegacyAljexRow', 'ArPayment', 'ApPayment', 'AuditLog'] },
  // `awCarriers.mjs activate|billing|delete --apply` (union; each subcommand's own subset is SUB_MODELS in the script):
  // Carrier.status / billing fields / delete, CarrierPaymentMethod (billing), CarrierTaxVault (delete; NOT an Amplify model: `CarrierTaxVault-<apiId>`), one AuditLog row per carrier.
  awCarriers: { models: ['Carrier', 'CarrierPaymentMethod', 'CarrierTaxVault', 'AuditLog'] },
};
