/** Glasses text as one paste: nothing in it can end the paste or act as a key. */
export function pasteText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/**
 * A background reply is confirmed by finding its text, whole, on Claude's input
 * line, so it must be a text Claude echoes verbatim: one line (Ctrl+U clears
 * one), and short enough that Claude does not fold the paste into a
 * `[Pasted text #1 ...]` chip, which no echo check could tell from any other.
 */
export const BG_MAX_CHARS = 600;

/** The sanitised text of a background reply, or undefined when it cannot be confirmed on screen. */
export function bgReplyText(text: unknown): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const clean = pasteText(text);
  if (clean.trim().length === 0 || clean.includes("\n") || [...clean].length > BG_MAX_CHARS) {
    return undefined;
  }
  return clean;
}
