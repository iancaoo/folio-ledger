/** A receipt records the successful operation's location, never a second business history. */
export function receiptOutcome(result: any) {
  if (result?.fund && result?.share_classes) return {
    fund_id: result.fund.id, version_no: result.fund.business_version,
    technical_revision: result.fund.technical_revision,
  };
  if (result?.batch && result?.rows) return {
    batch_id: result.batch.id, technical_revision: result.batch.technical_revision,
    status: result.batch.status, preview_token: result.batch.preview?.token ?? null,
  };
  if (result?.finding_key) return { id: result.id, technical_revision: result.technical_revision, finding_key: result.finding_key, review: result.review };
  if (result?.id && result?.technical_revision) return { id: result.id, technical_revision: result.technical_revision };
  // Import commit results already contain only batch/record IDs and a count.
  return result;
}
