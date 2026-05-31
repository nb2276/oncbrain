// v0.11 PR-1a: safe JSON serialization for inlining into <script
// type="application/json"> blocks via Astro's `set:html` directive.
//
// JSON.stringify does NOT escape `</script>`, `<!--`, or the U+2028/
// U+2029 line-separator characters. Those characters can break out of
// the script tag or terminate JavaScript expression contexts. The
// current inputs (modality/intent/methodology slugs gated by
// isSafeTagSlug, intersection paths built from those same slugs) cannot
// contain those sequences, but the contract is "anything that flows
// into a JSON blob inlined via set:html." A future caller passing an
// unconstrained string (study name, conference long-name, etc.) would
// silently ship an XSS sink.
//
// This helper closes the contract. Callers wrap the JSON output:
//   <script type="application/json" set:html={jsonForScriptTag(data)} />

export function jsonForScriptTag(value: unknown): string {
  // U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are valid
  // JSON but terminate JavaScript string expressions in ES5 (most
  // browsers honor ES5 here even for JSON.parse). Escape both alongside
  // the HTML-meaningful "<" which neutralizes "</script>", "<!--",
  // and "<![CDATA[".
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
