/**
 * A minimal, deterministic PDF writer. No dependencies, no fonts to embed.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN `npm i` A PDF LIBRARY
 * ---------------------------------------------------------------------------
 *
 * The single strongest property `src/lib/statements/**` has is that
 * re-rendering a closed day reproduces it **byte for byte**, forever, and that
 * a stored `content_hash` proves it. A PDF is a new serialisation of that same
 * document, and a serialisation that is not byte-stable would quietly retire
 * that guarantee at exactly the moment it starts being forwarded to people who
 * were not at the demo.
 *
 * Every general-purpose PDF library defeats byte-stability by default, in ways
 * that are not configuration mistakes but design choices:
 *
 *   - `/CreationDate` and `/ModDate` in the Info dictionary, taken from the
 *     clock.
 *   - a random `/ID` pair in the trailer (the spec literally suggests seeding
 *     it from the current time and the file path).
 *   - font **subsetting**: the embedded subset depends on the set of glyphs
 *     used and on the library's internal ordering, and the six-letter subset
 *     tag is conventionally random.
 *   - deflate streams, whose bytes depend on the zlib build and level.
 *
 * So this module writes PDF 1.4 directly, and refuses all four:
 *
 *   - **no dates anywhere in the file.** `/CreationDate` is optional; it is
 *     omitted. The document's own dates — the value date, the close, the issue
 *     time of the statement that was published — are *content*, drawn from
 *     immutable rows, and they are printed on the page.
 *   - **`/ID` is supplied by the caller**, and the statement path passes a
 *     fingerprint derived from the document's own content hashes. Same
 *     document, same id.
 *   - **the fourteen standard Type1 fonts only** (Helvetica, Helvetica-Bold,
 *     Courier, Courier-Bold), which every conforming reader has. Nothing is
 *     embedded, so nothing can vary by run, by machine or by font version.
 *     The widths below are Adobe's published AFM metrics, and they are used
 *     only for truncation and right-alignment.
 *   - **uncompressed content streams.** A statement is kilobytes of text; the
 *     compression would save nothing worth a non-reproducible byte, and an
 *     uncompressed stream has the side benefit that `strings file.pdf` shows an
 *     auditor every figure on the page.
 *
 * Everything else — object order, the xref, the layout arithmetic — is a pure
 * function of the input. `pdf.test.ts` asserts it by generating the same
 * statement twice and comparing the bytes.
 *
 * ---------------------------------------------------------------------------
 * COORDINATES ARE INTEGER POINTS, TOP-LEFT ORIGIN
 * ---------------------------------------------------------------------------
 *
 * PDF's own origin is bottom-left with real-valued coordinates. Both are
 * inconvenient here: top-down is how a statement is laid out, and real numbers
 * would put float formatting — `12.100000000000001` — into the file's bytes.
 * So this module takes integer points from the top-left and converts once, and
 * every number it emits is an integer.
 */

/* -------------------------------------------------------------------------- */
/* Font metrics                                                               */
/* -------------------------------------------------------------------------- */

/** The four standard faces this writer offers. Nothing is embedded. */
export type PdfFont = "regular" | "bold" | "mono" | "monoBold";

const BASE_FONT: Record<PdfFont, string> = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
  mono: "Courier",
  monoBold: "Courier-Bold",
};

const FONT_RESOURCE: Record<PdfFont, string> = {
  regular: "F1",
  bold: "F2",
  mono: "F3",
  monoBold: "F4",
};

/**
 * Adobe AFM advance widths, in 1/1000 em, for WinAnsi codes 32..126.
 *
 * Courier is monospaced at 600 and needs no table. These two are used to
 * right-align money columns and to truncate a merchant description to the
 * width of its cell — never to compute anything about money.
 */
const HELVETICA_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD_WIDTHS: readonly number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** The handful of WinAnsi codes above 126 that actually turn up in this data. */
const HIGH_WIDTHS: Record<number, readonly [number, number]> = {
  // code: [helvetica, helvetica-bold]
  128: [556, 556], // Euro
  133: [1000, 1000], // ellipsis
  134: [556, 556], // dagger
  145: [222, 278], // quoteleft
  146: [222, 278], // quoteright
  147: [333, 500], // quotedblleft
  148: [333, 500], // quotedblright
  149: [350, 350], // bullet
  150: [556, 556], // endash
  151: [1000, 1000], // emdash
  153: [1000, 1000], // trademark
};

/** Latin-1 letters and the rest of the upper half: close enough for truncation. */
const HIGH_DEFAULT = 556;

/**
 * The characters WinAnsiEncoding places between 128 and 159.
 *
 * Above 159 WinAnsi and Latin-1 agree, so a code point in 160..255 is its own
 * byte. Anything else this table does not name becomes `?` — a statement is
 * not the place to silently drop a character, and the standard fonts have no
 * glyph for it to drop to.
 */
const WINANSI_HIGH = new Map<string, number>([
  ["€", 128],
  ["‚", 130],
  ["ƒ", 131],
  ["„", 132],
  ["…", 133],
  ["†", 134],
  ["‡", 135],
  ["ˆ", 136],
  ["‰", 137],
  ["Š", 138],
  ["‹", 139],
  ["Œ", 140],
  ["Ž", 142],
  ["‘", 145],
  ["’", 146],
  ["“", 147],
  ["”", 148],
  ["•", 149],
  ["–", 150],
  ["—", 151],
  ["˜", 152],
  ["™", 153],
  ["š", 154],
  ["›", 155],
  ["œ", 156],
  ["ž", 158],
  ["Ÿ", 159],
]);

/**
 * Characters with an exact WinAnsi equivalent under a different code point.
 *
 * A typographic minus (U+2212) is not in WinAnsi and has no glyph in the
 * standard fonts. Falling through to `?` turned the caption
 * `as corrected − as published` into `as corrected ? as published` on a real
 * statement — a document explaining a subtraction, with the subtraction sign
 * replaced by a question mark. The hyphen-minus is the honest substitution.
 */
const WINANSI_FOLD = new Map<string, number>([
  ["−", 0x2d], // minus sign -> hyphen-minus
  ["‒", 0x2d], // figure dash
  ["·", 0xb7], // middle dot IS in WinAnsi, at its Latin-1 position
  ["′", 0x27],
  ["″", 0x22],
  [" ", 32], // no-break space
]);

/** One text string as WinAnsi code points. Unrepresentable characters become `?`. */
function toWinAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    const folded = WINANSI_FOLD.get(ch);
    if (folded !== undefined) {
      out.push(folded);
    } else if (code === 9) {
      out.push(32);
    } else if (code >= 32 && code <= 126) {
      out.push(code);
    } else if (code >= 160 && code <= 255) {
      out.push(code);
    } else {
      out.push(WINANSI_HIGH.get(ch) ?? 63);
    }
  }
  return out;
}

/** Advance width of one code, in 1/1000 em. */
function codeWidth(code: number, font: PdfFont): number {
  if (font === "mono" || font === "monoBold") return 600;
  const bold = font === "bold";
  if (code >= 32 && code <= 126) {
    const table = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
    return table[code - 32] ?? HIGH_DEFAULT;
  }
  const pair = HIGH_WIDTHS[code];
  if (pair !== undefined) return bold ? pair[1] : pair[0];
  return HIGH_DEFAULT;
}

/**
 * Width of a string at a size, in whole points, rounded UP.
 *
 * Up rather than nearest so a right-aligned figure never overhangs its column
 * by a rounding error, and so truncation is conservative. Integer points keep
 * every number in the file an integer.
 */
export function textWidth(text: string, font: PdfFont, size: number): number {
  let units = 0;
  for (const code of toWinAnsi(text)) units += codeWidth(code, font);
  return Math.ceil((units * size) / 1000);
}

/**
 * Cut a string to fit a width, with a real ellipsis rather than a hard chop.
 *
 * A truncated merchant name on a statement is a small loss; a merchant name
 * that silently overprints the amount column is a document an accountant
 * cannot read. The ellipsis says which happened.
 */
export function truncateToWidth(
  text: string,
  font: PdfFont,
  size: number,
  maxPoints: number,
): string {
  if (textWidth(text, font, size) <= maxPoints) return text;
  const ellipsis = "…";
  const budget = maxPoints - textWidth(ellipsis, font, size);
  if (budget <= 0) return ellipsis;

  const chars = [...text];
  let width = 0;
  let cut = 0;
  for (const ch of chars) {
    const w = textWidth(ch, font, size);
    if (width + w > budget) break;
    width += w;
    cut += 1;
  }
  return `${chars.slice(0, cut).join("")}${ellipsis}`;
}

/* -------------------------------------------------------------------------- */
/* Content streams                                                            */
/* -------------------------------------------------------------------------- */

/** A PDF literal string: escaped, and 7-bit clean so the file is all ASCII. */
function literal(text: string): string {
  let out = "(";
  for (const code of toWinAnsi(text)) {
    if (code === 0x28) out += "\\(";
    else if (code === 0x29) out += "\\)";
    else if (code === 0x5c) out += "\\\\";
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

/**
 * A PDF *text string* — the kind that goes in the Info dictionary.
 *
 * NOT the same encoding as a string inside a content stream. A content-stream
 * string is interpreted through the font's encoding (WinAnsi here); a document
 * text string is PDFDocEncoding unless it starts with a UTF-16BE byte-order
 * mark. They disagree above 0x7F — an em dash is 0x97 in WinAnsi and 0x84 in
 * PDFDocEncoding — which is exactly how `pdfinfo` came to report the title as
 * `Statement Š Ridgeline Robotics, Inc.`
 *
 * So: plain ASCII stays a literal, and anything else is emitted as UTF-16BE
 * hex with the BOM, which is unambiguous, universally supported and, being a
 * pure function of the string, still byte-stable.
 */
function textString(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return literal(value);
  let hex = "feff";
  for (let i = 0; i < value.length; i += 1) {
    hex += value.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return `<${hex}>`;
}

export type TextOptions = {
  readonly font?: PdfFont;
  readonly size?: number;
  /** 0 = black, 1000 = white. Thousandths, so the emitted number stays an integer. */
  readonly gray?: number;
  /** Where `x` sits relative to the text. Defaults to `left`. */
  readonly align?: "left" | "right";
};

/**
 * One page, laid out top-down in integer points.
 *
 * The page holds its own content-stream operators as strings and knows nothing
 * about object numbering or offsets — `PdfDocument` does that when it
 * serialises.
 */
export class PdfPage {
  private readonly ops: string[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  /** A filled rectangle, from the top-left. Used for rules and row shading. */
  fill(x: number, y: number, w: number, h: number, gray: number): void {
    const bottom = this.height - y - h;
    this.ops.push(
      `q ${grayOp(gray)} ${int(x)} ${int(bottom)} ${int(w)} ${int(h)} re f Q`,
    );
  }

  /** A hairline rule. A 1pt filled rect, because a stroked line is not crisper. */
  rule(x: number, y: number, w: number, gray = 800): void {
    this.fill(x, y, w, 1, gray);
  }

  /** One line of text, with `y` the BASELINE, measured from the top of the page. */
  text(x: number, y: number, value: string, options: TextOptions = {}): void {
    if (value === "") return;
    const font = options.font ?? "regular";
    const size = options.size ?? 9;
    const gray = options.gray ?? 0;
    const left =
      options.align === "right" ? x - textWidth(value, font, size) : x;
    const baseline = this.height - y;
    this.ops.push(
      `BT ${grayOp(gray)} /${FONT_RESOURCE[font]} ${int(size)} Tf ` +
        `1 0 0 1 ${int(left)} ${int(baseline)} Tm ${literal(value)} Tj ET`,
    );
  }

  /** The content stream, exactly as it will be written. */
  content(): string {
    return `${this.ops.join("\n")}\n`;
  }
}

/** Gray as a thousandths integer, emitted as a PDF real without float noise. */
function grayOp(thousandths: number): string {
  const clamped = Math.max(0, Math.min(1000, Math.round(thousandths)));
  if (clamped === 0) return "0 g";
  if (clamped === 1000) return "1 g";
  const whole = Math.floor(clamped / 1000);
  const frac = (clamped % 1000).toString().padStart(3, "0");
  return `${whole}.${frac} g`;
}

function int(value: number): string {
  return String(Math.round(value));
}

/* -------------------------------------------------------------------------- */
/* The document                                                               */
/* -------------------------------------------------------------------------- */

export type PdfDocumentOptions = {
  /** `/Title` in the Info dictionary. Content, so it must be stable. */
  readonly title: string;
  /** `/Subject`. Stable. */
  readonly subject: string;
  /**
   * The trailer `/ID`, as lowercase hex.
   *
   * Supplied rather than generated: a random id is the commonest reason two
   * renderings of the same document differ byte for byte. The statement path
   * passes a fingerprint of the document's own content hashes.
   */
  readonly documentId: string;
};

/** US Letter, because this is a US product. Points. */
export const LETTER_WIDTH = 612;
export const LETTER_HEIGHT = 792;

export class PdfDocument {
  private readonly pages: PdfPage[] = [];

  constructor(private readonly options: PdfDocumentOptions) {}

  addPage(): PdfPage {
    const page = new PdfPage(LETTER_WIDTH, LETTER_HEIGHT);
    this.pages.push(page);
    return page;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /**
   * The pages, in order.
   *
   * Exposed because a footer that says "page 1 of 3" cannot be written until
   * the 3 is known, which is after every page has been laid out. Returned
   * readonly: the caller may draw on a page, never reorder the document.
   */
  get allPages(): readonly PdfPage[] {
    return this.pages;
  }

  /**
   * Serialise.
   *
   * Object numbering is fixed and positional: 1 catalog, 2 pages, 3 info,
   * 4..7 the four fonts, then two objects per page. Nothing here consults a
   * clock, a random source or the environment.
   */
  toBytes(): Uint8Array {
    if (this.pages.length === 0) throw new Error("a PDF needs at least one page");

    const fontObjects = 4;
    const firstPageObject = 8;
    const objects: string[] = [];
    const pageIds = this.pages.map((_, i) => firstPageObject + i * 2);

    objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
    objects.push(
      `<< /Type /Pages /Count ${this.pages.length} ` +
        `/Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
    );
    // No /CreationDate and no /ModDate. See the module note: a timestamp here
    // is the difference between a reproducible artefact and a plausible one.
    objects.push(
      `<< /Title ${textString(this.options.title)} ` +
        `/Subject ${textString(this.options.subject)} ` +
        `/Producer ${textString("Corgi ledger - generated from journal entries")} ` +
        `/Creator ${textString("Corgi ledger")} >>`,
    );
    for (let i = 0; i < fontObjects; i += 1) {
      const font = (["regular", "bold", "mono", "monoBold"] as const)[i] as PdfFont;
      objects.push(
        `<< /Type /Font /Subtype /Type1 /BaseFont /${BASE_FONT[font]} ` +
          `/Encoding /WinAnsiEncoding >>`,
      );
    }

    const fontResource = (["regular", "bold", "mono", "monoBold"] as const)
      .map((f, i) => `/${FONT_RESOURCE[f]} ${4 + i} 0 R`)
      .join(" ");

    for (const page of this.pages) {
      const streamId = objects.length + 2;
      objects.push(
        `<< /Type /Page /Parent 2 0 R ` +
          `/MediaBox [0 0 ${page.width} ${page.height}] ` +
          `/Resources << /Font << ${fontResource} >> >> ` +
          `/Contents ${streamId} 0 R >>`,
      );
      const content = page.content();
      objects.push(
        `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
      );
    }

    let body = "%PDF-1.4\n";
    // A binary comment marks the file as binary for transports that sniff.
    // Fixed bytes, so it costs nothing in reproducibility.
    body += "%âãÏÓ\n";

    const offsets: number[] = [];
    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(body, "latin1"));
      body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });

    const xrefOffset = Buffer.byteLength(body, "latin1");
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      xref += `${offset.toString().padStart(10, "0")} 00000 n \n`;
    }

    const id = `<${this.options.documentId}>`;
    const trailer =
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R ` +
      `/ID [${id} ${id}] >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    return new Uint8Array(Buffer.from(body + xref + trailer, "latin1"));
  }
}
