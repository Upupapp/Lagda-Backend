// @lagda/security — cryptographic primitives shared by two process roles.
//
// ── Why this package exists ────────────────────────────────────────────────
//
// The secret box is used from both ends of a notification's life. The API
// SEALS a credential in the transaction that mints it; the WORKER opens it,
// hours later, in the transaction that renders the message.
//
// Leaving it in `@lagda/api` would have meant the worker importing the HTTP
// package to decrypt a string — pulling Fastify, helmet, swagger and cookie
// handling into a process whose defining property is that it must never listen
// on a port.
//
// So exactly the primitives BOTH roles need live here, and nothing else does.
// Password hashing, TOTP, session cookies and every token factory stay in
// `@lagda/api`, because only the HTTP role has any use for them.

export {
  createSecretBox, generateSecretBoxKey, SecretBoxError,
  type SecretBox, type SealedSecret,
} from "./secret-box.js";
export {
  createSealedSecretResolver, createChallengeSecretResolver,
  createNotificationSecretResolver,
  type CredentialValidityCheck, type ChallengeCredentialLookup,
} from "./notification-secret.js";
export {
  createArtifactIdGenerator, createSealIdGenerator, createCompletionIdGenerator,
  createEvidenceEventIdGenerator, createVerificationIdGenerator,
} from "./completion-identifiers.js";
