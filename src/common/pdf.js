// A small dependency-free PDF writer for invoices, receipts and production
// sheets: A4 pages of positioned text, rules and simple tables in Helvetica.
// Text is limited to WinAnsi characters; "₹" is written as "Rs.".

const A4 = { width: 595.28, height: 841.89 };

function escapeText(text) {
  return String(text ?? "")
    .replace(/₹/g, "Rs.")
    .replace(/[^\x20-\x7E]/g, (char) => ({ "–": "-", "—": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "•": "*", "…": "..." }[char] || "?"))
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

// Average Helvetica glyph width (≈0.5em) – good enough for right-aligning numbers.
export function textWidth(text, size) {
  return String(text ?? "").length * size * 0.5;
}

export class PdfDocument {
  constructor({ margin = 40 } = {}) {
    this.margin = margin;
    this.pages = [];
    this.addPage();
  }

  addPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = A4.height - this.margin;
    return this;
  }

  ensureSpace(height) {
    if (this.y - height < this.margin) this.addPage();
  }

  text(value, { x = this.margin, size = 10, bold = false, align = "left", width = null } = {}) {
    let left = x;
    if (align === "right") left = (width != null ? x + width : A4.width - this.margin) - textWidth(value, size);
    if (align === "center") left = (A4.width - textWidth(value, size)) / 2;
    this.ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${left.toFixed(2)} ${this.y.toFixed(2)} Td (${escapeText(value)}) Tj ET`);
    return this;
  }

  line(text, options = {}) {
    const size = options.size || 10;
    this.ensureSpace(size + 6);
    this.text(text, options);
    this.y -= size + (options.gap ?? 5);
    return this;
  }

  rule({ gap = 8 } = {}) {
    this.ensureSpace(gap * 2);
    this.y -= gap / 2;
    this.ops.push(`0.8 w ${this.margin} ${this.y.toFixed(2)} m ${(A4.width - this.margin).toFixed(2)} ${this.y.toFixed(2)} l S`);
    this.y -= gap;
    return this;
  }

  space(height = 8) {
    this.y -= height;
    return this;
  }

  /** columns: [{ header, width, align }]; rows: arrays of cell text. */
  table(columns, rows, { size = 9 } = {}) {
    const drawRow = (cells, bold) => {
      this.ensureSpace(size + 8);
      let x = this.margin;
      cells.forEach((cell, index) => {
        const column = columns[index];
        this.text(cell, { x, size, bold, align: column.align || "left", width: column.width - 4 });
        x += column.width;
      });
      this.y -= size + 6;
    };
    drawRow(columns.map((column) => column.header), true);
    this.rule({ gap: 4 });
    for (const row of rows) drawRow(row, false);
    return this;
  }

  toBuffer() {
    const objects = [];
    const add = (body) => {
      objects.push(body);
      return objects.length;
    };
    const catalog = add(null);
    const pagesId = add(null);
    const font1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const font2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds = [];
    for (const ops of this.pages) {
      const stream = ops.join("\n");
      const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

    let out = "%PDF-1.4\n";
    const offsets = [];
    objects.forEach((body, index) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, "latin1");
  }
}

export function rupees(paise) {
  const value = (Number(paise || 0) / 100).toFixed(2);
  const [whole, fraction] = value.split(".");
  // Indian digit grouping: 12,34,567.89
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `Rs. ${rest ? `${rest},${last3}` : last3}.${fraction}`;
}
