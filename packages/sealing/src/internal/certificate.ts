// The completion certificate.
//
// A SEPARATE artifact, not a page appended to the document. Handoff §15 stores
// "original PDF + signed PDF + completion certificate + evidence log" as
// distinct things, and appending would change the signed document's page count
// — so the file people signed is no longer the file they received. BACKEND-41
// decides the final composition; this renders the certificate and stops.
//
// ── What BACKEND-40 changed, and why each was wrong ────────────────────────
//
// This renderer existed before BACKEND-40, called from inside `seal()`. Four
// things it printed are now gone, and none of them was cosmetic:
//
//   "Completed"        The request is `completion-ready` at certificate time.
//                      `completed` is not even admitted by the request CHECK
//                      until BACKEND-41 adds it (§165, §268).
//   "Sealed"           Nothing is sealed yet. Seal metadata does not exist
//                      until BACKEND-41 (§163).
//   "Verification ID"  Verification identity belongs to BACKEND-41/42, and a
//                      standalone certificate step has none to print (§15).
//   "Prepared document
//    SHA-256"          There has NEVER been a prepared artifact — preparation
//                      is metadata-only and `ARTIFACT_TYPES` has no such
//                      member. Worse, after OD-162 `seal()`'s input carried the
//                      MERGED CANDIDATE, so the line printed the merged digest
//                      under a label naming an artifact that cannot exist.
//
// The first three were honest when the certificate lived inside `seal()`, where
// those facts genuinely existed. Lifted out into its own step it can no longer
// say any of them, which is exactly why the step had to be lifted out.
//
// ── What it renders instead ────────────────────────────────────────────────
//
// A curated `CompletionCertificateModelV1` and nothing else. No database row,
// no evidence event, no clock read. Everything visible was chosen in the model;
// nothing arrives because it happened to be in scope.

import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type {
  CertifiedAuthenticationMethod, CompletionCertificateModelV1,
} from "@lagda/application";
import {
  PdfProcessingError, SealingError, UnsupportedRepresentationError,
} from "../errors/index.js";
import { embedFaces } from "./fonts.js";

// A4 portrait in PDF points, matching the frontend's stated page geometry
// ("A4 portrait (595x842 CSS px at 100% zoom)").
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;

const INK = rgb(0.07, 0.09, 0.13);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);

/**
 * How each authentication method is described, as a TOTAL record.
 *
 * A `Record` over the closed vocabulary rather than a switch with a default:
 * adding a method without deciding its wording is a compile error, which is
 * precisely the decision that must not be made by accident. A default branch
 * would let a new mechanism inherit another's description.
 *
 * The wording states the MECHANISM and claims nothing about identity. §6 and
 * §179: possession of a bearer link is not identity verification, and an email
 * one-time passcode is not government identity proof. Neither may be rendered
 * as "Verified".
 */
const AUTHENTICATION_WORDING:
Readonly<Record<CertifiedAuthenticationMethod, string>> = Object.freeze({
  "link-only": "Signing link",
  "email-otp": "Email one-time passcode",
});

/**
 * Evidence timestamps, in one explicit format.
 *
 * `YYYY-MM-DD HH:mm:ss UTC` — locale-independent and labelled (§52, §53). The
 * server's locale never participates, and the zone is on the page rather than
 * assumed, for the same reason a signed date carries it: the reader cannot
 * otherwise tell a UTC instant from a local one.
 */
function formatUtc(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/**
 * Breaks a string so it fits a width, splitting mid-token when a token alone is
 * too long.
 *
 * The mid-token case is not hypothetical: a SHA-256 digest is one 64-character
 * token with no break opportunity, and word-wrapping alone would run it off the
 * page — invisible in a passing test that only asserts the text was drawn.
 *
 * Wrapping, never truncation. §105: a signer's identity must not be silently
 * shortened to fit a layout.
 */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";

  const flush = (): void => {
    if (line.length > 0) {
      lines.push(line);
      line = "";
    }
  };

  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    flush();
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      line = word;
      continue;
    }
    // Unbreakable token — split by character.
    let chunk = "";
    for (const char of word) {
      if (font.widthOfTextAtSize(chunk + char, size) > maxWidth) {
        lines.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }
    line = chunk;
  }
  flush();
  return lines;
}

/** Every string the certificate will draw, so coverage is checked ONCE, up front. */
function drawableText(model: CompletionCertificateModelV1): string[] {
  return [
    model.documentTitle,
    ...model.participants.flatMap((participant) => [
      participant.name,
      participant.maskedEmail,
      ...(participant.consent === null
        ? []
        : [participant.consent.consentType, participant.consent.consentVersion]),
    ]),
  ];
}

/**
 * Renders the certificate as a standalone PDF.
 *
 * Deterministic: every value comes from the model. Nothing here reads a clock,
 * so generating the same model twice produces the same document.
 */
export async function renderCompletionCertificate(
  model: CompletionCertificateModelV1,
): Promise<Uint8Array> {
  // Refused BEFORE the document is built, not while drawing it.
  //
  // §178: a name the face cannot draw must fail the step, never render as
  // nothing. An embedded font does not throw on an uncovered glyph — it draws
  // blank — so a certificate could otherwise be produced with a signer's name
  // missing and still look complete.
  //
  // Checked here rather than per-write so the failure names the certificate
  // rather than surfacing halfway down a page.
  for (const method of model.participants.map((p) => p.authenticationMethod)) {
    if (!(method in AUTHENTICATION_WORDING)) {
      // Fails CLOSED (§179). An unrecognised method is never described, and
      // certainly never as "Verified".
      throw new UnsupportedRepresentationError(
        `Certificate rendering has no wording for authentication method "${method}".`,
      );
    }
  }

  try {
    const pdf = await PDFDocument.create();
    const faces = embedFaces(pdf);
    const body = await faces.face("regular");
    const bold = await faces.face("bold");

    for (const text of drawableText(model)) faces.assertRenderable(text, "regular");

    // Pinned from the model, so two renders of one model are byte-identical.
    // pdf-lib stamps both from the system clock otherwise.
    const generated = new Date(model.generatedAt);
    pdf.setCreationDate(generated);
    pdf.setModificationDate(generated);

    let page: PDFPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let cursor = PAGE_HEIGHT - MARGIN;
    const contentWidth = PAGE_WIDTH - MARGIN * 2;

    // Page breaks are handled, not assumed away. §107: a transaction with
    // thirty participants must not render its last signers below the page edge
    // and still return a structurally valid PDF.
    const ensureRoom = (needed: number): void => {
      if (cursor - needed < MARGIN) {
        page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        cursor = PAGE_HEIGHT - MARGIN;
      }
    };

    const write = (
      text: string,
      opts: { size: number; font: PDFFont; color?: typeof INK; gap?: number },
    ): void => {
      for (const line of wrap(text, opts.font, opts.size, contentWidth)) {
        ensureRoom(opts.size + 4);
        cursor -= opts.size + 2;
        page.drawText(line, {
          x: MARGIN, y: cursor, size: opts.size, font: opts.font,
          color: opts.color ?? INK,
        });
      }
      cursor -= opts.gap ?? 0;
    };

    const field = (label: string, value: string, gap = 10): void => {
      write(label, { size: 9, font: bold, color: MUTED });
      write(value, { size: 11, font: body, gap });
    };

    const rule = (): void => {
      ensureRoom(12);
      cursor -= 8;
      page.drawLine({
        start: { x: MARGIN, y: cursor }, end: { x: PAGE_WIDTH - MARGIN, y: cursor },
        thickness: 0.75, color: RULE,
      });
      cursor -= 12;
    };

    // ── Heading ────────────────────────────────────────────────────────────
    //
    // "Certificate of Completion" — descriptive, and deliberately not grander.
    // §164 forbids "Certificate of Authenticity" or any identity-verification
    // framing, and the product itself denies being a legal certificate.
    write("Certificate of Completion", { size: 20, font: bold });
    write("LAGDA Electronic Signature", { size: 10, font: body, color: MUTED, gap: 6 });
    rule();

    // ── The document ───────────────────────────────────────────────────────
    field("Document", model.documentTitle);

    // Named for what it IS. The request's frozen source artifact — the bytes the
    // signers signed against — not a "prepared document", which LAGDA has never
    // produced.
    field("Signing source document SHA-256", model.sourceDocumentDigest);

    // ── Participants ───────────────────────────────────────────────────────
    rule();
    write("Signing participants", { size: 12, font: bold, gap: 6 });

    for (const participant of model.participants) {
      // Kept together on one page where it fits. A signer's name landing on one
      // page and their signing time on the next is legible but reads as two
      // separate records.
      ensureRoom(64);

      // Deliberately not "Signer 1". §47: the product uses no such label, and
      // inventing one implies a routing guarantee the certificate is not making.
      write(participant.name, { size: 11, font: bold });
      write(participant.maskedEmail, { size: 9, font: body, color: MUTED, gap: 4 });

      // Every line below is a fact LAGDA recorded, phrased as what it is.
      write(
        `Signed: ${formatUtc(participant.signedAt)}`,
        { size: 10, font: body },
      );
      write(
        `Authentication: ${AUTHENTICATION_WORDING[participant.authenticationMethod]}`,
        { size: 10, font: body },
      );

      if (participant.firstEnteredAt !== null) {
        // §7: this is ENTRY to the signing ceremony by an authenticated
        // recipient. It is not evidence that anyone read the document, and the
        // wording must not drift toward "viewed" or "read".
        write(
          `Signing session entered: ${formatUtc(participant.firstEnteredAt)}`,
          { size: 10, font: body },
        );
      }

      if (participant.consent !== null) {
        write(
          `Consent (${participant.consent.consentType} `
            + `${participant.consent.consentVersion}): `
            + formatUtc(participant.consent.acceptedAt),
          { size: 10, font: body },
        );
      }

      cursor -= 10;
    }

    // ── Provenance ─────────────────────────────────────────────────────────
    rule();
    field("Certificate generated", formatUtc(model.generatedAt));
    field(
      "Certificate version",
      `${model.certificateVersion} · ${CERTIFICATE_RENDERER_LABEL}`,
      6,
    );

    // ── What this is not ───────────────────────────────────────────────────
    //
    // The middle sentence is the product's own approved copy, verbatim from
    // `TransactionDetailPage.tsx`. §97 forbids inventing legal language, and
    // LAGDA's existing copy disclaims precisely this kind of document — which
    // makes it the most important line on the page, not boilerplate.
    rule();
    write(
      "This certificate records the completion evidence held by LAGDA for the "
        + "document identified above. It does not constitute a legal certificate "
        + "or court-admissible document, and does not itself attest to signer "
        + "identity. Authentication describes the mechanism used to reach the "
        + "signing session; it is not verification of legal identity.",
      { size: 8, font: body, color: MUTED },
    );

    return await pdf.save();
  } catch (cause) {
    // ANY LAGDA-owned failure passes through unchanged. Narrowing this to one
    // error type was a real bug: `assertRenderable` throws
    // `UnrenderableTextError` from inside this try, so an unrenderable signer
    // name was being rewrapped as `PdfProcessingError` — which is RETRYABLE.
    // The pipeline would have retried a name that can never render, forever.
    if (cause instanceof SealingError) throw cause;
    // Never includes the model. §243: a renderer error must not serialize
    // recipient names, addresses or evidence into a message that gets logged.
    throw new PdfProcessingError("Failed to render the completion certificate.", cause);
  }
}

/** Kept beside the version so a layout change and its label move together. */
const CERTIFICATE_RENDERER_LABEL = "certificate-renderer-v1";
