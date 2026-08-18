// PostgreSQL adapter for the notification substrate.
//
// Every statement runs on the transaction handed in, never the pool — RLS
// context lives on the transaction's connection, and a pooled read would run
// with no tenant context and see nothing.
//
// ── The one interesting query ──────────────────────────────────────────────
//
// `createIfAbsent` is insert-on-conflict-do-nothing followed by a read, not
// read-then-insert. Two workers handed the same replayed event both execute
// this concurrently; exactly one insert wins and both return the same intent
// (S240). A check-then-write would have both read "absent" and both insert,
// producing two logical notifications for one fact — and passing every
// single-threaded test on the way in.

import type { Selectable, Transaction } from "kysely";
import type {
  NotificationRepository, NewNotificationIntent, NotificationIntentRecord,
  NotificationDeliveryRecord, NotificationCreationResult, NotificationScope,
  NotificationAudience, NotificationSecretRef, NotificationIntentId,
  NotificationDeliveryId, NotificationType, NotificationChannel,
  NotificationSourceKind, NotificationDeliveryState, NotificationFailureCode,
  NotificationLocale, NotificationTemplateKey, NotificationTemplateInput,
  SigningRequestRecipientId, SealedDeliverySecret,
} from "@lagda/application";
import type { WorkspaceId, UserId, WorkspaceInvitationId } from "@lagda/contracts";
import type {
  Database, NotificationIntentsTable, NotificationDeliveriesTable,
} from "../schema/index.js";
import { translatePersistenceError } from "../errors.js";
import { PersistenceMappingError } from "../mapping/index.js";

type Trx = Transaction<Database>;

// ── Mapping ──────────────────────────────────────────────────────────────────

/**
 * Rebuilds the scope discriminant from two nullable columns.
 *
 * The CHECK guarantees exactly one is set, so the `else` is unreachable — and
 * it throws rather than defaulting to a workspace, because a global row silently
 * read as workspace-scoped is precisely the tenant confusion the split exists
 * to prevent.
 */
function toScope(
  workspaceId: string | null,
  userId: string | null,
  table: string,
): NotificationScope {
  if (workspaceId !== null) {
    return { kind: "WORKSPACE", workspaceId: workspaceId as WorkspaceId };
  }
  if (userId !== null) return { kind: "GLOBAL_USER", userId: userId as UserId };
  throw new PersistenceMappingError(table, "workspace_id",
    "Row has neither workspace_id nor user_id; the scope CHECK should forbid it.");
}

function toAudience(row: Selectable<NotificationIntentsTable>): NotificationAudience {
  switch (row.audience_kind) {
    case "USER":
      if (row.audience_user_id === null) break;
      return { kind: "USER", userId: row.audience_user_id as UserId };
    case "SIGNING_REQUEST_RECIPIENT":
      if (row.audience_recipient_id === null) break;
      return {
        kind: "SIGNING_REQUEST_RECIPIENT",
        signingRequestRecipientId:
          row.audience_recipient_id as SigningRequestRecipientId,
      };
    case "WORKSPACE_INVITEE":
      if (row.audience_invitation_id === null) break;
      return {
        kind: "WORKSPACE_INVITEE",
        invitationId: row.audience_invitation_id as WorkspaceInvitationId,
      };
    default:
      break;
  }
  throw new PersistenceMappingError("notification_intents", "audience_kind",
    `Audience kind ${row.audience_kind} does not match its populated column.`);
}

function toSecretRef(
  row: Selectable<NotificationIntentsTable>,
): NotificationSecretRef | undefined {
  if (row.secret_ref_kind === null) return undefined;
  if (row.secret_ref_kind === "SEALED") {
    if (row.sealed_secret === null || row.sealed_key_version === null) {
      throw new PersistenceMappingError("notification_intents", "sealed_secret",
        "SEALED secret reference is missing its ciphertext or key version.");
    }
    return {
      kind: "SEALED",
      sealed: row.sealed_secret as SealedDeliverySecret,
      keyVersion: row.sealed_key_version,
    };
  }
  if (row.challenge_id === null) {
    throw new PersistenceMappingError("notification_intents", "challenge_id",
      "CHALLENGE secret reference is missing its challenge id.");
  }
  return { kind: "CHALLENGE", challengeId: row.challenge_id };
}

function toIntent(row: Selectable<NotificationIntentsTable>): NotificationIntentRecord {
  const secretRef = toSecretRef(row);
  return {
    notificationIntentId: row.notification_intent_id as NotificationIntentId,
    scope: toScope(row.workspace_id, row.user_id, "notification_intents"),
    notificationType: row.notification_type as NotificationType,
    source: {
      kind: row.source_kind as NotificationSourceKind,
      sourceId: row.source_id,
    },
    audience: toAudience(row),
    template: {
      key: row.template_key as NotificationTemplateKey,
      version: row.template_version,
    },
    locale: row.locale as NotificationLocale,
    templateInput: row.template_input as NotificationTemplateInput,
    ...(secretRef === undefined ? {} : { secretRef }),
    createdAt: row.created_at.getTime(),
  };
}

function toDelivery(
  row: Selectable<NotificationDeliveriesTable>,
): NotificationDeliveryRecord {
  return {
    notificationDeliveryId: row.notification_delivery_id as NotificationDeliveryId,
    notificationIntentId: row.notification_intent_id as NotificationIntentId,
    channel: row.channel as NotificationChannel,
    destination: row.destination,
    state: row.state as NotificationDeliveryState,
    ...(row.failure_code === null
      ? {}
      : { failureCode: row.failure_code as NotificationFailureCode }),
    createdAt: row.created_at.getTime(),
  };
}

const scopeColumns = (scope: NotificationScope) =>
  scope.kind === "WORKSPACE"
    ? { workspace_id: scope.workspaceId as string, user_id: null }
    : { workspace_id: null, user_id: scope.userId as string };

const audienceColumns = (audience: NotificationAudience) => ({
  audience_kind: audience.kind,
  audience_user_id: audience.kind === "USER" ? (audience.userId as string) : null,
  audience_recipient_id:
    audience.kind === "SIGNING_REQUEST_RECIPIENT"
      ? (audience.signingRequestRecipientId as string)
      : null,
  audience_invitation_id:
    audience.kind === "WORKSPACE_INVITEE" ? (audience.invitationId as string) : null,
});

const secretColumns = (secretRef: NotificationSecretRef | undefined) => {
  if (secretRef === undefined) {
    return {
      secret_ref_kind: null, sealed_secret: null,
      sealed_key_version: null, challenge_id: null,
    };
  }
  return secretRef.kind === "SEALED"
    ? {
        secret_ref_kind: "SEALED", sealed_secret: secretRef.sealed as string,
        sealed_key_version: secretRef.keyVersion, challenge_id: null,
      }
    : {
        secret_ref_kind: "CHALLENGE", sealed_secret: null,
        sealed_key_version: null, challenge_id: secretRef.challengeId,
      };
};

// ── Repository ───────────────────────────────────────────────────────────────

export function createNotificationRepository(trx: Trx): NotificationRepository {
  const readIntentBySource = async (
    sourceKind: string,
    sourceId: string,
    notificationType: string,
  ): Promise<Selectable<NotificationIntentsTable> | undefined> =>
    trx.selectFrom("notification_intents").selectAll()
      .where("source_kind", "=", sourceKind)
      .where("source_id", "=", sourceId)
      .where("notification_type", "=", notificationType)
      .executeTakeFirst();

  const readDeliveryByIntent = async (
    intentId: string,
    channel: string,
  ): Promise<Selectable<NotificationDeliveriesTable> | undefined> =>
    trx.selectFrom("notification_deliveries").selectAll()
      .where("notification_intent_id", "=", intentId)
      .where("channel", "=", channel)
      .executeTakeFirst();

  return {
    async createIfAbsent(input: NewNotificationIntent): Promise<NotificationCreationResult> {
      const { createdAt } = input;
      const intentId = input.notificationIntentId;
      const deliveryId = input.notificationDeliveryId;

      try {
        // Insert-or-conflict on the logical key. The row count tells us which
        // of the two happened without a second query racing the first.
        const insert = await trx.insertInto("notification_intents")
          .values({
            notification_intent_id: intentId as string,
            ...scopeColumns(input.scope),
            notification_type: input.notificationType,
            source_kind: input.source.kind,
            source_id: input.source.sourceId,
            ...audienceColumns(input.audience),
            template_key: input.template.key,
            template_version: input.template.version,
            locale: input.locale,
            template_input: JSON.stringify(input.templateInput),
            ...secretColumns(input.secretRef),
            created_at: new Date(createdAt),
          })
          .onConflict(oc => oc
            .columns(["source_kind", "source_id", "notification_type"]).doNothing())
          .executeTakeFirst();

        const created = Number(insert.numInsertedOrUpdatedRows ?? 0n) === 1;

        if (created) {
          await trx.insertInto("notification_deliveries")
            .values({
              notification_delivery_id: deliveryId as string,
              notification_intent_id: intentId as string,
              ...scopeColumns(input.scope),
              channel: input.channel,
              destination: input.destination,
              // The ONLY state a delivery is created in. Everything else
              // requires something to have happened, and nothing has.
              state: "PENDING",
              failure_code: null,
              created_at: new Date(createdAt),
            })
            .execute();
        }

        const intentRow = created
          ? undefined
          : await readIntentBySource(
              input.source.kind, input.source.sourceId, input.notificationType);

        const resolvedIntentId = intentRow?.notification_intent_id ?? intentId;
        const deliveryRow = await readDeliveryByIntent(resolvedIntentId, input.channel);

        if (deliveryRow === undefined) {
          // The intent exists — this transaction wrote it, or found it. A
          // delivery must accompany it, because both are written together and
          // nothing deletes one.
          throw new PersistenceMappingError("notification_deliveries",
            "notification_intent_id",
            "Intent exists with no delivery for its channel.");
        }

        if (created) {
          const written = await trx.selectFrom("notification_intents").selectAll()
            .where("notification_intent_id", "=", intentId as string)
            .executeTakeFirstOrThrow();
          return {
            outcome: "CREATED",
            intent: toIntent(written),
            delivery: toDelivery(deliveryRow),
          };
        }

        if (intentRow === undefined) {
          throw new PersistenceMappingError("notification_intents", "source_id",
            "Insert conflicted but the conflicting row is not readable.");
        }
        return {
          outcome: "ALREADY_EXISTS",
          intent: toIntent(intentRow),
          delivery: toDelivery(deliveryRow),
        };
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async findIntentById(notificationIntentId) {
      const row = await trx.selectFrom("notification_intents").selectAll()
        .where("notification_intent_id", "=", notificationIntentId as string)
        .executeTakeFirst();
      return row === undefined ? null : toIntent(row);
    },

    async findDeliveryById(notificationDeliveryId) {
      const row = await trx.selectFrom("notification_deliveries").selectAll()
        .where("notification_delivery_id", "=", notificationDeliveryId as string)
        .executeTakeFirst();
      return row === undefined ? null : toDelivery(row);
    },

    async findPendingDeliveries(olderThan, limit) {
      // Oldest first: reconciliation should recover the message that has been
      // waiting longest, not the one most recently orphaned.
      const rows = await trx.selectFrom("notification_deliveries").selectAll()
        .where("state", "=", "PENDING")
        .where("created_at", "<=", new Date(olderThan))
        .orderBy("created_at", "asc")
        .limit(limit)
        .execute();
      return rows.map(toDelivery);
    },

    async stopPendingDelivery(notificationDeliveryId, state, failureCode) {
      // Conditional on the row still being PENDING, in one statement. Reading
      // the state and then updating would let a worker claim the row in
      // between and have the cancellation overwrite a live transport state.
      const result = await trx.updateTable("notification_deliveries")
        .set({ state, failure_code: failureCode })
        .where("notification_delivery_id", "=", notificationDeliveryId as string)
        .where("state", "=", "PENDING")
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n) === 1;
    },
  };
}
