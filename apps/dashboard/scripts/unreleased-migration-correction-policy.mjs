const approvedCorrections = Object.freeze([
  Object.freeze({
    baseRef: "754c21e498fee1fe25edc44fd131347ecb29ada3",
    tag: "0050_nullable_manual_order_commercial_evidence",
    baseSqlSha256:
      "54a5851a12024ae18f7cdcaf7994395a518fb18a9456ee7355f9bda60c88392b",
    currentSqlSha256:
      "f8630a281cfebae6d1ae1933cf0fe937df200aff62358ee953eb5d603e0da6eb",
  }),
]);

export function isApprovedUnreleasedMigrationCorrection(candidate) {
  return approvedCorrections.some(
    (approved) =>
      candidate.baseRef === approved.baseRef &&
      candidate.tag === approved.tag &&
      candidate.baseSqlSha256 === approved.baseSqlSha256 &&
      candidate.currentSqlSha256 === approved.currentSqlSha256,
  );
}
