// User profile and personal preferences.
//
// ── Why these live on `users` and not in a `user_profiles` table ───────────
//
// Seven small, single-valued, account-bound columns with the same lifetime as
// the account. A separate table would add a join to every `/me` read and a
// second row to keep in step, and would buy nothing: there is no independent
// lifecycle, no cardinality above one, and no different access pattern.
//
// A profile table is right when profile data is large, versioned, or reachable
// by parties who must not see the account row. None of that is true here (§11).
//
// ── What is deliberately NOT here ─────────────────────────────────────────
//
// No avatar column: the product's upload previews a local object URL and
// persists nothing, so a column would be storage for a feature that does not
// exist. No phone: nothing collects one, and there is no SMS MFA to justify
// asking. No `preferences jsonb` bag: explicit typed columns say what the
// product actually supports, and a bag is how "settings" becomes a place to
// avoid deciding who owns a field (§112, §113).
//
// Every column below appears in a real settings form. See
// ACCOUNT_PRODUCT_INVENTORY.md.

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Profile ─────────────────────────────────────────────────────────────
  //
  // `display_name` already exists from registration. These are the remaining
  // fields `ProfilePage` edits.
  //
  // Nullable, because the registration form does not ask for them and a user
  // who has never opened the profile page genuinely has no job title. Defaulting
  // to '' would make "not provided" and "deliberately blank" the same value.
  await sql`
    alter table users
      add column full_name              varchar(200),
      add column job_title              varchar(200),
      add column department             varchar(200),
      add column preferred_sender_name  varchar(200)
  `.execute(db);

  // ── Preferences ─────────────────────────────────────────────────────────
  //
  // Explicit columns with CHECK-constrained vocabularies for the closed sets.
  // A value the product cannot render is a value that should not be storable.
  await sql`
    alter table users
      -- An IANA identifier such as 'Asia/Manila'. NOT an offset: offsets are
      -- wrong twice a year for any zone with daylight saving, and a stored
      -- '+08:00' cannot be corrected without knowing the zone it came from.
      add column timezone     varchar(64),
      -- BCP 47. Bounded, and validated in the application against what the
      -- product actually offers.
      add column locale       varchar(35),
      add column language     varchar(35),
      add column date_format  varchar(16),
      add column time_format  varchar(4),
      add column number_format varchar(16),
      add column appearance   varchar(8),
      add column density      varchar(16),
      add column document_list_view varchar(8)
  `.execute(db);

  await sql`
    alter table users
      add constraint user_date_format_known
        check (date_format is null
               or date_format in ('MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD')),
      add constraint user_time_format_known
        check (time_format is null or time_format in ('12h', '24h')),
      add constraint user_number_format_known
        check (number_format is null
               or number_format in ('comma-dot', 'dot-comma', 'space-dot')),
      add constraint user_appearance_known
        check (appearance is null or appearance in ('system', 'light', 'dark')),
      add constraint user_density_known
        check (density is null or density in ('comfortable', 'compact')),
      add constraint user_document_list_view_known
        check (document_list_view is null
               or document_list_view in ('table', 'grid'))
  `.execute(db);

  // When the profile was last edited. Distinct from `created_at`, and set only
  // by the profile use case — not a trigger, so nothing outside that path can
  // claim a profile edit happened (§26).
  await sql`alter table users add column profile_updated_at timestamptz`.execute(db);

  // ── Grants ──────────────────────────────────────────────────────────────
  //
  // `users` already carries select/insert/update for lagda_app, and no DELETE.
  // Nothing changes: adding columns does not widen what the runtime role may
  // do, and column-level grants are deliberately not used — the boundary that
  // stops profile code writing `password_hash` is the REPOSITORY, which offers
  // no method that can, not a database privilege that would also block the
  // legitimate security flows sharing this table (§102).
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table users
      drop constraint if exists user_date_format_known,
      drop constraint if exists user_time_format_known,
      drop constraint if exists user_number_format_known,
      drop constraint if exists user_appearance_known,
      drop constraint if exists user_density_known,
      drop constraint if exists user_document_list_view_known
  `.execute(db);
  await sql`
    alter table users
      drop column if exists full_name,
      drop column if exists job_title,
      drop column if exists department,
      drop column if exists preferred_sender_name,
      drop column if exists timezone,
      drop column if exists locale,
      drop column if exists language,
      drop column if exists date_format,
      drop column if exists time_format,
      drop column if exists number_format,
      drop column if exists appearance,
      drop column if exists density,
      drop column if exists document_list_view,
      drop column if exists profile_updated_at
  `.execute(db);
}
