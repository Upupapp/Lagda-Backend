// 081 — the outcome-block field types: `review-block` (Reviewed over Name) and
// `approval-block` (Approved over Name).
//
// Exactly 076's shape. Three tables close their `field_type` over the
// vocabulary with a CHECK, each restating the list verbatim rather than
// importing it (017, 019, 060 — a migration must not change meaning when a
// later constant does). Each is widened here by two members, and nothing is
// renamed or removed, so every row that satisfied the old constraint
// satisfies the new one.
//
// `signing_field_values.field_type` carries no CHECK (023), so it needs
// nothing: a review block's value is stored exactly as `date-signed`'s is — an
// instant — and an approval block stores no value at all, its outcome being
// the approver's workflow row (069). Which recipient type may HOLD each is a
// rule of the domain (`mayHoldFieldType`), not of this schema: the recipient's
// type lives on another row, and a CHECK cannot see it.

import { type Kysely, sql } from "kysely";

const BEFORE = [
  "signature", "initials", "date-signed", "text", "checkbox",
  "full-name", "email", "title", "company", "signature-block",
] as const;
const AFTER = [...BEFORE, "review-block", "approval-block"] as const;

const CONSTRAINTS = [
  { table: "preparation_fields", name: "preparation_fields_type_check" },
  { table: "signing_request_fields", name: "signing_request_fields_type_check" },
  { table: "workflow_template_fields", name: "workflow_template_fields_type_check" },
] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

async function replace(db: Kysely<unknown>, types: readonly string[]): Promise<void> {
  for (const { table, name } of CONSTRAINTS) {
    await sql`
      alter table ${sql.table(table)}
        drop constraint ${sql.ref(name)},
        add constraint ${sql.ref(name)} check (field_type in (${inList(types)}))
    `.execute(db);
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await replace(db, AFTER);
}

/** Fails, deliberately, while any `review-block` or `approval-block` field still exists. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await replace(db, BEFORE);
}
