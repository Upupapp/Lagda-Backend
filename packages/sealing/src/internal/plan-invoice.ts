// A test-mode plan invoice as a one-page A4 PDF.
//
// What it draws, top to bottom: the LAGDA logo and the invoice number; a
// "TEST MODE — no payment taken" stamp; who issued it and who it is billed
// to; the one line item with 12% VAT (prices include it); the total and the
// amount paid (always ₱0.00 in test mode); a QR code that opens the invoice
// in LAGDA; and the plain statement that this is not a request for payment
// or an official receipt.
//
// Rendered on the server from facts the server holds, never from a client's
// copy, so the file is the same on every device and the QR cannot be edited
// on a screen first. The QR is a real one (qrcode's module matrix, drawn as
// squares), the logo is vendored in assets/brand, the text is Noto Sans so
// the peso sign and any name render.

import { readFileSync } from "node:fs";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { embedFaces } from "./fonts.js";

export interface PlanInvoiceModel {
  readonly number: string;
  readonly planName: string;
  /** Whole pesos, VAT included. */
  readonly amountPesos: number;
  readonly issuedAt: number;
  readonly periodEnd: number;
  /** When this copy is made. Passed in: the sealing package never reads the clock. */
  readonly generatedAt: number;
  readonly billedTo: { readonly name: string; readonly email: string; readonly workspace: string };
  /** Where the QR code leads (the invoice inside LAGDA). */
  readonly url: string;
  /** The test-mode sample bank account, shown as what the request used. */
  readonly sampleAccount: { readonly bank: string; readonly accountName: string; readonly accountNumber: string };
}

const NAVY = rgb(0.027, 0.067, 0.122);
const AZURE = rgb(0, 0.471, 0.831);
const SLATE = rgb(0.392, 0.455, 0.545);
const LINE = rgb(0.886, 0.91, 0.937);
const WASH = rgb(0.973, 0.98, 0.988);
const GOLD = rgb(0.631, 0.392, 0.035);
const GOLD_WASH = rgb(1, 0.984, 0.922);

const W = 595.28, H = 841.89, M = 48;
const VAT_RATE = 0.12;

const LOGO = new URL("../../assets/brand/lagda-logo.png", import.meta.url);

const round2 = (n: number) => Math.round(n * 100) / 100;
const peso = (n: number) => `₱${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (ms: number) =>
  new Date(ms).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Manila" });

/** Shortens `text` with an ellipsis until it fits `width`. */
function fit(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > width) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

/** Wraps to lines of at most `width`. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line === "" ? word : `${line} ${word}`;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else { if (line !== "") lines.push(line); line = word; }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** Breaks a long unbroken string (a URL) into lines of at most `width`. */
function breakLong(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (font.widthOfTextAtSize(line + ch, size) > width) { lines.push(line); line = ch; } else line += ch;
  }
  if (line !== "") lines.push(line);
  return lines;
}

function drawQr(page: PDFPage, url: string, x: number, y: number, size: number): void {
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const cell = size / n;
  page.drawRectangle({ x: x - 6, y: y - 6, width: size + 12, height: size + 12, color: rgb(1, 1, 1), borderColor: LINE, borderWidth: 1 });
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(c, r) === 1) {
        page.drawRectangle({ x: x + c * cell, y: y + size - (r + 1) * cell, width: cell + 0.2, height: cell + 0.2, color: NAVY });
      }
    }
  }
}

export async function renderPlanInvoice(model: PlanInvoiceModel): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`LAGDA invoice ${model.number}`);
  pdf.setAuthor("LAGDA");
  pdf.setSubject("Test-mode plan invoice — no payment taken");
  const faces = embedFaces(pdf);
  const regular = await faces.face("regular");
  const bold = await faces.face("bold");
  const page = pdf.addPage([W, H]);

  const text = (s: string, x: number, y: number, size: number, font: PDFFont, color = NAVY) =>
    page.drawText(s, { x, y, size, font, color });
  const textRight = (s: string, right: number, y: number, size: number, font: PDFFont, color = NAVY) =>
    page.drawText(s, { x: right - font.widthOfTextAtSize(s, size), y, size, font, color });
  const label = (s: string, x: number, y: number) => text(s.toUpperCase(), x, y, 7.5, bold, SLATE);

  // ── Header ────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: NAVY });
  page.drawRectangle({ x: W * 0.55, y: H - 6, width: W * 0.45, height: 6, color: AZURE });
  const logo = await pdf.embedPng(readFileSync(LOGO));
  const logoH = 74;
  const logoW = (logo.width / logo.height) * logoH;
  page.drawImage(logo, { x: M, y: H - M - logoH - 4, width: logoW, height: logoH });
  textRight("INVOICE", W - M, H - M - 18, 24, bold, NAVY);
  textRight(model.number, W - M, H - M - 38, 12, bold, AZURE);
  textRight(`Issued ${date(model.issuedAt)}`, W - M, H - M - 54, 9.5, regular, SLATE);

  // ── Test-mode stamp ───────────────────────────────────────────────────
  const stampY = H - M - logoH - 40;
  page.drawRectangle({ x: M, y: stampY, width: W - M * 2, height: 26, color: GOLD_WASH, borderColor: rgb(0.945, 0.78, 0.4), borderWidth: 1 });
  const stamp = "TEST MODE — NO PAYMENT HAS BEEN TAKEN";
  text(stamp, (W - bold.widthOfTextAtSize(stamp, 10)) / 2, stampY + 9, 10, bold, GOLD);

  // ── Parties ───────────────────────────────────────────────────────────
  let y = stampY - 38;
  const colW = (W - M * 2) / 3;
  label("Issued by", M, y);
  text("LAGDA", M, y - 15, 11, bold);
  text("Electronic signatures", M, y - 29, 9.5, regular, SLATE);
  text("Philippines", M, y - 42, 9.5, regular, SLATE);

  const bx = M + colW;
  label("Billed to", bx, y);
  text(fit(model.billedTo.name, bold, 11, colW - 12), bx, y - 15, 11, bold);
  text(fit(model.billedTo.email, regular, 9.5, colW - 12), bx, y - 29, 9.5, regular, SLATE);
  text(fit(model.billedTo.workspace, regular, 9.5, colW - 12), bx, y - 42, 9.5, regular, SLATE);

  const sx = M + colW * 2;
  label("Service period", sx, y);
  text(date(model.issuedAt), sx, y - 15, 10, bold);
  text(`to ${date(model.periodEnd)}`, sx, y - 29, 10, regular);
  page.drawRectangle({ x: sx, y: y - 55, width: 106, height: 17, color: GOLD_WASH, borderColor: rgb(0.945, 0.78, 0.4), borderWidth: 0.8 });
  text("TEST — NOT PAID", sx + 9, y - 50, 8, bold, GOLD);

  // ── Line items ────────────────────────────────────────────────────────
  y -= 92;
  const tableW = W - M * 2;
  page.drawRectangle({ x: M, y: y - 8, width: tableW, height: 26, color: WASH });
  const colQty = M + tableW - 215, colUnit = M + tableW - 105, colAmt = M + tableW - 12;
  text("DESCRIPTION", M + 12, y + 2, 8, bold, SLATE);
  textRight("QTY", colQty, y + 2, 8, bold, SLATE);
  textRight("UNIT PRICE", colUnit, y + 2, 8, bold, SLATE);
  textRight("AMOUNT", colAmt, y + 2, 8, bold, SLATE);
  y -= 34;
  text(`LAGDA ${model.planName} — monthly plan`, M + 12, y, 11, bold);
  text("1 month · test-mode pricing · 1 user", M + 12, y - 14, 9.5, regular, SLATE);
  textRight("1", colQty, y, 10.5, regular);
  textRight(peso(model.amountPesos), colUnit, y, 10.5, regular);
  textRight(peso(model.amountPesos), colAmt, y, 10.5, bold);
  page.drawLine({ start: { x: M, y: y - 30 }, end: { x: M + tableW, y: y - 30 }, thickness: 1, color: LINE });

  // ── Totals ────────────────────────────────────────────────────────────
  const subtotal = round2(model.amountPesos / (1 + VAT_RATE));
  const vat = round2(model.amountPesos - subtotal);
  y -= 58;
  const tx = M + tableW - 230;
  const row = (k: string, v: string, strong = false) => {
    text(k, tx, y, strong ? 11 : 10, strong ? bold : regular, strong ? NAVY : SLATE);
    textRight(v, colAmt, y, strong ? 11 : 10, strong ? bold : regular);
    y -= 19;
  };
  row("Subtotal (excl. VAT)", peso(subtotal));
  row(`VAT ${String(Math.round(VAT_RATE * 100))}%`, peso(vat));
  page.drawLine({ start: { x: tx, y: y + 13 }, end: { x: colAmt, y: y + 13 }, thickness: 1.5, color: NAVY });
  y -= 2;
  row("Total", peso(model.amountPesos), true);
  row("Amount paid", peso(0));

  // ── QR, and what the request used ─────────────────────────────────────
  const qrSize = 104;
  // Right under the totals, never closer to the footer than its rule.
  const qrY = Math.max(140, y - 34 - qrSize);
  drawQr(page, model.url, M + 6, qrY, qrSize);
  const noteX = M + qrSize + 30;
  const noteW = W - M - 200 - noteX - 10;
  text("Open this invoice in LAGDA", noteX, qrY + qrSize - 10, 10.5, bold);
  const how = wrap("Scan the code or visit the link. You must be signed in to the account that holds this plan.", regular, 9, noteW);
  how.forEach((l, i) => text(l, noteX, qrY + qrSize - 26 - i * 12, 9, regular, SLATE));
  breakLong(model.url, regular, 7, noteW).slice(0, 4)
    .forEach((l, i) => text(l, noteX, qrY + 34 - i * 9, 7, regular, AZURE));

  const bankX = W - M - 190;
  page.drawRectangle({ x: bankX, y: qrY - 6, width: 190, height: qrSize + 12, color: WASH, borderColor: LINE, borderWidth: 1 });
  label("Test-mode sample account", bankX + 12, qrY + qrSize - 8);
  text(model.sampleAccount.bank, bankX + 12, qrY + qrSize - 26, 9.5, bold);
  text(model.sampleAccount.accountName, bankX + 12, qrY + qrSize - 40, 9, regular, SLATE);
  text(model.sampleAccount.accountNumber, bankX + 12, qrY + qrSize - 54, 9.5, bold);
  wrap("No money moved. Only the published sample account is accepted in test mode.", regular, 8, 166)
    .forEach((l, i) => text(l, bankX + 12, qrY + qrSize - 72 - i * 10, 8, regular, SLATE));

  // ── Footer ────────────────────────────────────────────────────────────
  page.drawLine({ start: { x: M, y: 112 }, end: { x: W - M, y: 112 }, thickness: 1, color: LINE });
  wrap("Prices include 12% VAT. This is a test-mode invoice for illustration: it is not a request for payment, "
    + "not an official receipt, and no payment has been taken. Electronic signing is not notarization.", regular, 8.5, W - M * 2)
    .forEach((l, i) => text(l, M, 96 - i * 11, 8.5, regular, SLATE));
  text(`${model.number} · LAGDA`, M, 48, 8, regular, SLATE);
  const generated = `Generated ${date(model.generatedAt)}`;
  textRight(generated, W - M, 48, 8, regular, SLATE);

  return pdf.save();
}
