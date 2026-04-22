// Tiny markdown renderer for Pip's AI-generated replies. Covers the
// subset Claude actually emits: bold, italic, inline code, fenced code
// blocks, bullet/ordered lists, paragraphs. No links (Pip rarely emits
// them; adding them would invite a sanitization surface we don't need).
//
// Safety model: we never call innerHTML with unescaped user/model input.
// escHtml runs first; all regex substitutions operate on already-escaped
// text, inserting only a fixed vocabulary of tags. That's tighter than
// pulling in a general markdown lib + sanitizer.

export function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Process the text in passes, matching the block patterns line-by-line
// before inline patterns so a fenced code block's contents aren't
// accidentally bolded by a stray `**` inside it.
export function renderMd(text) {
  if (text == null) return "";
  // 1. Escape everything up front.
  let src = escHtml(text);

  // 2. Fenced code blocks ```lang\n…\n``` → <pre><code>…</code></pre>.
  //    Captured group stays HTML-escaped from step 1.
  src = src.replace(/```(?:[\w-]*)\n?([\s\S]*?)```/g, (_m, code) =>
    `<pre><code>${code.replace(/\n$/, "")}</code></pre>`);

  // 3. Lists — consecutive lines starting with "- " or "1. " become <ul>/<ol>.
  //    Done line-by-line so non-list text around them is untouched.
  const lines = src.split("\n");
  const out = [];
  let listTag = null;   // "ul" | "ol" | null
  const closeList = () => { if (listTag) { out.push(`</${listTag}>`); listTag = null; } };
  for (const line of lines) {
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul) {
      if (listTag !== "ul") { closeList(); out.push("<ul>"); listTag = "ul"; }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (listTag !== "ol") { closeList(); out.push("<ol>"); listTag = "ol"; }
      out.push(`<li>${ol[1]}</li>`);
    } else {
      closeList();
      out.push(line);
    }
  }
  closeList();
  src = out.join("\n");

  // 4. Inline patterns — bold, italic, inline code. Order matters: bold
  //    before italic (so ** isn't eaten as two single-*), inline code is
  //    isolated since backticks don't nest here.
  src = src
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

  // 5. Paragraphs + line breaks. Double newline separates paragraphs;
  //    single newline is a soft break inside a paragraph. Skip wrapping
  //    for content already inside block tags (pre, ul, ol).
  const blocks = src.split(/\n{2,}/).map(b => {
    const trimmed = b.trim();
    if (!trimmed) return "";
    if (/^<(pre|ul|ol|p)\b/.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
  });
  return blocks.filter(Boolean).join("\n");
}
