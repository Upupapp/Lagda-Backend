// Workflow-template persistence, bound to ONE workspace and ONE transaction.
//
// No method takes a workspace argument — the same rule every other scoped
// repository here follows. The scope comes from the unit of work, and
// migration 058's row-level security enforces it in the database as well, so
// a repository bug cannot reach another tenant's row even if a query forgot
// its filter.

import type { WorkspaceId, UserId, DocumentId } from "@lagda/contracts";
import type {
  WorkflowRoutingMode, WorkflowRoleSlot, WorkflowCompletionSettings,
} from "@lagda/contracts";
import type { ArtifactId } from "./evidence.js";

/** The stored template, as the application reads it. */
export interface WorkflowTemplateRecord {
  readonly workflowTemplateId: string;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly routingMode: WorkflowRoutingMode;
  /**
   * Ordered slots, already parsed AND validated.
   *
   * The column is JSONB, so PostgreSQL guarantees only that it is a non-empty
   * array. The repository parses it; the use case validates every slot's shape
   * before anybody acts on it (see `WorkflowTemplateMalformedError`). A record
   * handed out of this port has been through both.
   */
  readonly roleSlots: readonly WorkflowRoleSlot[];
  readonly completionSettings: WorkflowCompletionSettings;
  readonly createdBy: UserId;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * 059. `null` until a document is attached — the routing shape alone is
   * still a complete, useful template. Both fields are set together or not
   * at all; `attachWorkflowTemplateDocument` is the only path that sets them,
   * and it verifies the pair before writing (see that use case).
   */
  readonly documentId: DocumentId | null;
  readonly sourceArtifactId: ArtifactId | null;
}

export interface NewWorkflowTemplate {
  readonly workflowTemplateId: string;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly routingMode: WorkflowRoutingMode;
  readonly roleSlots: readonly WorkflowRoleSlot[];
  readonly completionSettings: WorkflowCompletionSettings;
  readonly createdBy: UserId;
  readonly createdAt: number;
}

export interface WorkflowTemplateUpdate {
  readonly name: string;
  readonly routingMode: WorkflowRoutingMode;
  readonly roleSlots: readonly WorkflowRoleSlot[];
  readonly completionSettings: WorkflowCompletionSettings;
  readonly updatedAt: number;
}

/**
 * Raw JSONB, exactly as the column holds it.
 *
 * The repository hands back `unknown` for the two JSON columns rather than
 * asserting a shape it cannot check. Parsing and validation belong to the use
 * case, which owns the error the caller sees.
 */
export interface RawWorkflowTemplateRow {
  readonly workflowTemplateId: string;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly routingMode: string;
  readonly roleSlots: unknown;
  readonly completionSettings: unknown;
  readonly createdBy: UserId;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly documentId: DocumentId | null;
  readonly sourceArtifactId: ArtifactId | null;
}

export interface ScopedWorkflowTemplateRepository {
  insert(template: NewWorkflowTemplate): Promise<void>;
  /** One template of this workspace, or null. Raw — the caller validates. */
  find(workflowTemplateId: string): Promise<RawWorkflowTemplateRow | null>;
  /** Every template in the workspace, most recently changed first. */
  list(): Promise<readonly RawWorkflowTemplateRow[]>;
  /** False when no row matched, so "gone" is distinguishable from "changed". */
  update(workflowTemplateId: string, update: WorkflowTemplateUpdate): Promise<boolean>;
  /** False when no row matched. */
  remove(workflowTemplateId: string): Promise<boolean>;
  /**
   * Whether another template in this workspace already holds this name.
   *
   * Case- and whitespace-insensitive, matching the unique index. Asked so the
   * use case can answer with a named conflict instead of surfacing a
   * constraint violation as a 500 — the index remains the actual guarantee.
   */
  nameExists(name: string, exceptId: string | null): Promise<boolean>;
  /**
   * Attaches a document and its exact artifact. `false` when no row matched.
   *
   * Both columns are written together — this is the only method that ever
   * sets either one, which is what lets `WorkflowTemplateUpdate` (the
   * name/routing/slots write path) stay silent about documents entirely: a
   * PUT to the template never touches its attached document as a side
   * effect.
   */
  attachDocument(
    workflowTemplateId: string,
    document: { documentId: DocumentId; artifactId: ArtifactId; updatedAt: number },
  ): Promise<boolean>;
  /** Clears both columns. `false` when no row matched. */
  detachDocument(workflowTemplateId: string, updatedAt: number): Promise<boolean>;
}

export interface WorkflowTemplateIdGenerator {
  nextWorkflowTemplateId: () => string;
}
