/**
 * Compatibility export. Credential encryption and file safety are owned by Core
 * so CLI and Server cannot drift into different persistence formats.
 */
export {
  CredentialStoreError,
  EncryptedCredentialStore,
  credentialValuesEqual,
} from '@ai-harness/core';
export type { EncryptedCredentialStoreOptions } from '@ai-harness/core';
