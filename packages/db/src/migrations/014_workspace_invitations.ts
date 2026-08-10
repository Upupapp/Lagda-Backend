// 014 — workspace invitations.
//
// ── An invitation is not a membership ──────────────────────────────────────
//
// A SEPARATE table, and that is the whole design. Adding `status = 'PENDING'`
// to `workspace_memberships` would put people who have not accepted anything
// into the authorization table, and then every authorization query in the
// system would need `AND status = 'ACTIVE'` — a filter one caller eventually
// forgets, in a query that then grants a tenant to someone who never replied.
//
// ── The token-lookup problem, and how it is solved without BYPASSRLS ───────
//
// Acceptance begins with a recipient who is not yet a member and has no tenant
// context. Under `tenant_isolation` alone they can see nothing, so the
// invitation cannot be resolved from its token at all.
//
// The answer is the same shape BACKEND-25 used for "list my workspaces": a
// third transaction-local setting, `lagda.invitation_digest`, and a
// `FOR SELECT` policy that matches the ONE row whose digest equals it. Holding
// the setting is holding the credential — the policy cannot list, cannot scan,
// and cannot write. No role gains BYPASSRLS and no policy is widened.

import { type Kysely, sql } from "kysely";

/** Must match `WORKSPACE_ROLES` in @lagda/contracts. */
const ROLES = [
  "owner", "member", "administrator", "template_administrator",
  "sender", "reviewer", "auditor",
] as const;

/** `WORKSPACE_ROLES` minus `owner`. Ownership is never invitable. */
const INVITABLE = ROLES.filter(role => role !== "owner");

const DIGEST_SETTING = "lagda.invitation_digest";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── 1. `member` joins the role vocabulary ──────────────────────────────────
  //
  // Not invented: `InvitationsPage.tsx` defaults its role selector to
  // `role_member` and the product's `SYSTEM_ROLE_PERMISSIONS` defines it. It is
  // the product's default invited role and had no backend equivalent.
  //
  // Drop and re-add rather than `ALTER … ADD CONSTRAINT` alongside the old one:
  // two CHECKs on one column both have to pass, so leaving the old one would
  // silently keep `member` unwritable while the new constraint looked correct.
  await sql`
    alter table workspace_memberships
    drop constraint chk_workspace_memberships_role
  `.execute(db);
  await sql`
    alter table workspace_memberships
    add constraint chk_workspace_memberships_role
    check (role in (${sql.join(ROLES.map(r => sql.lit(r)))}))
  `.execute(db);

  // ── 2. The invitations table ───────────────────────────────────────────────
  await db.schema
    .createTable("workspace_invitations")
    .addColumn("invitation_id", "varchar(64)", col => col.primaryKey())
    // First-class tenant column. An invitation belongs to exactly one workspace,
    // and that ownership is never derived through a join.
    .addColumn("workspace_id", "varchar(64)", col => col.notNull())

    // ── Invitee identity ────────────────────────────────────────────────────
    //
    // TWO columns, deliberately. `invitee_email` is what the inviter typed and
    // what the UI renders; `invitee_normalized_email` is the identity key that
    // uniqueness and the acceptance match are computed against. One column
    // would force a choice between rendering `Juan.Cruz@Example.com` back to
    // the inviter and comparing identities correctly.
    .addColumn("invitee_email", "varchar(254)", col => col.notNull())
    .addColumn("invitee_normalized_email", "varchar(254)", col => col.notNull())

    // The role acceptance will grant. `owner` is absent from the allowed set,
    // so an emailed link can never mint a second owner.
    .addColumn("requested_role", "varchar(40)", col => col.notNull())
    .addColumn("invited_by_user_id", "varchar(64)", col => col.notNull())

    // ── The credential ──────────────────────────────────────────────────────
    //
    // A DIGEST. The raw token is generated, handed to delivery, and discarded;
    // it is never written here. A database dump therefore contains no usable
    // invitation credential.
    .addColumn("token_digest", "varchar(64)", col => col.notNull())
    .addColumn("created_at", "timestamptz", col => col.notNull())
    .addColumn("expires_at", "timestamptz", col => col.notNull())

    // ── Terminal timestamps ─────────────────────────────────────────────────
    //
    // No `status` column. State is derived from these plus the clock, because
    // a status column and a set of timestamps are two representations of one
    // fact and they drift the moment a path writes one without the other.
    // `expired` in particular cannot be stored: it is a function of `now()`.
    .addColumn("accepted_at", "timestamptz")
    .addColumn("accepted_by_user_id", "varchar(64)")
    .addColumn("revoked_at", "timestamptz")
    .addColumn("declined_at", "timestamptz")
    .addColumn("superseded_at", "timestamptz")

    .addForeignKeyConstraint(
      "fk_workspace_invitations_workspace",
      ["workspace_id"], "workspaces", ["workspace_id"],
      // RESTRICT, matching every other reference in this schema. Invitation
      // history is security history: who was offered access to a tenant, by
      // whom, and whether they took it. A cascade would delete that as a side
      // effect of a retention decision nobody has made (BACKEND-55).
      builder => builder.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "fk_workspace_invitations_inviter",
      ["invited_by_user_id"], "users", ["user_id"],
      builder => builder.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "fk_workspace_invitations_accepter",
      ["accepted_by_user_id"], "users", ["user_id"],
      builder => builder.onDelete("restrict"),
    )

    .addCheckConstraint(
      "chk_workspace_invitations_role",
      sql`requested_role in (${sql.join(INVITABLE.map(r => sql.lit(r)))})`,
    )
    // 64 lowercase hex. The same shape every other credential digest in this
    // schema carries, so a truncated or unhashed value cannot be stored.
    .addCheckConstraint(
      "chk_workspace_invitations_digest_format",
      sql`token_digest ~ '^[a-f0-9]{64}$'`,
    )
    .addCheckConstraint(
      "chk_workspace_invitations_email_present",
      sql`length(btrim(invitee_email)) > 0 and length(btrim(invitee_normalized_email)) > 0`,
    )
    // The normalized column is the identity key, so it must actually be
    // normalized. Without this a caller that skipped the normalizer could store
    // a mixed-case key that no acceptance would ever match.
    .addCheckConstraint(
      "chk_workspace_invitations_email_normalized",
      sql`invitee_normalized_email = lower(invitee_normalized_email)`,
    )
    // An acceptance has an accepter and an accepter implies an acceptance.
    // Either alone is a half-written transition, and the row would then claim
    // something that did not happen.
    .addCheckConstraint(
      "chk_workspace_invitations_accepted_shape",
      sql`(accepted_at is null) = (accepted_by_user_id is null)`,
    )
    .addCheckConstraint(
      "chk_workspace_invitations_expiry_after_creation",
      sql`expires_at > created_at`,
    )
    .execute();

  // ── 3. Indexes and uniqueness ──────────────────────────────────────────────

  // The credential lookup. UNIQUE because two invitations sharing a digest
  // would make "which invitation does this token address" ambiguous, and the
  // index is what makes acceptance a single indexed read rather than a scan.
  await db.schema
    .createIndex("uq_workspace_invitations_token_digest")
    .on("workspace_invitations")
    .column("token_digest")
    .unique()
    .execute();

  // ── At most ONE live invitation per workspace and invitee ────────────────
  //
  // A PARTIAL unique index over the four terminal timestamps. It deliberately
  // does NOT mention `expires_at`: a predicate containing `now()` is not
  // immutable and PostgreSQL will not index on it, and a partial index whose
  // membership changed with the clock would be a constraint that silently
  // stopped applying.
  //
  // The consequence is that a logically EXPIRED row still occupies the slot,
  // which is correct and deliberate (§178, §179): create and resend supersede
  // the prior row inside their transaction before inserting, so the slot is
  // freed explicitly by code that meant to free it, rather than by time passing.
  await db.schema
    .createIndex("uq_workspace_invitations_active")
    .on("workspace_invitations")
    .columns(["workspace_id", "invitee_normalized_email"])
    .unique()
    .where(sql.ref("accepted_at"), "is", null)
    .where(sql.ref("revoked_at"), "is", null)
    .where(sql.ref("declined_at"), "is", null)
    .where(sql.ref("superseded_at"), "is", null)
    .execute();

  // The management list. Leads with the tenant, because every management query
  // is workspace-scoped first.
  await db.schema
    .createIndex("idx_workspace_invitations_workspace_created_at")
    .on("workspace_invitations")
    .columns(["workspace_id", "created_at desc"])
    .execute();

  // ── 4. Row Level Security ──────────────────────────────────────────────────

  await sql`
    grant select, insert, update on table workspace_invitations to lagda_app
  `.execute(db);

  // No DELETE grant, and that is the point: revoking sets a timestamp. An
  // invitation is security history — who was offered a tenant and whether they
  // took it — and the runtime role has no statement available that erases it.

  await sql`alter table workspace_invitations enable row level security`.execute(db);
  await sql`alter table workspace_invitations force row level security`.execute(db);

  // The ordinary management path: same tenant context as every other
  // workspace-owned table.
  await sql`
    create policy tenant_isolation on workspace_invitations
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);

  // ── The narrow credential path ─────────────────────────────────────────────
  //
  // Reads the transaction-local digest setting. `true` so a missing setting
  // yields NULL and the policy matches nothing — fail closed. STABLE, not
  // IMMUTABLE, because the value varies per transaction and a planner that
  // cached it across transactions would be the leak this exists to prevent.
  await sql`
    create or replace function lagda_current_invitation_digest() returns text
    language sql stable
    as $$ select nullif(current_setting(${sql.lit(DIGEST_SETTING)}, true), '') $$;
  `.execute(db);
  await sql`
    grant execute on function lagda_current_invitation_digest() to lagda_app
  `.execute(db);

  // FOR SELECT, and equality on the UNIQUE digest column.
  //
  // Those two facts together are the entire security argument. Equality on a
  // unique column matches at most ONE row, so this policy cannot enumerate,
  // cannot scan a workspace, and cannot answer any question except "the
  // invitation whose credential I already hold". `FOR SELECT` means it cannot
  // accept, revoke or supersede anything either — every write still requires
  // tenant context, which the acceptance transaction establishes only AFTER the
  // token has resolved the workspace.
  await sql`
    create policy invitation_credential_read on workspace_invitations
    for select
    using (token_digest = lagda_current_invitation_digest())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop policy if exists invitation_credential_read on workspace_invitations
  `.execute(db);
  await sql`drop policy if exists tenant_isolation on workspace_invitations`.execute(db);
  await sql`drop function if exists lagda_current_invitation_digest()`.execute(db);
  await db.schema.dropTable("workspace_invitations").ifExists().execute();

  // The role vocabulary reverts too. Any membership already holding `member`
  // would fail the narrowed constraint — correctly: this reversal is only safe
  // on a database where BACKEND-26 wrote nothing, and failing loudly is better
  // than silently leaving a row the constraint claims cannot exist.
  await sql`
    alter table workspace_memberships
    drop constraint chk_workspace_memberships_role
  `.execute(db);
  await sql`
    alter table workspace_memberships
    add constraint chk_workspace_memberships_role
    check (role in (${sql.join(
      ROLES.filter(r => r !== "member").map(r => sql.lit(r)),
    )}))
  `.execute(db);
}
