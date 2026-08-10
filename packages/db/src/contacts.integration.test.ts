// Contacts against REAL PostgreSQL, as the RUNTIME role.
//
// As the runtime role (`lagda_app`), not as the table owner — because an owner
// bypasses RLS unless FORCE is set, and a suite that connected as `postgres`
// would pass while production leaked.
//
// Three things can only be proved here and nowhere else:
//
//   1. Tenant isolation is enforced by PostgreSQL, not by a WHERE clause the
//      repository happens to include.
//   2. The runtime role genuinely CANNOT delete a contact. The application
//      omitting the method is a convention; the missing grant is enforcement.
//   3. The check constraints, the sort ordering and the LIKE escaping behave
//      the way the fakes claim they do.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  ContactId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import type { ContactEmailKey } from "@lagda/core";
import { createDatabase, type LagdaDatabase } from "./client/index.js";
import { loadDatabaseConfig } from "./config/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-10T07:00:00.000Z");
const USER = "usr_contacts" as UserId;
const WS_A = "ws_contacts_a" as WorkspaceId;
const WS_B = "ws_contacts_b" as WorkspaceId;

const key = (value: string): ContactEmailKey =>
  value.toLocaleLowerCase("en-US") as ContactEmailKey;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("contacts (RLS, runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
    await sql`alter role lagda_app with login password 'lagda_app_test'`.execute(owner.db);
    const url = new URL(process.env["DATABASE_TEST_URL"] ?? "");
    url.username = "lagda_app";
    url.password = "lagda_app_test";
    app = createDatabase(loadDatabaseConfig({ DATABASE_URL: url.toString() }));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);
    for (const [id, member] of [[WS_A, "mem_ca"], [WS_B, "mem_cb"]] as const) {
      await tx.runForWorkspace(id, async uow => {
        await uow.workspaces.insert({ workspaceId: id, name: `WS ${id}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: member as WorkspaceMemberId, workspaceId: id,
          userId: USER, role: "owner", createdAt: AT,
        });
      });
    }
  });

  const insert = (
    workspaceId: WorkspaceId,
    contactId: string,
    over: Partial<{
      name: string; email: string; phone: string | null;
      organization: string | null; title: string | null; createdAt: number;
    }> = {},
  ) => {
    const tx = createTransactionManager(app.db);
    const email = over.email ?? `${contactId}@example.com`;
    return tx.runForWorkspace(workspaceId, uow => uow.contacts.insert({
      contactId: contactId as ContactId,
      workspaceId,
      name: over.name ?? contactId,
      email,
      emailKey: key(email),
      phone: over.phone ?? null,
      organization: over.organization ?? null,
      title: over.title ?? null,
      createdAt: over.createdAt ?? AT,
    }));
  };

  // ── Tenant isolation ──────────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("hides another workspace's contact entirely", async () => {
      await insert(WS_A, "con_a1");
      const tx = createTransactionManager(app.db);

      const fromB = await tx.runForWorkspace(WS_B,
        uow => uow.contacts.findById("con_a1" as ContactId));
      expect(fromB).toBeNull();

      const listedFromB = await tx.runForWorkspace(WS_B, uow => uow.contacts.list({
        search: null, state: "active", sort: "updatedAt",
        direction: "desc", offset: 0, limit: 50,
      }));
      expect(listedFromB.items).toHaveLength(0);
      expect(listedFromB.total).toBe(0);
    });

    it("refuses a write aimed at another workspace, at BOTH layers", async () => {
      const tx = createTransactionManager(app.db);
      // The repository rejects the mismatch first — the scope is bound, so the
      // record's workspace must match.
      await expect(tx.runForWorkspace(WS_B, uow => uow.contacts.insert({
        contactId: "con_smuggled" as ContactId,
        workspaceId: WS_A,
        name: "Smuggled", email: "s@example.com", emailKey: key("s@example.com"),
        phone: null, organization: null, title: null, createdAt: AT,
      }))).rejects.toThrow();

      // And RLS refuses it independently. A raw INSERT with WS_A's id inside a
      // WS_B transaction violates the policy's WITH CHECK — this is the layer
      // that holds if the repository's guard is ever removed.
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_B}, true)`.execute(trx);
        await sql`
          insert into contacts (contact_id, workspace_id, name, email,
            normalized_contact_email, created_at, updated_at)
          values ('con_raw', ${WS_A}, 'Raw', 'r@example.com', 'r@example.com',
            now(), now())
        `.execute(trx);
      })).rejects.toThrow(/row-level security/i);
    });

    it("cannot update or archive across the boundary", async () => {
      await insert(WS_A, "con_a2");
      const tx = createTransactionManager(app.db);

      const updated = await tx.runForWorkspace(WS_B, uow => uow.contacts.updateIfActive({
        contactId: "con_a2" as ContactId, patch: { name: "Hijacked" }, now: AT + 1,
      }));
      expect(updated).toBe(false);

      const archived = await tx.runForWorkspace(WS_B, uow => uow.contacts.archiveIfActive({
        contactId: "con_a2" as ContactId, now: AT + 1,
      }));
      expect(archived).toBe(false);

      const untouched = await tx.runForWorkspace(WS_A,
        uow => uow.contacts.findById("con_a2" as ContactId));
      expect(untouched?.name).toBe("con_a2");
      expect(untouched?.archivedAt).toBeNull();
    });

    it("sees nothing at all with no tenant context", async () => {
      await insert(WS_A, "con_a3");
      const rows = await app.db.transaction().execute(trx =>
        trx.selectFrom("contacts").selectAll().execute());
      // `lagda_current_workspace()` is NULL, so the policy matches no row.
      expect(rows).toHaveLength(0);
    });

    it("finds duplicates only within the tenant", async () => {
      await insert(WS_A, "con_a4", { email: "legal@example.com" });
      await insert(WS_B, "con_b4", { email: "legal@example.com" });
      const tx = createTransactionManager(app.db);

      const inA = await tx.runForWorkspace(WS_A, uow =>
        uow.contacts.findDuplicateCandidates({
          emailKey: key("legal@example.com"), excludeContactId: null,
        }));
      expect(inA.map(c => c.contactId)).toEqual(["con_a4"]);
    });
  });

  // ── Deletion is unavailable ───────────────────────────────────────────────

  describe("the runtime role cannot delete a contact", () => {
    it("is refused a DELETE by PostgreSQL", async () => {
      await insert(WS_A, "con_del");
      // Not "the repository has no method" — a raw statement, with correct
      // tenant context, from the role production runs as.
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`delete from contacts where contact_id = 'con_del'`.execute(trx);
      })).rejects.toThrow(/permission denied/i);

      const tx = createTransactionManager(app.db);
      const survivor = await tx.runForWorkspace(WS_A,
        uow => uow.contacts.findById("con_del" as ContactId));
      expect(survivor).not.toBeNull();
    });

    it("holds exactly select, insert and update", async () => {
      const grants = await sql<{ privilege_type: string }>`
        select privilege_type from information_schema.role_table_grants
        where grantee = 'lagda_app' and table_name = 'contacts'
      `.execute(owner.db);
      expect(grants.rows.map(r => r.privilege_type).sort())
        .toEqual(["INSERT", "SELECT", "UPDATE"]);
    });
  });

  // ── Constraints ───────────────────────────────────────────────────────────

  describe("check constraints", () => {
    it("refuses a blank name or email", async () => {
      for (const bad of [{ name: "   " }, { email: "" }]) {
        await expect(app.db.transaction().execute(async trx => {
          await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
          await trx.insertInto("contacts").values({
            contact_id: "con_blank", workspace_id: WS_A,
            name: bad.name ?? "Name", email: bad.email ?? "e@example.com",
            normalized_contact_email: "e@example.com",
            created_at: new Date(AT), updated_at: new Date(AT), archived_at: null,
          }).execute();
        })).rejects.toThrow(/violates check constraint/i);
      }
    });

    it("refuses an unfolded comparison key", async () => {
      // The constraint that makes duplicate detection trustworthy: a caller
      // that skipped the normalizer would store a key nothing ever matches.
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await trx.insertInto("contacts").values({
          contact_id: "con_case", workspace_id: WS_A,
          name: "Case", email: "Case@Example.com",
          normalized_contact_email: "Case@Example.com",
          created_at: new Date(AT), updated_at: new Date(AT), archived_at: null,
        }).execute();
      })).rejects.toThrow(/chk_contacts_email_normalized/i);
    });

    it("PERMITS two active contacts sharing an address", async () => {
      // Asserted, so a later "tidy up" cannot add a unique index. Shared
      // inboxes are legitimately several business contacts.
      await insert(WS_A, "con_dup1", { email: "legal@example.com" });
      await expect(insert(WS_A, "con_dup2", { email: "legal@example.com" }))
        .resolves.toBeUndefined();
    });

    it("refuses a contact in a workspace that does not exist", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', 'ws_ghost', true)`.execute(trx);
        await trx.insertInto("contacts").values({
          contact_id: "con_ghost", workspace_id: "ws_ghost",
          name: "Ghost", email: "g@example.com",
          normalized_contact_email: "g@example.com",
          created_at: new Date(AT), updated_at: new Date(AT), archived_at: null,
        }).execute();
      })).rejects.toThrow(/foreign key/i);
    });
  });

  // ── Behaviour the fakes claim ─────────────────────────────────────────────

  describe("listing behaves as the in-memory fake does", () => {
    beforeEach(async () => {
      await insert(WS_A, "con_ana", {
        name: "Ana Cruz", email: "ana@ayalaland.com.ph", organization: "Ayala Land",
      });
      await insert(WS_A, "con_ben", {
        name: "Ben Reyes", email: "ben@sm.com.ph", organization: "SM Prime",
      });
      await insert(WS_A, "con_car", {
        name: "Carlos Uy", email: "carlos@ayalaland.com.ph", organization: null,
      });
    });

    const run = (query: {
      search?: string | null; state?: "active" | "archived";
      sort?: "name" | "organization" | "updatedAt";
      direction?: "asc" | "desc"; offset?: number; limit?: number;
    }) => createTransactionManager(app.db).runForWorkspace(WS_A,
      uow => uow.contacts.list({
        search: query.search ?? null,
        state: query.state ?? "active",
        sort: query.sort ?? "updatedAt",
        direction: query.direction ?? "desc",
        offset: query.offset ?? 0,
        limit: query.limit ?? 50,
      }));

    it("searches four fields, case-insensitively", async () => {
      expect((await run({ search: "AYALA" })).total).toBe(2);
      expect((await run({ search: "reyes" })).items.map(c => c.name))
        .toEqual(["Ben Reyes"]);
    });

    it("treats % and _ as literal characters, not wildcards", async () => {
      // Without escaping, `%` matches every contact in the workspace and `_`
      // matches every one-character difference.
      expect((await run({ search: "%" })).total).toBe(0);
      expect((await run({ search: "_" })).total).toBe(0);
      expect((await run({ search: "\\" })).total).toBe(0);
    });

    it("puts a NULL organization last in both directions", async () => {
      for (const direction of ["asc", "desc"] as const) {
        const page = await run({ sort: "organization", direction });
        expect(page.items[2]?.organization).toBeNull();
      }
    });

    it("paginates with a stable order and a filter-wide total", async () => {
      const page1 = await run({ sort: "name", direction: "asc", offset: 0, limit: 2 });
      expect(page1.items.map(c => c.name)).toEqual(["Ana Cruz", "Ben Reyes"]);
      expect(page1.total).toBe(3);

      const page2 = await run({ sort: "name", direction: "asc", offset: 2, limit: 2 });
      expect(page2.items.map(c => c.name)).toEqual(["Carlos Uy"]);
      expect(page2.total).toBe(3);
    });

    it("separates the active book from the archive", async () => {
      const tx = createTransactionManager(app.db);
      await tx.runForWorkspace(WS_A, uow => uow.contacts.archiveIfActive({
        contactId: "con_ben" as ContactId, now: AT + 5_000,
      }));

      expect((await run({})).items.map(c => c.contactId).sort())
        .toEqual(["con_ana", "con_car"]);
      expect((await run({ state: "archived" })).items.map(c => c.contactId))
        .toEqual(["con_ben"]);
    });
  });

  // ── Conditional mutations ─────────────────────────────────────────────────

  describe("conditional mutations", () => {
    it("refuses to update an archived contact", async () => {
      await insert(WS_A, "con_arch");
      const tx = createTransactionManager(app.db);
      await tx.runForWorkspace(WS_A, uow => uow.contacts.archiveIfActive({
        contactId: "con_arch" as ContactId, now: AT + 1,
      }));

      const applied = await tx.runForWorkspace(WS_A, uow => uow.contacts.updateIfActive({
        contactId: "con_arch" as ContactId, patch: { name: "Edited" }, now: AT + 2,
      }));
      expect(applied).toBe(false);
    });

    it("clears a field with an explicit null and leaves absent keys alone", async () => {
      await insert(WS_A, "con_patch", {
        phone: "0917 000 0000", organization: "Acme", title: "GC",
      });
      const tx = createTransactionManager(app.db);
      await tx.runForWorkspace(WS_A, uow => uow.contacts.updateIfActive({
        contactId: "con_patch" as ContactId,
        // `phone: null` clears; `organization` and `title` are absent.
        patch: { phone: null },
        now: AT + 10,
      }));

      const after = await tx.runForWorkspace(WS_A,
        uow => uow.contacts.findById("con_patch" as ContactId));
      expect(after?.phone).toBeNull();
      expect(after?.organization).toBe("Acme");
      expect(after?.title).toBe("GC");
      expect(after?.updatedAt).toBe(AT + 10);
    });

    it("archives and restores, both conditionally", async () => {
      await insert(WS_A, "con_cycle");
      const tx = createTransactionManager(app.db);

      expect(await tx.runForWorkspace(WS_A, uow => uow.contacts.archiveIfActive({
        contactId: "con_cycle" as ContactId, now: AT + 1,
      }))).toBe(true);
      // The second attempt matches zero rows.
      expect(await tx.runForWorkspace(WS_A, uow => uow.contacts.archiveIfActive({
        contactId: "con_cycle" as ContactId, now: AT + 2,
      }))).toBe(false);

      expect(await tx.runForWorkspace(WS_A, uow => uow.contacts.restoreIfArchived({
        contactId: "con_cycle" as ContactId, now: AT + 3,
      }))).toBe(true);
      expect(await tx.runForWorkspace(WS_A, uow => uow.contacts.restoreIfArchived({
        contactId: "con_cycle" as ContactId, now: AT + 4,
      }))).toBe(false);
    });

    it("stamps updated_at equal to created_at on insert", async () => {
      await insert(WS_A, "con_stamp");
      const row = await createTransactionManager(app.db).runForWorkspace(WS_A,
        uow => uow.contacts.findById("con_stamp" as ContactId));
      expect(row?.updatedAt).toBe(row?.createdAt);
      expect(row?.archivedAt).toBeNull();
    });
  });

  // ── The atomicity guarantee ───────────────────────────────────────────────

  it("rolls a contact back with the transaction that wrote it", async () => {
    const tx = createTransactionManager(app.db);
    await expect(tx.runForWorkspace(WS_A, async uow => {
      await uow.contacts.insert({
        contactId: "con_rollback" as ContactId, workspaceId: WS_A,
        name: "Doomed", email: "d@example.com", emailKey: key("d@example.com"),
        phone: null, organization: null, title: null, createdAt: AT,
      });
      throw new Error("boom");
    })).rejects.toThrow("boom");

    const found = await tx.runForWorkspace(WS_A,
      uow => uow.contacts.findById("con_rollback" as ContactId));
    expect(found).toBeNull();
  });
});
