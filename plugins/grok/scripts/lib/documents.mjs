const DOC_TYPES = new Set(["docx", "pdf", "pptx", "dotx"]);

export function normalizeDocumentType(type) {
  const t = String(type || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  if (!DOC_TYPES.has(t)) {
    throw new Error(`Invalid --type: ${type}. Expected one of docx, pdf, pptx`);
  }
  // map dotx to docx skill family
  return t === "dotx" ? "docx" : t;
}

/**
 * Build prompt that invokes Grok's bundled docx/pdf/pptx skills.
 */
export function buildDocumentPrompt({ type, brief, outputDir }) {
  const docType = normalizeDocumentType(type);
  const task = String(brief || "").trim();
  if (!task) {
    throw new Error("Document brief/prompt is required");
  }
  const out = outputDir || ".grok/docs";

  const skillHint =
    docType === "pptx"
      ? "Use the bundled pptx skill to create a professional PowerPoint deck."
      : docType === "pdf"
        ? "Use the bundled pdf skill to create a polished PDF document."
        : "Use the bundled docx skill to create a Word document.";

  return [
    skillHint,
    "",
    `Document type: ${docType}`,
    `Write the finished file under the project directory: ${out}/`,
    "Create the directory if needed. Prefer a descriptive filename.",
    "",
    "Brief:",
    task,
    "",
    "When done, print the absolute path to the created file clearly as:",
    "DOCUMENT_PATH=<absolute-path>",
    "Do not modify unrelated source code."
  ].join("\n");
}
