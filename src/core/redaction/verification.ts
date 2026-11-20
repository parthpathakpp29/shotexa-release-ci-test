import type { SafeShareVerification } from "./types";

/** Every output check must pass before a redaction artifact can be published. */
export function isSafeShareVerified(verification: SafeShareVerification | null | undefined): boolean {
  return verification?.redactionsFlattened === true &&
    verification.privacyMetadataRemoved === true &&
    verification.outputVerified === true &&
    verification.dimensionsMatch === true &&
    verification.formatMatch === true;
}
