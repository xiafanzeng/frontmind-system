-- Complete the commercial audit trail for Basic contracts created by the
-- website migration before these columns existed. Website provisioning remains
-- the authoritative source; offline/non-website users are intentionally not
-- inferred here.
UPDATE `service_contracts` contract
INNER JOIN `website_user_provisions` provision
  ON provision.`userId` = contract.`userId`
  AND provision.`orderId` = contract.`sourceReference`
SET
  contract.`amountFen` = provision.`amountFen`,
  contract.`currency` = 'CNY',
  contract.`prepaidMonths` = NULL,
  contract.`orderReference` = provision.`orderId`,
  contract.`externalContractReference` = provision.`contractId`,
  contract.`signedAt` = provision.`contractSignedAt`,
  contract.`signatoryId` = provision.`signatoryId`,
  contract.`signingEvidence` = CASE
    WHEN provision.`contractEvidence` IS NOT NULL
      THEN provision.`contractEvidence`
    WHEN provision.`contractDocumentSha256` IS NOT NULL
      THEN JSON_OBJECT(
        'legacyProvisioningEvidenceHash',
        provision.`contractDocumentSha256`,
        'migrationNote',
        '由已完成的官网开户记录回填；原始签署证据结构未保存'
      )
    ELSE NULL
  END
WHERE
  contract.`source` = 'website'
  AND contract.`planCode` = 'basic'
  AND provision.`status` = 'completed'
  AND provision.`userId` IS NOT NULL;
