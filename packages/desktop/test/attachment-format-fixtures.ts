import { deflateRawSync } from "node:zlib"

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
export function zipFixture(entries: Array<{ name: string; text: string | Buffer; flags?: number; advertisedSize?: number }>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = Buffer.isBuffer(entry.text) ? entry.text : Buffer.from(entry.text), compressed = deflateRawSync(bytes)
    const header = Buffer.alloc(30), directory = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(entry.flags ?? 0x800, 6); header.writeUInt16LE(8, 8)
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(entry.advertisedSize ?? bytes.length, 22); header.writeUInt16LE(name.length, 26)
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(entry.flags ?? 0x800, 8); directory.writeUInt16LE(8, 10)
    directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(entry.advertisedSize ?? bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42)
    local.push(header, name, compressed); central.push(directory, name); offset += header.length + name.length + compressed.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
export function officeFixture(kind: "docx" | "xlsx" | "pptx", text = "attachment marker & readable"): Buffer {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  const part = kind === "docx" ? { name: "word/document.xml", text: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p></w:body></w:document>` }
    : kind === "xlsx" ? { name: "xl/worksheets/sheet1.xml", text: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="inlineStr"><is><t>${escaped}</t></is></c><c><v>42</v></c></row></sheetData></worksheet>` }
      : { name: "ppt/slides/slide1.xml", text: `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:p><a:r><a:t>${escaped}</a:t></a:r></a:p></p:cSld></p:sld>` }
  const mainPart = kind === "docx" ? "word/document.xml" : kind === "xlsx" ? "xl/workbook.xml" : "ppt/presentation.xml"
  const mainType = kind === "docx" ? "wordprocessingml.document" : kind === "xlsx" ? "spreadsheetml.sheet" : "presentationml.presentation"
  const supporting = kind === "xlsx" ? [
    { name: "xl/workbook.xml", text: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: "xl/_rels/workbook.xml.rels", text: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
  ] : kind === "pptx" ? [
    { name: "ppt/presentation.xml", text: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>' },
    { name: "ppt/_rels/presentation.xml.rels", text: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>' },
  ] : []
  return zipFixture([
    { name: "[Content_Types].xml", text: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${mainPart}" ContentType="application/vnd.openxmlformats-officedocument.${mainType}.main+xml"/></Types>` },
    { name: "_rels/.rels", text: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPart}"/></Relationships>` }, part, ...supporting,
  ])
}
/** A real one-page PDF with a correct byte-offset xref table and Helvetica text. */
export function pdfFixture(text = "attachment marker"): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj ET`
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]
  let content = "%PDF-1.7\n", offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(content)); content += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(content)
  content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(content)
}
