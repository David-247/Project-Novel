// Renders the first pages of a PDF to PNG with Apple's PDFKit (the engine Preview uses), for the
// Phase 4 manual check on macOS CI (.github/workflows/ci.yml, e2e job): the exported manuscript's
// title page, running headers and page numbers as macOS draws them.
// Usage: swift scripts/render-pdf-pages.swift <in.pdf> <out-dir> [pages=4]
import AppKit
import PDFKit

let args = CommandLine.arguments
guard args.count >= 3, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
  FileHandle.standardError.write("usage: render-pdf-pages.swift <in.pdf> <out-dir> [pages]; or the PDF does not open\n".data(using: .utf8)!)
  exit(1)
}
let outDir = URL(fileURLWithPath: args[2], isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let count = min(doc.pageCount, args.count > 3 ? Int(args[3]) ?? 4 : 4)
let base = URL(fileURLWithPath: args[1]).deletingPathExtension().lastPathComponent
let scale: CGFloat = 2
for i in 0..<count {
  guard let page = doc.page(at: i) else { continue }
  let box = page.bounds(for: .mediaBox)
  let size = NSSize(width: box.width * scale, height: box.height * scale)
  let image = NSImage(size: size)
  image.lockFocus()
  NSColor.white.setFill()
  NSRect(origin: .zero, size: size).fill()
  let ctx = NSGraphicsContext.current!.cgContext
  ctx.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: ctx)
  image.unlockFocus()
  guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
  let out = outDir.appendingPathComponent("\(base)-p\(i + 1).png")
  try png.write(to: out)
  print(out.path)
}
