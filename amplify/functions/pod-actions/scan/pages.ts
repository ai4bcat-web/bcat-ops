/**
 * The order pages go into the combined PDF.
 *
 * By page number first, because that is what every uploader writes and what the driver
 * app shows. Then by when the page arrived — the tiebreak that used to be missing. The
 * staff client once restarted numbering at 1 for every batch it added, so a second batch
 * collided with the first on page number alone; a sort with no second key left the order
 * to the table scan, which is to say to chance. Pages that arrived later are later pages.
 *
 * Pure, so the rule is testable without DynamoDB or S3.
 */
export interface OrderablePage {
  pageNumber?: number | string | null
  uploadedAt?: string | null
}

export function orderPages<T extends OrderablePage>(docs: T[]): T[] {
  return [...docs].sort(
    (a, b) =>
      Number(a.pageNumber ?? 0) - Number(b.pageNumber ?? 0) ||
      String(a.uploadedAt ?? '').localeCompare(String(b.uploadedAt ?? '')),
  )
}
