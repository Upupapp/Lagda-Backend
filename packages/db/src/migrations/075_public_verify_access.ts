// 075 — fixes a latent bug in public document verification, and extends it
// to an email-gated document view (OD-135's Verify Document work).
//
// ── The bug this fixes ──────────────────────────────────────────────────────
//
// `createPublicVerificationLookup` (evidence.ts, BACKEND-42) reads
// `verification_records`, `document_seals`, `signing_request_completions` and
// `signing_requests` with NO workspace context set — deliberately, because an
// anonymous caller holding only a verification ID has no tenant to name.
//
// Every one of those tables FORCES row level security (019, 003), and
// `lagda_app` — the single role that owns them AND is the only role the
// running API/worker ever connect as, verified in production
// (`select tableowner from pg_tables`, `select rolbypassrls from pg_roles`) —
// holds no BYPASSRLS. FORCE means even the owner is bound by RLS. With no
// `lagda.current_workspace` set, `tenant_isolation`'s `workspace_id =
// lagda_current_workspace()` is `workspace_id = NULL`, which is never true.
//
// Confirmed empirically against production (2026-09-25): a verification ID
// known to exist and be completed returned `verification_record_not_found`
// from the live API. The lookup has never worked in production; nothing
// caught it because the frontend never called it end to end.
//
// ── The fix is its OWN credential realm, not "no workspace set" ────────────
//
// The first draft of this migration used `lagda_current_workspace() is null`
// as the widened policy's condition. `tests/db/signing-access.integration.
// test.ts` caught why that is wrong before it shipped: the SIGNING-ACCESS
// recipient realm (021) ALSO runs with no workspace context — it resolves
// tenancy from `lagda.signing_access_digest` instead — so "no workspace set"
// is true there too, and the draft policy let a signer's session read every
// tenant's `signing_requests` and `signing_request_recipients` rows, not just
// the one its own grant names. The SAME realms exist for invitations,
// sessions and final copies (051, 073), every one keyed on its OWN setting
// rather than on the absence of the workspace one — that is what this
// migration should have matched from the start.
//
// So the public-verification realm gets a FOURTH kind of narrow setting,
// following the identical shape: `lagda_current_public_verification()`, a
// `stable` function reading `lagda.public_verification_active`, set
// `local` (transaction-scoped, gone at commit or rollback) by the two
// repository functions that need it and nothing else. A signing-access,
// recipient-session or final-copy transaction never sets it, so this policy
// contributes nothing to any of them — the isolation those realms already
// prove for themselves is untouched.
//
// ── What the widened policy still means ─────────────────────────────────
//
// A transaction that HAS set `lagda.public_verification_active` can read
// every tenant's rows on these six tables. That is not a narrowing bug; it
// is the feature. Proving a document's authenticity to a stranger who holds
// only a verification ID or a participant's own email — never a login — is
// what "public verification" and "verify by email" both mean, and the WHERE
// clause on `verification_id` (or the joined chain from it) is the only
// thing that was ever going to gate which row a specific request can reach.
// The residual risk is scoped and named: only code that deliberately sets
// this ONE setting gains that visibility, and today that is exactly two
// repository functions, both re-deriving "is this really a completed
// record" from scratch rather than trusting a prior call.
//
// ── What this migration does NOT touch ──────────────────────────────────
//
// `tenant_isolation`, `signing_access_*`, `final_copy_*` and every other
// existing policy: untouched, on every table, in both directions. Every
// other table in the schema: untouched. INSERT/UPDATE/DELETE: this grants
// nothing beyond what each table already grants `lagda_app` — the new
// policy is `for select` only.

import { type Kysely, sql } from "kysely";

const PUBLIC_VERIFICATION_SETTING = "lagda.public_verification_active";

const PUBLIC_READABLE_TABLES = [
  "verification_records",
  "document_seals",
  "signing_request_completions",
  "signing_requests",
  "signing_request_recipients",
  "document_artifacts",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  // Same three properties as `lagda_current_workspace()` and every sibling
  // realm function: `true` on `current_setting` so a missing setting yields
  // NULL and the policy matches nothing (fail closed), STABLE so the planner
  // cannot cache it across transactions, and NOT SECURITY DEFINER so it
  // grants nothing by itself.
  await sql`
    create or replace function lagda_current_public_verification() returns text
    language sql stable
    as $$ select nullif(current_setting(${sql.lit(PUBLIC_VERIFICATION_SETTING)}, true), '') $$;
  `.execute(db);
  await sql`
    grant execute on function lagda_current_public_verification() to lagda_app
  `.execute(db);

  for (const table of PUBLIC_READABLE_TABLES) {
    await sql`
      create policy anonymous_verification_read on ${sql.ref(table)}
      for select
      using (lagda_current_public_verification() = 'true')
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of PUBLIC_READABLE_TABLES) {
    await sql`drop policy if exists anonymous_verification_read on ${sql.ref(table)}`
      .execute(db);
  }
  await sql`drop function if exists lagda_current_public_verification()`.execute(db);
}
