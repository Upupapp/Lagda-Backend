// Ports for messages from the public website (095): a demo request, a contact
// message, an eNotary waitlist sign-up.
//
// A table with no tenant policy and no owner: its rows are written by
// visitors with no account. Reading is the application's decision (the LAGDA
// owner's account only), never something a workspace transaction can reach.

import type { UserId } from "@lagda/contracts";
import type { NotificationRepository } from "./notifications.js";

export const PUBLIC_INQUIRY_KINDS = ["demo", "contact", "waitlist"] as const;
export type PublicInquiryKind = (typeof PUBLIC_INQUIRY_KINDS)[number];

export interface PublicInquiryRecord {
  readonly inquiryId: string;
  readonly kind: PublicInquiryKind;
  readonly name: string;
  readonly email: string;
  readonly organization: string | null;
  readonly role: string | null;
  readonly organizationSize: string | null;
  readonly industry: string | null;
  readonly phone: string | null;
  /** Demo: the interest. Contact: the category. Waitlist: who is asking. */
  readonly topic: string | null;
  readonly subject: string | null;
  readonly message: string | null;
  readonly createdAt: number;
}

/** The account that reads the inbox. */
export interface PublicInquiryInboxAccount {
  readonly userId: UserId;
  readonly email: string;
  readonly displayName: string;
}

/** The insert that travels with its notice, on ONE transaction. */
export interface PublicInquiryUnitOfWork {
  insert(inquiry: PublicInquiryRecord): Promise<void>;
  readonly notifications: NotificationRepository;
  readonly transaction: unknown;
}

export interface PublicInquiryRepository {
  /** Stores an inquiry with no notice (no inbox account exists). */
  insert(inquiry: PublicInquiryRecord): Promise<void>;
  find(inquiryId: string): Promise<PublicInquiryRecord | null>;
  /** Newest first. */
  list(input: { readonly kind: PublicInquiryKind | null; readonly limit: number }): Promise<readonly PublicInquiryRecord[]>;
  countByKind(): Promise<Readonly<Record<PublicInquiryKind, number>>>;
  account(userId: UserId): Promise<PublicInquiryInboxAccount | null>;
  accountByNormalizedEmail(normalizedEmail: string): Promise<PublicInquiryInboxAccount | null>;
  /**
   * A transaction whose notice is addressed to `noticeUserId`: the notice row
   * is that account's own.
   */
  transact<T>(noticeUserId: UserId, operation: (uow: PublicInquiryUnitOfWork) => Promise<T>): Promise<T>;
}

export interface PublicInquiryIdGenerator {
  nextPublicInquiryId(): string;
}
