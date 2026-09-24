// Lays a FlowDocument out onto pages — the print engine behind authored
// templates (070, replacing 066's fixed-canvas `template-content.ts`).
//
// ── Pure, and measured by a function it is handed ───────────────────────────
//
// This module draws no PDF and touches no font file. It takes a `measure`
// callback (real text width, in points, for a given style) and returns a
// flat list of DRAW OPERATIONS plus every `fieldAnchor`'s resolved position —
// nothing pdf-lib-shaped. `node-flow-document-generator.ts` supplies a real
// measurer backed by embedded fonts and turns the result into an actual PDF.
// Splitting it this way means the hard part — line-wrapping, pagination,
// numbering, justification — is testable with a trivial fake measurer and no
// font file, the same reason `assessSigningEligibility` (BACKEND-37) is pure
// and its route is not.
//
// ── The one page size ─────────────────────────────────────────────────────
//
// A4 portrait, the same constants `certificate.ts` and 066's generator used,
// so a generated document and its eventual completion certificate keep
// sharing one page geometry.
//
// ── Coordinates, and the one conversion this module owns ───────────────────
//
// Internally this module works in points from the TOP of the page down —
// the way a document is actually authored and read. `DrawTextOp.y` is
// converted to pdf-lib's own bottom-up convention before being returned, so
// the renderer never has to know this module thought in the other direction.
// A resolved anchor's `rect`, by contrast, is normalized 0-1 with a
// TOP-LEFT origin — `PreparationRectSchema`'s own convention, because that
// rectangle's destination is `workflow_template_fields`, not a PDF page.

import type {
  FlowDocument, DocumentBlock, DocumentInlineContent, DocumentFontFamily,
  DocumentBlockAlign, DocumentFieldAnchorRun,
} from "@lagda/contracts";
import { LayoutOverflowError } from "../errors/index.js";

export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;

const MARGIN_TOP = 72;
const MARGIN_BOTTOM = 72;
const MARGIN_LEFT = 72;
const MARGIN_RIGHT = 72;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
const CONTENT_BOTTOM = PAGE_HEIGHT - MARGIN_BOTTOM;

/** Matches 066's own constant — the vertical rhythm a legal-document body
 *  reads correctly at is not a new decision this rebuild gets to make. */
const LINE_HEIGHT_FACTOR = 1.35;

const DEFAULT_BODY_SIZE = 11;
const HEADING_SIZES: Readonly<Record<1 | 2 | 3, number>> = { 1: 20, 2: 16, 3: 13 };
const SPACE_AFTER_PARAGRAPH = 8;
const SPACE_AFTER_HEADING = 10;
const SPACE_AFTER_LIST_ITEM = 4;

/** Per nesting depth — "1." sits at the margin, "1.1." one step in. */
const LIST_INDENT = 20;

const DEFAULT_FAMILY: DocumentFontFamily = "times";

/** Hard stop on how long a generated document may run. Bounds a pathological
 *  document (a very long list, deeply nested) to a render that finishes in
 *  bounded time rather than an unbounded PDF nobody asked for. */
export const FLOW_LAYOUT_MAX_PAGES = 200;

export interface RunStyle {
  readonly family: DocumentFontFamily;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly size: number;
}

export type MeasureFn = (text: string, style: RunStyle) => number;

export interface DrawTextOp {
  readonly kind: "text";
  /** 0-based. */
  readonly page: number;
  /** Points, pdf-lib's own bottom-up y. */
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly style: RunStyle;
  readonly underline: boolean;
  /** True for a `fieldAnchor`'s bracketed placeholder — drawn in a muted
   *  tone so it reads as a slot to fill, not as the document's own prose. */
  readonly placeholder: boolean;
}

export interface ResolvedAnchorLayout {
  readonly anchor: DocumentFieldAnchorRun;
  /** 1-based, matching `PreparationRectSchema`'s own `pageNumber` sibling. */
  readonly pageNumber: number;
  /** Normalized 0-1, top-left origin. */
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface FlowLayoutResult {
  readonly pageCount: number;
  readonly drawOps: readonly DrawTextOp[];
  /** In document order. */
  readonly resolvedAnchors: readonly ResolvedAnchorLayout[];
}

// ── Tokens: one paragraph's inline content, flattened ───────────────────────

interface Token {
  readonly text: string;
  readonly style: RunStyle;
  readonly underline: boolean;
  readonly placeholder: boolean;
  /** Present only for a `fieldAnchor` token — carried through to the
   *  resolved-anchor list once this token's box is known. */
  readonly anchor?: DocumentFieldAnchorRun;
}

function styleFromMarks(
  marks: readonly { readonly kind: string; readonly family?: DocumentFontFamily; readonly size?: number }[] | undefined,
): RunStyle {
  let family: DocumentFontFamily = DEFAULT_FAMILY;
  let bold = false;
  let italic = false;
  let size = DEFAULT_BODY_SIZE;
  for (const mark of marks ?? []) {
    if (mark.kind === "bold") bold = true;
    else if (mark.kind === "italic") italic = true;
    else if (mark.kind === "fontFamily" && mark.family !== undefined) family = mark.family;
    else if (mark.kind === "fontSize" && mark.size !== undefined) size = mark.size;
  }
  return { family, bold, italic, size };
}

function hasUnderline(
  marks: readonly { readonly kind: string }[] | undefined,
): boolean {
  return (marks ?? []).some(m => m.kind === "underline");
}

/** Splits one paragraph's runs into word-level tokens. A `variable`/
 *  `fieldAnchor` run becomes exactly ONE indivisible token — it must never
 *  break across a line, the same reason a word does not either. Whitespace
 *  inside a text run is normalized to single spaces between words; this is
 *  a deliberate simplification (see the module header) rather than
 *  preserving exact run-internal spacing. */
function tokenize(content: DocumentInlineContent): Token[] {
  const tokens: Token[] = [];
  for (const run of content) {
    if (run.kind === "text") {
      const style = styleFromMarks(run.marks);
      const underline = hasUnderline(run.marks);
      for (const word of run.text.split(/\s+/u).filter(w => w.length > 0)) {
        tokens.push({ text: word, style, underline, placeholder: false });
      }
    } else if (run.kind === "variable") {
      tokens.push({
        text: `[${run.label}]`, style: { family: DEFAULT_FAMILY, bold: false, italic: true, size: DEFAULT_BODY_SIZE },
        underline: false, placeholder: true,
      });
    } else {
      // fieldAnchor
      tokens.push({
        text: `[${run.label}]`, style: { family: DEFAULT_FAMILY, bold: false, italic: false, size: DEFAULT_BODY_SIZE },
        underline: true, placeholder: true, anchor: run,
      });
    }
  }
  return tokens;
}

// ── Line-breaking ────────────────────────────────────────────────────────────

interface PlacedToken extends Token {
  /** Points from the line's own left edge (post-alignment, pre-indent). */
  readonly offset: number;
  readonly width: number;
}

interface Line {
  readonly tokens: readonly PlacedToken[];
  readonly height: number;
  readonly ascentSize: number;
}

/** Greedy word-wrap — the same algorithm 066's `wrapLines` used, extended to
 *  mixed styles per line: each token is measured in its OWN style, so a
 *  bold word inside a regular sentence wraps correctly. */
function wrapTokens(tokens: readonly Token[], boxWidth: number, measure: MeasureFn): Token[][] {
  const lines: Token[][] = [];
  let current: Token[] = [];
  let currentWidth = 0;
  const spaceWidth = (style: RunStyle) => measure(" ", style);

  for (const token of tokens) {
    const tokenWidth = measure(token.text, token.style);
    const gap = current.length > 0 ? spaceWidth(token.style) : 0;
    if (current.length > 0 && currentWidth + gap + tokenWidth > boxWidth) {
      lines.push(current);
      current = [token];
      currentWidth = tokenWidth;
    } else {
      current.push(token);
      currentWidth += gap + tokenWidth;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** Positions one wrapped line's tokens along the box, honouring alignment —
 *  `justify` spreads the GAPS, never the words themselves, and never
 *  justifies a paragraph's own last line, matching how every real word
 *  processor treats one. */
function placeLine(
  tokens: readonly Token[], boxWidth: number, align: DocumentBlockAlign, isLastLine: boolean, measure: MeasureFn,
): Line {
  const widths = tokens.map(t => measure(t.text, t.style));
  const naturalGap = tokens.length > 1 ? measure(" ", tokens[0]!.style) : 0;
  const naturalWidth = widths.reduce((sum, w) => sum + w, 0) + naturalGap * Math.max(tokens.length - 1, 0);

  const useJustify = align === "justify" && !isLastLine && tokens.length > 1;
  const gap = useJustify && tokens.length > 1
    ? naturalGap + (boxWidth - naturalWidth) / (tokens.length - 1)
    : naturalGap;

  const startX = align === "center" ? Math.max((boxWidth - naturalWidth) / 2, 0)
    : align === "right" ? Math.max(boxWidth - naturalWidth, 0)
      : 0;

  const placed: PlacedToken[] = [];
  let cursor = startX;
  tokens.forEach((token, index) => {
    if (index > 0) cursor += gap;
    placed.push({ ...token, offset: cursor, width: widths[index]! });
    cursor += widths[index]!;
  });

  const maxSize = Math.max(...tokens.map(t => t.style.size));
  return { tokens: placed, height: maxSize * LINE_HEIGHT_FACTOR, ascentSize: maxSize };
}

// ── Numbering ─────────────────────────────────────────────────────────────

/** "1." / "1.1." / "1.1.1." from a counters stack, one entry per depth. */
function numberLabel(counters: readonly number[]): string {
  return `${counters.join(".")}.`;
}

// ── Pagination ───────────────────────────────────────────────────────────────

class Cursor {
  page = 0;
  /** Points from the TOP of the page. */
  y = MARGIN_TOP;
  readonly drawOps: DrawTextOp[] = [];
  readonly resolvedAnchors: ResolvedAnchorLayout[] = [];

  /** Advances to a fresh page. Never called for page 0, which starts open. */
  newPage(): void {
    this.page += 1;
    this.y = MARGIN_TOP;
    if (this.page >= FLOW_LAYOUT_MAX_PAGES) {
      throw new LayoutOverflowError(
        `This document is too long to generate (over ${String(FLOW_LAYOUT_MAX_PAGES)} pages). `
        + "Split it into a shorter template.");
    }
  }

  ensureRoom(height: number): void {
    if (this.y + height > CONTENT_BOTTOM) this.newPage();
  }

  /** Draws one wrapped line at the cursor's current position, indented, and
   *  records any field anchor it carries. Advances `y` by the line's own
   *  height — pagination is the CALLER's job (`ensureRoom` first). */
  placeLineAt(line: Line, indent: number): void {
    const baselineFromTop = this.y + line.ascentSize; // approx cap-height baseline
    for (const token of line.tokens) {
      const x = MARGIN_LEFT + indent + token.offset;
      const yFromBottom = PAGE_HEIGHT - baselineFromTop;
      this.drawOps.push({
        kind: "text", page: this.page, x, y: yFromBottom,
        text: token.text, style: token.style, underline: token.underline,
        placeholder: token.placeholder,
      });
      if (token.anchor) {
        // Top-left, normalized 0-1 — a small vertical pad so the box reads
        // as sitting UNDER the text rather than through its middle, the same
        // visual convention a dragged field box already uses.
        const boxTop = this.y;
        const boxHeight = line.height;
        this.resolvedAnchors.push({
          anchor: token.anchor,
          pageNumber: this.page + 1,
          rect: {
            x: x / PAGE_WIDTH,
            y: boxTop / PAGE_HEIGHT,
            width: token.width / PAGE_WIDTH,
            height: boxHeight / PAGE_HEIGHT,
          },
        });
      }
    }
    this.y += line.height;
  }
}

function layoutParagraphLike(
  cursor: Cursor, content: DocumentInlineContent, align: DocumentBlockAlign, indent: number,
  measure: MeasureFn, spaceAfter: number, leadingLabel?: string,
): void {
  const tokens = tokenize(content);
  const boxWidth = CONTENT_WIDTH - indent;

  if (leadingLabel !== undefined) {
    tokens.unshift({
      text: leadingLabel, style: { family: DEFAULT_FAMILY, bold: false, italic: false, size: DEFAULT_BODY_SIZE },
      underline: false, placeholder: false,
    });
  }

  if (tokens.length === 0) {
    // An empty paragraph is still a blank line — the same "press Enter"
    // gap a real word processor leaves.
    cursor.ensureRoom(DEFAULT_BODY_SIZE * LINE_HEIGHT_FACTOR);
    cursor.y += DEFAULT_BODY_SIZE * LINE_HEIGHT_FACTOR;
  } else {
    const wrapped = wrapTokens(tokens, boxWidth, measure);
    wrapped.forEach((lineTokens, index) => {
      const line = placeLine(lineTokens, boxWidth, align, index === wrapped.length - 1, measure);
      cursor.ensureRoom(line.height);
      cursor.placeLineAt(line, indent);
    });
  }
  cursor.y += spaceAfter;
}

function layoutBlock(
  cursor: Cursor, block: DocumentBlock, measure: MeasureFn, depth: number, counters: number[],
): void {
  if (block.kind === "pageBreak") {
    cursor.newPage();
    return;
  }
  if (block.kind === "paragraph") {
    layoutParagraphLike(
      cursor, block.content, block.align ?? "left", depth * LIST_INDENT, measure, SPACE_AFTER_PARAGRAPH);
    return;
  }
  if (block.kind === "heading") {
    const size = HEADING_SIZES[block.level];
    const boldContent: DocumentInlineContent = block.content.map(run =>
      run.kind === "text"
        ? { ...run, marks: [...(run.marks ?? []), { kind: "bold" }, { kind: "fontSize", size }] }
        : run);
    layoutParagraphLike(
      cursor, boldContent, block.align ?? "left", depth * LIST_INDENT, measure, SPACE_AFTER_HEADING);
    return;
  }
  // orderedList
  counters.push(0);
  for (const item of block.content) {
    counters[counters.length - 1] = (counters[counters.length - 1] ?? 0) + 1;
    let labelDrawn = false;
    for (const child of item.content) {
      if (child.kind === "orderedList") {
        layoutBlock(cursor, child, measure, depth + 1, counters);
      } else {
        layoutParagraphLike(
          cursor, child.content, child.align ?? "left", (depth + 1) * LIST_INDENT, measure,
          SPACE_AFTER_LIST_ITEM, labelDrawn ? undefined : `${numberLabel(counters)} `);
        labelDrawn = true;
      }
    }
  }
  counters.pop();
}

/**
 * Every distinct (family, bold, italic) combination the document actually
 * uses, plus the default body style — always included, because the
 * numbering-label prefix and every placeholder token draw in it regardless
 * of what the surrounding text uses. A renderer embeds exactly these fonts,
 * once each, before layout runs (layout needs real widths to decide where a
 * line breaks, and embedding is async while measuring must be synchronous —
 * so this has to happen as a pass of its own, first).
 *
 * Font SIZE is deliberately excluded from the combination: it is a draw-time
 * parameter pdf-lib applies to an already-embedded font, not a different
 * font file to embed.
 */
export function collectFlowDocumentStyles(doc: FlowDocument): readonly { family: DocumentFontFamily; bold: boolean; italic: boolean }[] {
  const seen = new Map<string, { family: DocumentFontFamily; bold: boolean; italic: boolean }>();
  const note = (style: RunStyle): void => {
    seen.set(`${style.family}:${style.bold ? "b" : ""}${style.italic ? "i" : ""}`, style);
  };
  note({ family: DEFAULT_FAMILY, bold: false, italic: false, size: DEFAULT_BODY_SIZE });
  // `tokenize`'s own literal style for a `variable` placeholder token —
  // italic, to read visibly differently from a `fieldAnchor` one. Not
  // derivable by walking marks (a variable run carries none), so it has to
  // be listed here explicitly, same as the default note above it.
  note({ family: DEFAULT_FAMILY, bold: false, italic: true, size: DEFAULT_BODY_SIZE });

  const walkInline = (content: DocumentInlineContent): void => {
    for (const run of content) {
      if (run.kind === "text") note(styleFromMarks(run.marks));
      // fieldAnchor tokens draw in the default (non-italic) style, already
      // covered by the unconditional note above.
    }
  };
  const walkBlock = (block: DocumentBlock): void => {
    if (block.kind === "paragraph") { walkInline(block.content); return; }
    if (block.kind === "heading") {
      for (const run of block.content) {
        if (run.kind === "text") note({ ...styleFromMarks(run.marks), bold: true });
      }
      return;
    }
    if (block.kind === "orderedList") {
      for (const item of block.content) for (const child of item.content) walkBlock(child);
    }
  };
  for (const block of doc.content) walkBlock(block);

  return [...seen.values()];
}

export function layoutFlowDocument(doc: FlowDocument, measure: MeasureFn): FlowLayoutResult {
  const cursor = new Cursor();
  const counters: number[] = [];

  for (const block of doc.content) {
    layoutBlock(cursor, block, measure, 0, counters);
  }

  return {
    pageCount: cursor.page + 1,
    drawOps: cursor.drawOps,
    resolvedAnchors: cursor.resolvedAnchors,
  };
}
