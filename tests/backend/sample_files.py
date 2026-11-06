"""Real files generated for tests (no binary fixtures checked in)."""

from __future__ import annotations

import io
import zipfile


def pdf_bytes(pages: list[str]) -> bytes:
    """A minimal valid PDF with one line of Helvetica text per page (offsets computed exactly)."""
    objects: list[bytes] = []
    page_ids = [3 + i * 2 for i in range(len(pages))]
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    font_id = 3 + len(pages) * 2
    for i, text in enumerate(pages):
        content_id = page_ids[i] + 1
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_id} 0 R "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode()
        )
        safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({safe}) Tj ET".encode()
        objects.append(
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
        )
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for n, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def docx_bytes() -> bytes:
    import docx

    d = docx.Document()
    d.add_heading("Quarterly Report", level=1)
    d.add_paragraph("Revenue grew by 12 percent in the third quarter.")
    d.add_paragraph("Hire two engineers", style="List Bullet")
    table = d.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Region"
    table.cell(0, 1).text = "Sales"
    table.cell(1, 0).text = "North"
    table.cell(1, 1).text = "420"
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def xlsx_bytes() -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Budget"
    ws.append(["Item", "Cost"])
    ws.append(["Laptop", 950])
    ws.append(["Total", "=SUM(B2:B2)"])  # formula: never evaluated, cached value is empty
    other = wb.create_sheet("Notes")
    other.append(["Approved by finance"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def png_bytes(width: int = 40, height: int = 30) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (width, height), (10, 120, 130)).save(buf, format="PNG")
    return buf.getvalue()


def zip_bomb_docx() -> bytes:
    """Looks like a DOCX but one entry expands ~1000x (20 MB of zeros)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("word/document.xml", "<w:document/>")
        zf.writestr("word/media/huge.bin", b"\x00" * (20 * 1024 * 1024))
    return buf.getvalue()
