// Messages from the public website (095).
//
// ── What a visitor can do ─────────────────────────────────────────────────
//
// Send ONE of three things, with no account: ask for a demo, send a contact
// message, or ask to be told about LAGDA eNotary. Nothing else happens on
// their side: no account is created, nothing is scheduled, and joining the
// waitlist confirms no eligibility and reserves nothing.
//
// ── Who reads them ────────────────────────────────────────────────────────
//
// One account: the LAGDA owner's inbox (PUBLIC_INQUIRY_INBOX, or the plan
// approver when that is unset). It is told by email and in-app, and reads the
// message inside LAGDA with its own session. The email carries the visitor's
// name, address and what kind of message it is — never the message itself,
// which is free text from a stranger.
//
// To anyone else the reading routes do not exist (not-found, not forbidden).
//
// ── When no inbox account exists ──────────────────────────────────────────
//
// The message is still stored. Refusing a visitor because the operator has
// not configured an address would lose exactly the thing this exists to keep.

import type { Clock } from "../common/ports/index.js";
import type {
  PublicInquiryIdGenerator, PublicInquiryInboxAccount, PublicInquiryKind,
  PublicInquiryRecord, PublicInquiryRepository,
} from "../common/ports/public-inquiries.js";
import { PUBLIC_INQUIRY_KINDS } from "../common/ports/public-inquiries.js";
import type {
  NotificationIntentIdGenerator, NotificationDeliveryIdGenerator,
} from "../common/ports/notifications.js";
import type { NotificationTemplateRegistry } from "../notifications/template-registry.js";
import { createNotificationIntent } from "../notifications/create-intent.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import { ApplicationValidationError, ResourceNotFoundError } from "../common/errors/index.js";
import { normalizeEmail } from "../auth/email-identity.js";

export const PUBLIC_INQUIRY_KIND_LABELS: Readonly<Record<PublicInquiryKind, string>> = Object.freeze({
  demo: "Demo request",
  contact: "Contact message",
  waitlist: "eNotary waitlist",
});

/** How many the inbox lists at once. */
export const PUBLIC_INQUIRY_LIST_LIMIT = 200;

const LIMITS = {
  name: 120, email: 254, organization: 160, role: 120, organizationSize: 40,
  industry: 120, phone: 40, topic: 120, subject: 200, message: 4000,
} as const;

export interface PublicInquiryInput {
  readonly kind: string;
  readonly name: string;
  readonly email: string;
  readonly organization?: string | undefined;
  readonly role?: string | undefined;
  readonly organizationSize?: string | undefined;
  readonly industry?: string | undefined;
  readonly phone?: string | undefined;
  readonly topic?: string | undefined;
  readonly subject?: string | undefined;
  readonly message?: string | undefined;
  /** The visitor agreed to be contacted about this message. */
  readonly consent: boolean;
}

export interface PublicInquiryReadDependencies {
  readonly inquiries: PublicInquiryRepository;
  readonly clock: Clock;
  /** The inbox account's address, or null when none is configured. */
  readonly inboxEmail: string | null;
}

export interface PublicInquiryDependencies extends PublicInquiryReadDependencies {
  readonly ids: PublicInquiryIdGenerator;
  readonly templates: NotificationTemplateRegistry;
  readonly notificationIds: NotificationIntentIdGenerator & NotificationDeliveryIdGenerator;
}

export interface PublicInquiryReceipt {
  readonly inquiryId: string;
  readonly kind: PublicInquiryKind;
  readonly receivedAt: number;
}

function normalized(email: string | null): string | null {
  if (email === null) return null;
  const result = normalizeEmail(email);
  return result.outcome === "ok" ? result.normalized : null;
}

/** Trimmed, with runs of whitespace collapsed; null when nothing is left. */
function clean(value: string | undefined, multiline = false): string | null {
  if (value === undefined) return null;
  const text = multiline
    ? value.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
    : value.replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

function isKind(value: string): value is PublicInquiryKind {
  return (PUBLIC_INQUIRY_KINDS as readonly string[]).includes(value);
}

function validated(input: PublicInquiryInput): Omit<PublicInquiryRecord, "inquiryId" | "createdAt"> {
  if (!isKind(input.kind)) {
    throw new ApplicationValidationError("Choose what you are sending.", ["kind"]);
  }
  if (input.consent !== true) {
    throw new ApplicationValidationError("Confirm that we may contact you about this.", ["consent"]);
  }

  const fields = {
    name: clean(input.name),
    organization: clean(input.organization),
    role: clean(input.role),
    organizationSize: clean(input.organizationSize),
    industry: clean(input.industry),
    phone: clean(input.phone),
    topic: clean(input.topic),
    subject: clean(input.subject),
    message: clean(input.message, true),
  };

  const tooLong = (Object.keys(fields) as (keyof typeof fields)[])
    .filter(key => (fields[key]?.length ?? 0) > LIMITS[key]);
  if (tooLong.length > 0) {
    throw new ApplicationValidationError("Some of what you typed is too long.", tooLong);
  }
  if (fields.name === null) {
    throw new ApplicationValidationError("Enter your name.", ["name"]);
  }

  const email = clean(input.email);
  const address = email === null ? null : normalizeEmail(email);
  if (email === null || address === null || address.outcome !== "ok" || email.length > LIMITS.email) {
    throw new ApplicationValidationError("Enter a valid email address.", ["email"]);
  }

  if (input.kind === "demo" && fields.organization === null) {
    throw new ApplicationValidationError("Enter your organization.", ["organization"]);
  }
  if (input.kind !== "contact" && fields.topic === null) {
    throw new ApplicationValidationError(
      input.kind === "demo" ? "Choose what you are most interested in." : "Choose who you are asking for.",
      ["topic"]);
  }
  if (input.kind === "contact") {
    if (fields.topic === null) throw new ApplicationValidationError("Choose a category.", ["topic"]);
    if (fields.subject === null) throw new ApplicationValidationError("Enter a subject.", ["subject"]);
    if (fields.message === null || fields.message.length < 10) {
      throw new ApplicationValidationError("Write a message of at least 10 characters.", ["message"]);
    }
  }

  return { ...fields, kind: input.kind, name: fields.name, email };
}

/**
 * Stores a visitor's message and tells the inbox account, in one transaction.
 * No session: this is the one write in LAGDA a stranger can make.
 */
export async function submitPublicInquiry(
  input: PublicInquiryInput,
  deps: PublicInquiryDependencies,
): Promise<PublicInquiryReceipt> {
  const fields = validated(input);
  const now = deps.clock.now();
  const inquiry: PublicInquiryRecord = { ...fields, inquiryId: deps.ids.nextPublicInquiryId(), createdAt: now };

  const inboxEmail = normalized(deps.inboxEmail);
  const inbox = inboxEmail === null ? null : await deps.inquiries.accountByNormalizedEmail(inboxEmail);

  if (inbox === null) {
    await deps.inquiries.insert(inquiry);
  } else {
    await deps.inquiries.transact(inbox.userId, async uow => {
      await uow.insert(inquiry);
      await createNotificationIntent({
        notifications: uow.notifications,
        templates: deps.templates,
        ids: deps.notificationIds,
        clock: deps.clock,
      })({
        notificationType: "PUBLIC_INQUIRY_RECEIVED",
        sourceId: inquiry.inquiryId,
        scope: { kind: "GLOBAL_USER", userId: inbox.userId },
        audience: { kind: "USER", userId: inbox.userId },
        destination: inbox.email,
        templateInput: {
          recipientName: inbox.displayName,
          kindLabel: PUBLIC_INQUIRY_KIND_LABELS[inquiry.kind],
          senderName: inquiry.name,
          senderEmail: inquiry.email,
          inquiryId: inquiry.inquiryId,
        },
      }, uow.transaction);
    });
  }

  return { inquiryId: inquiry.inquiryId, kind: inquiry.kind, receivedAt: now };
}

// ── Reading: the inbox account only ───────────────────────────────────────

async function inboxAccount(deps: PublicInquiryReadDependencies): Promise<PublicInquiryInboxAccount | null> {
  const email = normalized(deps.inboxEmail);
  return email === null ? null : deps.inquiries.accountByNormalizedEmail(email);
}

/** Whether this account reads the website's messages. */
export async function readsPublicInquiries(
  actor: AuthenticatedActor, deps: PublicInquiryReadDependencies,
): Promise<boolean> {
  const inbox = await inboxAccount(deps);
  return inbox !== null && inbox.userId === actor.userId;
}

async function requireInbox(actor: AuthenticatedActor, deps: PublicInquiryReadDependencies): Promise<void> {
  // Not-found rather than forbidden: nobody else learns the inbox exists.
  if (!(await readsPublicInquiries(actor, deps))) throw new ResourceNotFoundError("PublicInquiry");
}

export interface PublicInquiryInbox {
  readonly inquiries: readonly PublicInquiryRecord[];
  readonly counts: Readonly<Record<PublicInquiryKind, number>>;
}

export async function listPublicInquiries(
  actor: AuthenticatedActor,
  input: { readonly kind?: string | undefined },
  deps: PublicInquiryReadDependencies,
): Promise<PublicInquiryInbox> {
  await requireInbox(actor, deps);
  if (input.kind !== undefined && !isKind(input.kind)) {
    throw new ApplicationValidationError("That is not a kind of message.", ["kind"]);
  }
  const [inquiries, counts] = await Promise.all([
    deps.inquiries.list({ kind: input.kind ?? null, limit: PUBLIC_INQUIRY_LIST_LIMIT }),
    deps.inquiries.countByKind(),
  ]);
  return { inquiries, counts };
}

export async function getPublicInquiry(
  actor: AuthenticatedActor,
  inquiryId: string,
  deps: PublicInquiryReadDependencies,
): Promise<PublicInquiryRecord> {
  await requireInbox(actor, deps);
  const inquiry = await deps.inquiries.find(inquiryId);
  if (inquiry === null) throw new ResourceNotFoundError("PublicInquiry");
  return inquiry;
}
