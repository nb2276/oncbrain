// On-device OCR via Apple Vision framework.
// Usage: vision-ocr <image-path>
// Prints recognized text to stdout, one line per text observation.
// Non-zero exit on failure; stderr carries the reason.
//
// Build:  swiftc scripts/vision-ocr.swift -o scripts/vision-ocr
// Macros: macOS-only. Bundled at build time, not at runtime.

import Vision
import AppKit
import Foundation

func die(_ msg: String, code: Int32) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8) ?? Data())
    exit(code)
}

guard CommandLine.arguments.count >= 2 else {
    die("Usage: vision-ocr <image-path>", code: 1)
}

let path = CommandLine.arguments[1]

guard let img = NSImage(contentsOfFile: path) else {
    die("Could not load image at: \(path)", code: 2)
}
guard let cgImg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    die("Could not get CGImage from: \(path)", code: 2)
}

let req = VNRecognizeTextRequest { req, _ in
    let observations = (req.results as? [VNRecognizedTextObservation]) ?? []
    let lines = observations.compactMap { $0.topCandidates(1).first?.string }
    // One line per text observation, preserving Vision's natural line splitting.
    print(lines.joined(separator: "\n"))
}
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
// Don't reject low-confidence text — clinical slides often have small/dense
// chart labels that come back with lower confidence but are still useful.
req.minimumTextHeight = 0.0

do {
    try VNImageRequestHandler(cgImage: cgImg).perform([req])
} catch {
    die("OCR failed: \(error.localizedDescription)", code: 3)
}
