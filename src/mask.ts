/** Mask contact details before a question is written to the log. */
export function maskPII(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?\d[\d\s-]{7,}\d)/g, "[phone]");
}
