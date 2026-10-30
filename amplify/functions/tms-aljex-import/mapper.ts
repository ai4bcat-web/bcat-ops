/**
 * Aljex CSV column mapping and row mapping.
 *
 * Re-exports the shared mapper so the Lambda bundle and frontend tests use the
 * same logic.
 */
export {
  guessAljexMapping,
  mapAljexRow,
  type AljexColumnTarget,
  type AljexColumnMapping,
  type AljexRow,
} from '@/lib/aljexImport'
