/**
 * Conservative guard for credential material accidentally pasted into a
 * customer-visible delivery summary. It intentionally targets labelled
 * secrets and common key prefixes while leaving ordinary prose untouched.
 */
export function deliverySummaryLooksLikeCredentialSecret(value: string) {
  return (
    /(?:api[\s_-]*key|token|secret|密钥|令牌)\s*(?::|：|=|为|是)\s*\S{6,}/iu.test(
      value,
    ) || /\b(?:bearer\s+|(?:sk|pk|rk)[_-])[a-z0-9_-]{12,}\b/iu.test(value)
  );
}
