// The test-mode plan invoice PDF: one A4 page that carries the logo, the
// invoice number, the VAT split and a real QR code — and renders any name.

import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { renderPlanInvoice, type PlanInvoiceModel } from "./plan-invoice.js";

const model = (over: Partial<PlanInvoiceModel> = {}): PlanInvoiceModel => ({
  number: "LAGDA-2026-0002", planName: "Business", amountPesos: 799,
  issuedAt: Date.UTC(2026, 9, 1, 1, 0), periodEnd: Date.UTC(2026, 10, 1, 1, 0), generatedAt: Date.UTC(2026, 9, 2, 1, 0),
  billedTo: { name: "Christopher Cortes", email: "buddy@example.com", workspace: "Christopher Cortes's Workspace" },
  url: "https://lagda-esignature.netlify.app/app/workspace/settings/billing/invoices/LAGDA-2026-0002",
  sampleAccount: { bank: "LAGDA Test Bank", accountName: "LAGDA Test Account", accountNumber: "0000-1234-5678" },
  ...over,
});

describe("plan invoice PDF", () => {
  it("is one A4 page with the logo embedded", async () => {
    const bytes = await renderPlanInvoice(model());
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    const { width, height } = pdf.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
    expect(pdf.getTitle()).toBe("LAGDA invoice LAGDA-2026-0002");
    expect(bytes.byteLength).toBeGreaterThan(50_000); // the logo and the Noto faces are in there
  });

  it("renders long and non-Latin names without failing", async () => {
    const bytes = await renderPlanInvoice(model({
      billedTo: { name: "María José Cañizares-de la Rosa y Santos de los Reyes — 王小明", email: "a.very.long.email.address.for.testing@subdomain.example-company.com", workspace: "Cañizares & Partners Law Office of Metro Manila and Cebu" },
    }));
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it("writes a copy for a look, when asked", async () => {
    if (process.env["INVOICE_PDF_OUT"] === undefined) return;
    mkdirSync(process.env["INVOICE_PDF_OUT"], { recursive: true });
    writeFileSync(`${process.env["INVOICE_PDF_OUT"]}/sample-invoice.pdf`, await renderPlanInvoice(model()));
  });
});
