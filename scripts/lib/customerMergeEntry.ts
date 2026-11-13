// Bundled by scripts/awCustomerDuplicateMerge.mjs (esbuild): the app's own duplicate grouping and merge,
// so the script repoints exactly the way MERGE_CUSTOMER does instead of keeping a second copy.
export { mergeCustomer, LINK_SOURCES, OWNED_SOURCES } from '../../amplify/functions/tms-directory-actions/customerDelete'
export { buildDuplicateIndex, normalizeCustomerName } from '../../src/lib/customerDuplicates'
