// Signing recipient persistence.
//
// Every query is scoped by workspace AND preparation. Tenant scope alone is not
// enough: two preparations in one workspace are both visible to RLS, and only
// the parent predicate stops a recipient of one being read through the other.

import type { Selectable, Transaction } from "kysely";
import type { ContactId, RecipientType, WorkspaceId } from "@lagda/contracts";
import { RECIPIENT_TYPES } from "@lagda/contracts";
import type { RecipientEmailKey } from "@lagda/core";
import type {
  ScopedRecipientRepository, RecipientRecord, NewRecipient,
  RecipientId, RecipientUpdate, PreparationId,
} from "@lagda/application";
import type { Database, PreparationRecipientsTable } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";

type RecipientRow = Selectable<PreparationRecipientsTable>;

/** Validated rather than cast, so a dropped CHECK cannot pass silently. */
function toRecipientType(value: string): RecipientType {
  const type = RECIPIENT_TYPES.find(candidate => candidate === value);
  if (type === undefined) {
    throw new PersistenceMappingError(
      "preparation_recipients", "recipient_type", `"${value}" is not a recipient type.`);
  }
  return type;
}

function toRecord(row: RecipientRow): RecipientRecord {
  return {
    recipientId: row.recipient_id as RecipientId,
    workspaceId: row.workspace_id as WorkspaceId,
    preparationId: row.preparation_id as PreparationId,
    sourceContactId: row.source_contact_id as ContactId | null,
    name: row.name,
    email: row.email,
    emailKey: row.normalized_recipient_email as RecipientEmailKey,
    organization: row.organization,
    type: toRecipientType(row.recipient_type),
    isRequired: row.is_required,
    orderIndex: row.order_index,
    routingOrder: row.routing_order,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

export function createScopedRecipientRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedRecipientRepository {
  const scoped = (preparationId: PreparationId) =>
    trx.selectFrom("preparation_recipients")
      .where("workspace_id", "=", scope)
      .where("preparation_id", "=", preparationId);

  return {
    async insert(recipient: NewRecipient): Promise<void> {
      if (recipient.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError("Recipient", scope, recipient.workspaceId);
      }
      try {
        // Every column named. A spread would carry any property the record
        // gained later, including computed ones with no column.
        await trx.insertInto("preparation_recipients").values({
          recipient_id: recipient.recipientId,
          workspace_id: recipient.workspaceId,
          preparation_id: recipient.preparationId,
          source_contact_id: recipient.sourceContactId,
          name: recipient.name,
          email: recipient.email,
          normalized_recipient_email: recipient.emailKey,
          organization: recipient.organization,
          recipient_type: recipient.type,
          is_required: recipient.isRequired,
          order_index: recipient.orderIndex,
          routing_order: recipient.routingOrder,
          created_at: new Date(recipient.createdAt),
          updated_at: new Date(recipient.createdAt),
        }).execute();
      } catch (error) {
        // A unique violation here is the duplicate rule firing. The use case
        // translates it; the constraint is what makes it race-safe.
        throw translatePersistenceError(error);
      }
    },

    async find(input) {
      const row = await scoped(input.preparationId)
        .selectAll()
        .where("recipient_id", "=", input.recipientId)
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async list(preparationId) {
      const rows = await scoped(preparationId)
        .selectAll()
        // Display order, with the id as a tie-breaker so two recipients added
        // in one transaction never swap between reads.
        .orderBy("order_index", "asc")
        .orderBy("recipient_id", "asc")
        .execute();
      return rows.map(toRecord);
    },

    async update(input) {
      // Only the keys the caller supplied. Assigning `undefined` wholesale
      // would have Kysely write NULL over columns nobody asked to change, and
      // the difference between "leave it" and "clear it" is the whole reason
      // `RecipientUpdate` distinguishes an absent key from an explicit null.
      const patch: RecipientUpdate = input.patch;
      const values: Record<string, unknown> = { updated_at: new Date(input.now) };
      if (patch.name !== undefined) values["name"] = patch.name;
      if (patch.email !== undefined) values["email"] = patch.email;
      if (patch.emailKey !== undefined) {
        values["normalized_recipient_email"] = patch.emailKey;
      }
      if (patch.organization !== undefined) values["organization"] = patch.organization;
      if (patch.type !== undefined) values["recipient_type"] = patch.type;
      if (patch.isRequired !== undefined) values["is_required"] = patch.isRequired;
      if (patch.orderIndex !== undefined) values["order_index"] = patch.orderIndex;
      if (patch.routingOrder !== undefined) values["routing_order"] = patch.routingOrder;

      try {
        const result = await trx.updateTable("preparation_recipients")
          .set(values)
          .where("workspace_id", "=", scope)
          .where("preparation_id", "=", input.preparationId)
          .where("recipient_id", "=", input.recipientId)
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async remove(input) {
      try {
        const result = await trx.deleteFrom("preparation_recipients")
          .where("workspace_id", "=", scope)
          .where("preparation_id", "=", input.preparationId)
          .where("recipient_id", "=", input.recipientId)
          .executeTakeFirst();
        return Number(result.numDeletedRows) === 1;
      } catch (error) {
        // The assignment FK is RESTRICT, so a field still pointing here makes
        // this a constraint violation. The use case checks first for a better
        // message; this is the backstop that makes the check race-safe.
        throw translatePersistenceError(error);
      }
    },

    async countAssignedFields(input) {
      const counted = await trx.selectFrom("preparation_fields")
        .select(eb => eb.fn.countAll<string>().as("total"))
        .where("workspace_id", "=", scope)
        .where("preparation_id", "=", input.preparationId)
        .where("recipient_id", "=", input.recipientId)
        .executeTakeFirstOrThrow();
      return Number(counted.total);
    },
  };
}
