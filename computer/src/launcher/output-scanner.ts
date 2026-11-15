/** Escape-sequence parser states; a sequence may end in a later chunk than it starts. */
type ParseState = "text" | "esc" | "esc_intermediate" | "csi" | "string" | "string_esc";

/** An OSC or DCS longer than this is taken as unterminated, so it cannot hide all later output. */
const MAX_STRING = 4096;

/** Whitespace runs collapse to one space, so markers match however the TUI spaced them. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * Command-scoped output matching. A typist creates one at a command's first
 * write, so only output that follows the write can satisfy a marker. ANSI CSI,
 * OSC, DCS and other control strings are stripped as they arrive; a cursor
 * forward counts as a space, since TUIs use it in place of blanks. Only a
 * bounded tail is kept.
 */
export class OutputScanner {
  private tail = "";
  private state: ParseState = "text";
  private csiParams = "";
  private stringLength = 0;
  private readonly watched = new Set<string>();
  private readonly hits = new Set<string>();

  /** `maxBytes` bounds the kept tail, in UTF-16 code units of stripped text. */
  constructor(private readonly maxBytes = 8192) {}

  /** The stripped, bounded text kept so far. */
  get text(): string {
    return this.tail;
  }

  push(chunk: string): void {
    let plain = "";
    for (const ch of chunk) {
      plain += this.feed(ch);
    }
    if (plain.length === 0) {
      return;
    }
    this.tail = normalize(this.tail + plain);
    // Watched markers are checked before the trim, so none is lost to it.
    for (const marker of this.watched) {
      if (!this.hits.has(marker) && this.tail.includes(marker)) {
        this.hits.add(marker);
      }
    }
    if (this.tail.length > this.maxBytes) {
      this.tail = this.tail.slice(this.tail.length - this.maxBytes);
    }
  }

  /** True once `marker` has appeared in output pushed since construction. Asking starts watching it. */
  seen(marker: string): boolean {
    const wanted = normalize(marker);
    if (this.hits.has(wanted)) {
      return true;
    }
    this.watched.add(wanted);
    if (this.tail.includes(wanted)) {
      this.hits.add(wanted);
      return true;
    }
    return false;
  }

  /** The visible text a character contributes, after the escape state it moves through. */
  private feed(ch: string): string {
    switch (this.state) {
      case "text":
        if (ch === "\x1b") {
          this.state = "esc";
          return "";
        }
        if (ch === "\x9b") {
          this.state = "csi";
          this.csiParams = "";
          return "";
        }
        if (ch === "\x9d" || ch === "\x90") {
          this.state = "string";
          this.stringLength = 0;
          return "";
        }
        if (ch === "\n" || ch === "\r" || ch === "\t") {
          return " ";
        }
        return ch < " " || ch === "\x7f" ? "" : ch;
      case "esc":
        if (ch === "[") {
          this.state = "csi";
          this.csiParams = "";
        } else if (ch === "]" || ch === "P" || ch === "X" || ch === "^" || ch === "_") {
          this.state = "string";
          this.stringLength = 0;
        } else if (ch >= " " && ch <= "/") {
          this.state = "esc_intermediate";
        } else {
          this.state = "text";
        }
        return "";
      case "esc_intermediate":
        // ESC ( B and the like: intermediates, then one final byte.
        if (ch < " " || ch > "/") {
          this.state = "text";
        }
        return "";
      case "csi":
        if (ch >= "@" && ch <= "~") {
          this.state = "text";
          return ch === "C" ? " " : "";
        }
        this.csiParams += ch;
        if (this.csiParams.length > 64) {
          // Not a real sequence; drop it rather than swallow the output after it.
          this.state = "text";
        }
        return "";
      case "string":
        this.stringLength += 1;
        if (ch === "\x07" || ch === "\x9c" || this.stringLength > MAX_STRING) {
          this.state = "text";
        } else if (ch === "\x1b") {
          this.state = "string_esc";
        }
        return "";
      case "string_esc":
        // ESC \ is the string terminator; any other ESC starts a new sequence.
        if (ch === "\\") {
          this.state = "text";
          return "";
        }
        this.state = "esc";
        return this.feed(ch);
    }
  }
}
