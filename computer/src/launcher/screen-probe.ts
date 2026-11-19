/**
 * A deliberately small model of what Claude's terminal shows, and a probe with
 * ONE job: say, positively, that text the launcher just pasted is sitting on
 * Claude's input line, inside the framed prompt box, with no dialog around it.
 *
 * It is never asked whether Claude is idle (the absence of a busy sign proves
 * nothing, and a screen model cannot tell a finished turn from one that is
 * about to continue). Every doubt is `unknown`, and unknown means "do not press
 * Enter": an escape sequence that is incomplete or not understood, a switch of
 * screen, a resize, and a character whose width the model cannot be sure of.
 */

const MAX_STRING = 4096;
const MAX_PARAMS = 64;
/** The probe does not trust a screen narrower than this to be Claude's layout. */
const MIN_COLS = 40;
/** Rows above the input box that are looked at for a running-turn sign (spinner, `esc to interrupt`) or a dialog's text. */
const STATUS_ROWS = 8;
/** The most rows the input line may wrap over. */
const MAX_INPUT_ROWS = 10;

/** SGR attributes that change nothing about whether text is muted (bold, italic, underline, blink, inverse, strike and their resets). */
const KNOWN_SGR: ReadonlySet<number> = new Set([1, 3, 4, 5, 6, 7, 8, 9, 21, 23, 24, 25, 27, 28, 29, 53, 55, 59]);

/** Prefixes the cell of a muted character; never a character a terminal would draw. */
const MUTED = "\u0001";
/** Prefixes (after MUTED) the cell of a character drawn in inverse video: the cursor, in Claude's input line. */
const INVERSE = "\u0002";

type ParseState ="text" | "esc" | "esc_intermediate" | "csi" | "string" | "string_esc";

/** Private modes that change nothing this model draws. */
const BENIGN_PRIVATE_MODES: ReadonlySet<number> = new Set([
  7, // autowrap on; switching it off is a taint, since the model always wraps
  12, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004, 2026,
  // Seen from the real Claude Code 2.1.285 at startup: colour-scheme reports and pixel mouse.
  1016, 2031,
]);
const ALT_SCREEN_MODES: ReadonlySet<number> = new Set([47, 1047, 1049]);

/** Display width of one character: 0 (combining), 1, 2 (wide), or undefined when the model cannot be sure. */
function charWidth(ch: string): 0 | 1 | 2 | undefined {
  const code = ch.codePointAt(0) as number;
  if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef)) {
    return undefined; // joiners and variation selectors change what a sequence is drawn as
  }
  if (/^[\p{Mn}\p{Me}\p{Cf}]$/u.test(ch)) {
    return 0;
  }
  if (/^\p{Extended_Pictographic}$/u.test(ch) || (code >= 0x1f1e6 && code <= 0x1f1ff)) {
    return undefined; // emoji: one cell or two depending on the terminal
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/**
 * Follows a child's output into a grid of rows: printable text with its
 * display width, CR, LF, BS, tab, cursor moves and positions, erases, line
 * insert and delete, scroll, save and restore. Anything else that could move
 * or change what is on screen is counted in `taints` and so makes every answer
 * for a screen drawn before it `unknown` to a caller that asks.
 */
export class ScreenModel {
  private grid: string[][] = [];
  /** A row holding a character whose cells the model is not sure of. */
  /**
   * Per row, the columns whose width the model cannot be sure of (an emoji, a joiner, a variation selector, half
   * of a wide character written over), with the codepoint there. Per cell, not per row: a cell written over or
   * erased is certain again, so a glyph that once stood where the box now is leaves nothing behind.
   */
  private dubious: Array<Map<number, number>> = [];
  private row = 0;
  private col = 0;
  private saved = { row: 0, col: 0 };
  private state: ParseState = "text";
  private params = "";
  private intermediates = "";
  private stringLength = 0;
  private alt = false;
  /** The main screen's cells while the alternate one is shown. */
  private mainBuffer?: { grid: string[][]; dubious: Array<Map<number, number>>; row: number; col: number; saved: { row: number; col: number } };
  private taintCount = 0;
  /** The taint count when the whole screen was last erased: what happened before it no longer matters. */
  private cleanFrom = 0;
  /** SGR state: text drawn now is muted (faint or a gray foreground), as placeholders and suggestions are. */
  private faint = false;
  private grayFg = false;
  private inverse = false;

  constructor(
    private cols = 80,
    private rows = 24,
  ) {
    this.clear();
  }

  get width(): number {
    return this.cols;
  }

  /** Events since the start that made the screen untrustworthy; compare two reads of it. */
  get taints(): number {
    return this.taintCount;
  }

  /**
   * The screen may not be what the model holds: something it cannot follow (a
   * resize, an unknown sequence, a switch of screens, a reset) happened and no
   * whole-screen erase has been drawn since, which is what rewrites every cell.
   * Nothing is ever baselined against this; a screen that is tainted is refused.
   */
  get tainted(): boolean {
    return this.taintCount > this.cleanFrom;
  }

  /** Whether the alternate screen is the one showing (the model follows it as it does the main one). */
  get alternate(): boolean {
    return this.alt;
  }

  /** Right now: the child is in the middle of an escape sequence. */
  get unsettled(): boolean {
    return this.state !== "text";
  }

  resize(cols: number, rows: number): void {
    this.taint();
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.grid = Array.from({ length: this.rows }, (_, i) => this.fit(this.grid[i] ?? []));
    this.dubious = Array.from({ length: this.rows }, (_, i) => this.dubious[i] ?? new Map());
    this.row = Math.min(this.row, this.rows - 1);
    this.col = Math.min(this.col, this.cols - 1);
    const main = this.mainBuffer;
    if (main) {
      main.grid = Array.from({ length: this.rows }, (_, i) => this.fit(main.grid[i] ?? []));
      main.dubious = Array.from({ length: this.rows }, (_, i) => main.dubious[i] ?? new Map());
      main.row = Math.min(main.row, this.rows - 1);
      main.col = Math.min(main.col, this.cols - 1);
    }
  }

  /** The visible rows, trailing blanks removed. */
  lines(): string[] {
    return this.grid.map((cells) => cells.join("").split(MUTED).join("").split(INVERSE).join("").replace(/\s+$/, ""));
  }

  /**
   * The visible rows with every muted character blanked: what is on screen that is not a placeholder or a
   * suggestion. The cursor is drawn as the character under it in inverse video, so on the first letter of
   * a suggestion it is the suggestion's own letter. An inverse letter counts as muted only in that one
   * shape: it is the first cell after the prompt glyph and its one space, and every other non-blank cell
   * of the row is muted (and there is some muted text after it: a lone inverse letter is a typed one).
   * An inverse letter anywhere else, or with solid text after it, is text: the probe fails closed.
   */
  solidLines(): string[] {
    const bare = (cell: string): string => cell.split(MUTED).join("").split(INVERSE).join("");
    return this.grid.map((cells) => {
      const glyph = cells.findIndex((cell) => /^[>❯]$/.test(bare(cell)));
      const lead = glyph < 0 ? -1 : glyph + 2;
      const cursorOnSuggestion = (index: number): boolean =>
        glyph >= 0 &&
        index === lead &&
        cells.slice(0, glyph).every((cell) => bare(cell).trim() === "" || /^[│┃]$/.test(bare(cell))) &&
        /^\s$/.test(bare(cells[glyph + 1] ?? "")) &&
        cells.slice(index + 1).every((cell) => bare(cell).trim() === "" || cell.startsWith(MUTED)) &&
        // A lone inverse letter with nothing muted after it is a typed letter, not a cursor on a suggestion.
        (bare(cells[index]).trim() === "" || cells.slice(index + 1).some((cell) => cell.startsWith(MUTED) && bare(cell).trim() !== ""));
      return cells
        .map((cell, index) => {
          const blanked = cell.startsWith(MUTED) || (cell.includes(INVERSE) && cursorOnSuggestion(index));
          return blanked ? " ".repeat(Math.max(1, [...bare(cell)].length)) : bare(cell);
        })
        .join("")
        .replace(/\s+$/, "");
    });
  }

  /** A cell of this row holds something whose width the model cannot be sure of (a column of it shifts what follows). */
  rowDubious(index: number): boolean {
    return (this.dubious[index]?.size ?? 0) > 0;
  }

  /** The first such cell of the row: its column and codepoint (never the text around it), for the log. */
  dubiousCell(index: number): { col: number; codepoint: number } | undefined {
    const first = [...(this.dubious[index] ?? [])].sort((a, b) => a[0] - b[0])[0];
    return first ? { col: first[0], codepoint: first[1] } : undefined;
  }

  push(chunk: string): void {
    for (const ch of chunk) {
      this.feed(ch);
    }
  }

  private taint(): void {
    this.taintCount += 1;
  }

  private fit(cells: string[]): string[] {
    const out = cells.slice(0, this.cols);
    while (out.length < this.cols) {
      out.push(" ");
    }
    return out;
  }

  private blankRow(): string[] {
    return this.fit([]);
  }

  private clear(): void {
    this.grid = Array.from({ length: this.rows }, () => this.blankRow());
    this.dubious = Array.from({ length: this.rows }, () => new Map());
    this.row = 0;
    this.col = 0;
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) {
      this.row += 1;
    } else {
      this.scrollUp(1);
    }
  }

  private scrollUp(count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.grid.shift();
      this.grid.push(this.blankRow());
      this.dubious.shift();
      this.dubious.push(new Map());
    }
  }

  private scrollDown(count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.grid.pop();
      this.grid.unshift(this.blankRow());
      this.dubious.pop();
      this.dubious.unshift(new Map());
    }
  }

  /** Cells from `from` to `to` (exclusive) are written over or erased: what stood there no longer shifts anything. */
  private certain(row: number, from: number, to: number): void {
    const marks = this.dubious[row];
    if (!marks || marks.size === 0) {
      return;
    }
    for (const col of [...marks.keys()]) {
      if (col >= from && col < to) {
        marks.delete(col);
      }
    }
  }

  private put(ch: string): void {
    const width = charWidth(ch);
    if (width === 0) {
      // A combining mark joins the cell before it.
      const col = Math.min(this.col, this.cols) - 1;
      if (col >= 0) {
        this.grid[this.row][col] += ch;
      }
      return;
    }
    const cells = width ?? 1;
    if (this.col + cells > this.cols) {
      if (cells === 2 && this.col < this.cols) {
        this.grid[this.row][this.col] = " ";
      }
      this.col = 0;
      this.lineFeed();
    }
    const cellsRow = this.grid[this.row];
    // What was in the cells now written is gone; what the write leaves unsure is marked again below.
    this.certain(this.row, this.col, this.col + cells);
    const code = ch.codePointAt(0) as number;
    // Writing over half of a wide character leaves the other half meaningless.
    // The codepoint of the wide character whose first cell is `col`, or none. What is logged for a half-gone wide
    // character is this one, never the character that wrote over it (which can be a letter of a draft).
    const wideCode = (col: number): number | undefined => {
      const cell = (cellsRow[col] ?? "").split(MUTED).join("").split(INVERSE).join("");
      return cell !== "" && charWidth([...cell][0]) === 2 ? (cell.codePointAt(0) as number) : undefined;
    };
    // The right half of a wide character (an empty cell after one) written over: its left half is meaningless.
    const leftOfRight = cellsRow[this.col] === "" && this.col > 0 ? wideCode(this.col - 1) : undefined;
    if (leftOfRight !== undefined) {
      this.dubious[this.row].set(this.col - 1, leftOfRight);
    }
    // Its left half written over by one narrow cell: the right half is.
    const rightOfLeft = cells === 1 && cellsRow[this.col + 1] === "" ? wideCode(this.col) : undefined;
    if (rightOfLeft !== undefined) {
      this.dubious[this.row].set(this.col + 1, rightOfLeft);
    }
    if (width === undefined) {
      this.dubious[this.row].set(this.col, code);
    }
    cellsRow[this.col] = (this.faint || this.grayFg ? MUTED : "") + (this.inverse ? INVERSE : "") + ch;
    if (cells === 2) {
      cellsRow[this.col + 1] = "";
    }
    this.col += cells;
  }

  private feed(ch: string): void {
    switch (this.state) {
      case "text":
        if (ch === "\x1b") {
          this.state = "esc";
        } else if (ch === "\x9b") {
          this.state = "csi";
          this.params = "";
          this.intermediates = "";
        } else if (ch === "\x9d" || ch === "\x90" || ch === "\x98" || ch === "\x9e" || ch === "\x9f") {
          this.state = "string";
          this.stringLength = 0;
        } else if (ch === "\r") {
          this.col = 0;
        } else if (ch === "\n" || ch === "\x0b" || ch === "\x0c") {
          this.lineFeed();
        } else if (ch === "\b") {
          this.col = Math.max(0, Math.min(this.col, this.cols - 1) - 1);
        } else if (ch === "\t") {
          this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        } else if (ch === "\x0e") {
          this.taint(); // shift out: the other character set draws other glyphs
        } else if (ch === "\x0f") {
          // Shift in selects the default set, which is what the model draws; Claude sends it after `ESC ( B`.
        } else if (ch >= " " && ch !== "\x7f" && !(ch >= "\x80" && ch <= "\x9f")) {
          this.put(ch);
        }
        return;
      case "esc":
        if (ch === "[") {
          this.state = "csi";
          this.params = "";
          this.intermediates = "";
        } else if (ch === "]" || ch === "P" || ch === "X" || ch === "^" || ch === "_") {
          this.state = "string";
          this.stringLength = 0;
        } else if (ch >= " " && ch <= "/") {
          this.state = "esc_intermediate";
          this.intermediates = ch;
        } else {
          this.escape(ch);
          this.state = "text";
        }
        return;
      case "esc_intermediate":
        if (ch >= " " && ch <= "/") {
          this.intermediates += ch;
          if (this.intermediates.length > 4) {
            this.taint();
            this.state = "text";
          }
        } else {
          // `ESC ( B` selects ASCII; any other set (line drawing) would change what is drawn.
          const designation = /^[()*+]$/.test(this.intermediates);
          // `ESC # 8` (DECALN) fills the screen with E and the other `ESC #` sequences resize lines: all taint.
          if (!(designation && ch === "B")) {
            this.taint();
          }
          this.state = "text";
        }
        return;
      case "csi":
        if (ch >= "@" && ch <= "~") {
          this.state = "text";
          this.csi(ch, this.params, this.intermediates);
        } else if (ch >= " " && ch <= "/") {
          this.intermediates += ch;
        } else if ((ch >= "0" && ch <= "?") && this.intermediates === "") {
          this.params += ch;
          if (this.params.length > MAX_PARAMS) {
            this.taint();
            this.state = "text";
          }
        } else {
          // A control or a stray byte inside a sequence: the child's output is not what the model expects.
          this.taint();
          this.state = "text";
          this.feed(ch);
        }
        return;
      case "string":
        this.stringLength += 1;
        if (ch === "\x07" || ch === "\x9c") {
          this.state = "text";
        } else if (this.stringLength > MAX_STRING) {
          this.taint();
          this.state = "text";
        } else if (ch === "\x1b") {
          this.state = "string_esc";
        }
        return;
      case "string_esc":
        if (ch === "\\") {
          this.state = "text";
        } else {
          this.state = "esc";
          this.feed(ch);
        }
        return;
    }
  }

  private escape(final: string): void {
    switch (final) {
      case "7":
        this.saved = { row: this.row, col: this.col };
        break;
      case "8":
        this.row = this.saved.row;
        this.col = this.saved.col;
        break;
      case "c":
        // A full reset also resets modes and character sets the model does not track.
        this.clear();
        this.alt = false;
        this.mainBuffer = undefined;
        this.taint();
        break;
      case "D":
        this.lineFeed();
        break;
      case "E":
        this.col = 0;
        this.lineFeed();
        break;
      case "M":
        if (this.row > 0) {
          this.row -= 1;
        } else {
          this.scrollDown(1);
        }
        break;
      case "=":
      case ">":
      case "\\":
        break; // keypad modes; a stray string terminator
      default:
        this.taint();
        break;
    }
  }

  private csi(final: string, raw: string, intermediates: string): void {
    const prefix = /^[<=>?]/.test(raw) ? raw[0] : "";
    const body = prefix ? raw.slice(1) : raw;
    const args = body.split(";").map((part) => (part === "" ? NaN : Number.parseInt(part, 10)));
    if (prefix) {
      if (final === "h" || final === "l") {
        this.privateMode(final === "h", args, prefix);
      } else if (final === "J" || final === "K") {
        this.taint(); // selective erase: not modelled
      }
      // Keyboard protocol, modifyOtherKeys and device queries draw nothing.
      return;
    }
    if (intermediates !== "") {
      // `CSI Ps SP q` sets the cursor shape; anything else with an intermediate is not understood.
      if (!(intermediates === " " && final === "q")) {
        this.taint();
      }
      return;
    }
    const n = (index: number, fallback: number): number => {
      const value = args[index];
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    switch (final) {
      case "A":
        this.row = Math.max(0, this.row - n(0, 1));
        break;
      case "B":
        this.row = Math.min(this.rows - 1, this.row + n(0, 1));
        break;
      case "C":
        this.col = Math.min(this.cols - 1, this.col + n(0, 1));
        break;
      case "D":
        this.col = Math.max(0, Math.min(this.col, this.cols - 1) - n(0, 1));
        break;
      case "E":
        this.row = Math.min(this.rows - 1, this.row + n(0, 1));
        this.col = 0;
        break;
      case "F":
        this.row = Math.max(0, this.row - n(0, 1));
        this.col = 0;
        break;
      case "G":
        this.col = Math.min(this.cols - 1, n(0, 1) - 1);
        break;
      case "d":
        this.row = Math.min(this.rows - 1, n(0, 1) - 1);
        break;
      case "H":
      case "f":
        this.row = Math.min(this.rows - 1, n(0, 1) - 1);
        this.col = Math.min(this.cols - 1, n(1, 1) - 1);
        break;
      case "J": {
        const mode = Number.isFinite(args[0]) ? args[0] : 0;
        if (mode === 2) {
          this.grid = Array.from({ length: this.rows }, () => this.blankRow());
          this.dubious = Array.from({ length: this.rows }, () => new Map());
          // Every visible cell is now what the child draws next, whatever the model lost track of
          // before. Only this whole-screen erase heals a taint; on the alternate screen too, which is
          // the child's alone and which Claude erases on entry and after a resize.
          this.cleanFrom = this.taintCount;
        } else if (mode === 3) {
          // Erases the saved scrollback and leaves the visible screen as it is: the model keeps no
          // scrollback, so nothing changes, and a taint it was under is not healed by it.
        } else if (mode === 1) {
          for (let r = 0; r < this.row; r += 1) {
            this.grid[r] = this.blankRow();
            this.dubious[r] = new Map();
          }
          this.grid[this.row].fill(" ", 0, Math.min(this.col + 1, this.cols));
          this.certain(this.row, 0, this.col + 1);
        } else {
          this.grid[this.row].fill(" ", Math.min(this.col, this.cols));
          this.certain(this.row, this.col, this.cols);
          for (let r = this.row + 1; r < this.rows; r += 1) {
            this.grid[r] = this.blankRow();
            this.dubious[r] = new Map();
          }
        }
        break;
      }
      case "K": {
        const mode = Number.isFinite(args[0]) ? args[0] : 0;
        const cells = this.grid[this.row];
        if (mode === 2) {
          cells.fill(" ");
          this.dubious[this.row] = new Map();
        } else if (mode === 1) {
          cells.fill(" ", 0, Math.min(this.col + 1, this.cols));
          this.certain(this.row, 0, this.col + 1);
        } else {
          cells.fill(" ", Math.min(this.col, this.cols));
          this.certain(this.row, this.col, this.cols);
        }
        break;
      }
      case "X":
        this.grid[this.row].fill(" ", Math.min(this.col, this.cols), Math.min(this.col + n(0, 1), this.cols));
        this.certain(this.row, this.col, this.col + n(0, 1));
        break;
      case "L":
        for (let i = 0; i < n(0, 1); i += 1) {
          this.grid.splice(this.row, 0, this.blankRow());
          this.grid.pop();
          this.dubious.splice(this.row, 0, new Map());
          this.dubious.pop();
        }
        break;
      case "M":
        for (let i = 0; i < n(0, 1); i += 1) {
          this.grid.splice(this.row, 1);
          this.grid.push(this.blankRow());
          this.dubious.splice(this.row, 1);
          this.dubious.push(new Map());
        }
        break;
      case "S":
        this.scrollUp(n(0, 1));
        break;
      case "T":
        this.scrollDown(n(0, 1));
        break;
      case "s":
        this.saved = { row: this.row, col: this.col };
        break;
      case "u":
        this.row = this.saved.row;
        this.col = this.saved.col;
        break;
      case "n":
      case "c":
        break; // status and attribute requests to the terminal: they draw nothing
      case "r":
        // `CSI r` with nothing in it resets the scroll region to the whole screen, which is what the
        // model always has (Claude sends it at startup). Setting a region changes where text scrolls.
        if (raw !== "") {
          this.taint();
        }
        break;
      case "m":
        this.sgr(raw);
        break;
      default:
        // Scroll regions, insert and delete of characters, modes, reports: not modelled.
        this.taint();
        break;
    }
  }

  /**
   * Only one thing about styles matters: whether text is muted (faint, or a
   * gray foreground), which is how Claude draws a placeholder or a suggestion
   * in an input box that holds nothing of the wearer's. The parameters are
   * split on `;` and applied in order, so a reset (`0` or an empty parameter)
   * is honoured wherever it stands. A parameter the model cannot read (colon
   * sub-parameters, a malformed colour, a code it does not know) makes the
   * style unknown: text drawn under it is NOT muted, so it counts as text and
   * an input line holding it is not empty.
   */
  private sgr(raw: string): void {
    const tokens = raw === "" ? ["0"] : raw.split(";");
    let unknown = false;
    const number = (token: string | undefined): number | undefined =>
      token !== undefined && /^\d{1,3}$/.test(token) ? Number(token) : undefined;
    for (let i = 0; i < tokens.length; i += 1) {
      const code = tokens[i] === "" ? 0 : number(tokens[i]);
      if (code === undefined) {
        unknown = true;
      } else if (code === 0) {
        this.faint = false;
        this.grayFg = false;
        this.inverse = false;
      } else if (code === 7) {
        this.inverse = true;
      } else if (code === 27) {
        this.inverse = false;
      } else if (code === 2) {
        this.faint = true;
      } else if (code === 22) {
        this.faint = false;
      } else if (code === 39 || (code >= 30 && code <= 37) || (code >= 91 && code <= 97)) {
        this.grayFg = false;
      } else if (code === 90) {
        this.grayFg = true;
      } else if (code === 38 || code === 48 || code === 58) {
        // An extended colour: 5;n or 2;r;g;b. Only a foreground can make text gray.
        const kind = number(tokens[i + 1]);
        const width = kind === 5 ? 1 : kind === 2 ? 3 : 0;
        const values = tokens.slice(i + 2, i + 2 + width).map(number);
        if (width === 0 || values.length < width || values.some((value) => value === undefined)) {
          unknown = true;
          i = tokens.length;
        } else {
          if (code === 38) {
            const [a, b, c] = values as number[];
            this.grayFg = kind === 5 ? a === 8 || (a >= 232 && a <= 255) : Math.max(a, b, c) - Math.min(a, b, c) <= 8;
          }
          i += 1 + width;
        }
      } else if (!KNOWN_SGR.has(code) && !(code >= 40 && code <= 49) && !(code >= 100 && code <= 107)) {
        unknown = true;
      }
    }
    if (unknown) {
      this.faint = false;
      this.grayFg = false;
    }
  }

  /**
   * The real Claude Code runs on the alternate screen: it enters with `?1049h`
   * and clears at once. The model holds the two buffers as a terminal does (the
   * alternate one starts blank, the main one comes back as it was), and a
   * switch is still a taint: only a whole-screen erase drawn after it, which
   * Claude sends right away, makes what the model holds the child's own again.
   * A switch that does not match (leaving a screen not entered) is a taint too.
   */
  private switchScreen(enter: boolean): void {
    this.taint();
    if (enter && !this.alt) {
      this.mainBuffer = {
        grid: this.grid,
        dubious: this.dubious,
        row: this.row,
        col: this.col,
        saved: this.saved,
      };
      this.clear();
      this.alt = true;
    } else if (!enter && this.alt && this.mainBuffer) {
      ({ grid: this.grid, dubious: this.dubious, row: this.row, col: this.col, saved: this.saved } = this.mainBuffer);
      this.mainBuffer = undefined;
      this.alt = false;
    }
  }

  private privateMode(set: boolean, args: number[], prefix: string): void {
    if (prefix !== "?") {
      return;
    }
    for (const mode of args) {
      if (ALT_SCREEN_MODES.has(mode)) {
        this.switchScreen(set);
      } else if (mode === 7 && !set) {
        this.taint(); // no autowrap: the model wraps
      } else if (!BENIGN_PRIVATE_MODES.has(mode)) {
        this.taint();
      }
    }
  }
}

const RULE_CHARS = "─━╭╮╰╯┌┐└┘";
const RULE_TRIM = /^[\s]+|[\s]+$/g;

/**
 * A horizontal rule of the prompt box, with or without its corners, and with or without a label in
 * it: the real UI puts one in the top rule ("───── Rokid app for Claude code integration ─"), and on
 * a narrow screen the label is a good part of the row. A rule is a run of rule characters, then at
 * most one label (up to 100 characters, a space on each side) and a run of rule characters again, and
 * at least 10 rule characters in all. The label's words are never read.
 */
function isRule(row: string): boolean {
  const text = row.replace(RULE_TRIM, "");
  if (text.length < 10 || !RULE_ROW.test(text)) {
    return false;
  }
  let rule = 0;
  for (const ch of text) {
    if (RULE_CHARS.includes(ch)) {
      rule += 1;
    }
  }
  return rule >= 10;
}
const RULE_ROW = new RegExp(`^[${RULE_CHARS}]+(?: [^${RULE_CHARS}]{1,100} ?[${RULE_CHARS}]+)?$`);

/** The input line: a `>` or `❯` prompt, with or without the box's side border. */
const PROMPT_ROW = /^\s*(?:[│┃]\s*)?[>❯](?:\s|$)/;
const BORDER_LEFT = /^\s*[│┃]\s?/;
const BORDER_RIGHT = /\s*[│┃]\s*$/;
/** A selection list (`❯ 1. Yes`): a dialog, never the main prompt. */
const MENU_ROW = /^\s*(?:[│┃]\s*)?[>❯]?\s*\d+[.)]\s+\S/;
const BUSY_INDICATOR = /(?:esc(?:ape)?|ctrl\+c)\s+to\s+interrupt/i;
/**
 * What a dialog's own chrome says (its footer hints and answer choices): Claude draws these and nothing else does.
 * Prose a dialog also holds ("Do you want to proceed?") is just as likely in an assistant message, an agent's
 * title or a footer hint, so on its own it says nothing outside the input rows.
 */
const DIALOG_CHROME =
  /esc to cancel|enter to (?:confirm|select)|\(y\/n\)|\[y\/n\]|allow (?:once|always)|don't ask again|tab to amend|to navigate|ctrl\+e to explain/i;
const DIALOG_PROSE = /press enter|do you want to|waiting for (?:your )?(?:input|approval)/i;
/** A selection list with its selected row (`❯ 1. Yes`): a dialog. An indented `1. item` of a numbered list in a message is not. */
const SELECTED_MENU_ROW = /^\s*(?:[│┃]\s*)?[>❯]\s*\d+[.)]\s+\S/;

export type ProbeResult =
  /** `top` and `bottom` are the rows where the box was expected, when the probe got as far as a rule. */
  | { kind: "unknown"; reason: string; top?: number; bottom?: number; uw?: string }
  /** A dialog, a question, a permission prompt or a running-turn sign is on screen. */
  | { kind: "blocked"; reason: string; at?: string }
  /**
   * The framed prompt box, with what is on its input line (whitespace
   * normalised: runs are one space, ends trimmed) and the same line row by row
   * exactly as drawn (`rows`: after the prompt glyph and its one space, with
   * only the terminal's right padding and a wrapped row's indent removed), and
   * whether that line is visibly empty: nothing on it but muted text (the
   * placeholder, a suggestion or the `Try "..."` hint, all drawn faint or gray).
   */
  | { kind: "prompt"; text: string; rows: string[]; empty: boolean };

export interface ProbeOptions {
  /**
   * `screen.taints` as read when the screen was last verified clean (never
   * while it was `tainted`); any later taint is `unknown`. Without it the
   * screen must not be tainted at all.
   */
  sinceTaints?: number;
  /**
   * A running-turn sign (`esc to interrupt` in the footer or the status line) is no reason to refuse by
   * itself: a reply typed while Claude works only queues. A dialog, a menu, text in the box, taint and an
   * unreadable screen still refuse.
   */
  queued?: boolean;
}

/** Whitespace runs become one space and the ends are trimmed: where a line wrapped does not matter, a missing word space does. */
const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * What the screen shows right now. `prompt` only when the framed input box is
 * found (a rule above, the `>`/`❯` input line, a rule below; whatever is under it, the footer and the agents panel, is not counted),
 * nothing around it is a dialog, a menu or a running turn, and the model is
 * not tainted (or, given `sinceTaints`, not disturbed since). The text is what
 * the input line holds, whitespace normalised.
 */
export function probe(screen: ScreenModel, options: ProbeOptions = {}): ProbeResult {
  if (screen.unsettled) {
    return { kind: "unknown", reason: "screen_unsettled" };
  }
  if (options.sinceTaints === undefined ? screen.tainted : screen.taints > options.sinceTaints) {
    return { kind: "unknown", reason: "screen_disturbed" };
  }
  if (screen.width < MIN_COLS) {
    return { kind: "unknown", reason: "narrow" };
  }
  const rows = screen.lines();
  // Which cells are muted is worked out only when there is a rule to build a box on: the screen can be big.
  let solidMemo: string[] | undefined;
  const solidRows = (): string[] => (solidMemo ??= screen.solidLines());
  const { bottom, top } = locateBox(rows, solidRows);
  if (bottom < 1) {
    return { kind: "unknown", reason: "no_box", ...(bottom >= 0 ? { bottom } : {}) };
  }
  // Everything under the bottom rule is the footer and, while agents run, the agents panel (`● main`, a
  // `○` row for each agent, one of which may carry a `❯` selection). It is as tall as there are agents,
  // so it is not counted; it is never read for what the input line holds, and a `❯` there is no prompt.
  const footer = rows.slice(bottom + 1);
  if (top < 0 || bottom - top < 2) {
    return { kind: "unknown", reason: "no_box", bottom, ...(top >= 0 ? { top } : {}) };
  }
  const inputRows = rows.slice(top + 1, bottom);
  for (let i = top; i <= bottom; i += 1) {
    if (screen.rowDubious(i)) {
      // Which row and which codepoint (hex only, never the text around it), so a field problem names itself.
      const cell = screen.dubiousCell(i);
      return {
        kind: "unknown",
        reason: "uncertain_width",
        ...(cell ? { uw: `${i}:U+${cell.codepoint.toString(16).toUpperCase().padStart(4, "0")}` } : {}),
      };
    }
  }
  // Where a running-turn sign or a dialog's own text would be: the rows above the box and its footer.
  const around = [...rows.slice(Math.max(0, top - STATUS_ROWS), top), ...footer];
  // A second prompt row with something after its glyph is a selection list; a bare `>` is a row of the draft,
  // but only a solid one: a muted bare glyph is no text of the wearer's, and no empty box either.
  const mutedRow = (index: number): boolean => (solidRows()[top + 1 + index] ?? "").trim() === "";
  const menuAt = inputRows.findIndex(
    (row, index) => MENU_ROW.test(row) || (index > 0 && PROMPT_ROW.test(row) && (row.replace(PROMPT_LEAD, "").trim() !== "" || mutedRow(index))),
  );
  if (menuAt >= 0) {
    return { kind: "blocked", reason: "menu", at: `${top + 1 + menuAt}:menu` };
  }
  if (!PROMPT_ROW.test(inputRows[0])) {
    return { kind: "unknown", reason: "no_prompt", top, bottom };
  }
  if (options.queued !== true && around.some((row) => BUSY_INDICATOR.test(row))) {
    return { kind: "blocked", reason: "busy_indicator" };
  }
  // A dialog's whole text is read in the input rows (the box holds the dialog then); around the box (the rows
  // above it, the footer, the agents panel) only its chrome and a selected menu row count, never prose or a
  // numbered list a message or a title happens to hold. Which row and which kind goes to the log, never the text.
  const dialogAt = (): string | undefined => {
    const scan = (from: number, to: number, strict: boolean): string | undefined => {
      for (let i = from; i < to; i += 1) {
        const row = rows[i] ?? "";
        if (DIALOG_CHROME.test(row)) return `${i}:chrome`;
        if (SELECTED_MENU_ROW.test(row)) return `${i}:menu`;
        if (!strict && (DIALOG_PROSE.test(row) || MENU_ROW.test(row))) return `${i}:input`;
      }
      return undefined;
    };
    return scan(Math.max(0, top - STATUS_ROWS), top, true) ?? scan(top + 1, bottom, false) ?? scan(bottom + 1, rows.length, true);
  };
  const dialog = dialogAt();
  if (dialog !== undefined) {
    return { kind: "blocked", reason: "dialog", at: dialog };
  }
  const text = normalise(inputContent(inputRows));
  const solid = normalise(inputContent(solidRows().slice(top + 1, bottom)));
  // Claude's own `Try "..."` hint is no exception: it is empty only when drawn muted, like any
  // placeholder. Typed text that looks like it is text, and so is a multi-line draft that begins
  // and ends the same way.
  return { kind: "prompt", text, rows: exactRows(inputRows), empty: solid === "" };
}

/** A rule that starts in the first column: what the UI draws (an indented row that reads as a rule is a draft's). */
function isTopRule(row: string): boolean {
  return isRule(row) && /^\S/.test(row);
}

/**
 * Where the box is on the screen: the lowest rule closes it (`bottom`, -1 when there is none), and `top` is the rule
 * above it that opens it (-1 when none). The top starts in the first column, as the UI's own rules do; a draft's
 * rows are indented under the glyph, so an indented row that reads as a rule is the wearer's text, never the top
 * (with the real top scrolled off, it would make the rows below it an "empty" box and the hidden draft above it
 * would be sent).
 */
function locateBox(rows: string[], solidRows: () => string[]): { bottom: number; top: number } {
  let bottom = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (isRule(rows[i])) {
      bottom = i;
      break;
    }
  }
  if (bottom < 1) {
    return { bottom, top: -1 };
  }
  let top = -1;
  for (let i = bottom - 1; i >= Math.max(0, bottom - 1 - MAX_INPUT_ROWS); i -= 1) {
    if (isTopRule(rows[i])) {
      top = i;
      break;
    }
  }
  // A draft longer than the box's rows, or a draft row that itself reads as a rule (the nearest rule is then
  // the draft's own row, even with a prompt-like row under it), hides the real top rule. When a higher rule
  // with a prompt row under it and only box-like rows down to the bottom rule encloses solid text, that is the
  // box holding a draft: the caller must be told there is text, never that the box is empty or unreadable.
  const topFound = top >= 0 && bottom - top >= 2 && PROMPT_ROW.test(rows[top + 1] ?? "");
  const draftTop = findDraftTop(rows, bottom, solidRows(), topFound);
  if (draftTop >= 0 && (!topFound || draftTop < top)) {
    top = draftTop;
  }
  return { bottom, top };
}

/** The prompt glyph (and a side border) at the start of a row. */
const PROMPT_LEAD = /^\s*(?:[│┃]\s*)?[>❯]/;

/**
 * A row that can be part of the input box: blank, indented (a continuation row is indented under the glyph),
 * a rule (or a draft row that reads as one) or a prompt row. A row of text from the first column (`● Done`,
 * `✻ Working`, a footer-less transcript line) is not: the input box does not reach up through it.
 */
function boxLike(row: string): boolean {
  return row.trim() === "" || /^[\s│┃]/.test(row) || isRule(row) || PROMPT_ROW.test(row);
}

/**
 * The highest rule above `bottom` that has a prompt row directly under it, with only box-like rows
 * from there down to `bottom`, and solid (not muted, not a rule) text between: text after the glyph of
 * that prompt row, or anything on a row below it. -1 when there is none. It finds the top of a draft that is
 * taller than `MAX_INPUT_ROWS` or holds a row that reads as a rule (which the nearest-rule search takes for the
 * top). Rows that are only muted (a gray rule, a footer) are no text: they never make a box out of nothing.
 * `nearestFound` says the nearest-rule search already found a box: then the search may reach above that rule
 * only across rows of a draft, so no rule that starts in the first column (the UI's own; a draft's rows are
 * indented under the glyph) is crossed.
 */
function findDraftTop(rows: string[], bottom: number, solid: string[], nearestFound: boolean): number {
  let found = -1;
  let below = false; // solid, non-rule text on the rows under the candidate's prompt row
  for (let i = bottom - 1; i >= 0; i -= 1) {
    if (!boxLike(rows[i])) {
      break;
    }
    if (nearestFound && i + 2 < bottom && isRule(rows[i + 2]) && /^\S/.test(rows[i + 2])) {
      break;
    }
    if (i + 2 < bottom && (solid[i + 2] ?? "").trim() !== "" && !isRule(solid[i + 2])) {
      below = true;
    }
    if (i + 1 < bottom && isTopRule(rows[i]) && PROMPT_ROW.test(rows[i + 1] ?? "")) {
      const first = (solid[i + 1] ?? "").replace(PROMPT_LEAD, "").trim();
      if (below || (first !== "" && !isRule(first))) {
        found = i;
      }
    }
  }
  return found;
}

/** How many leading whitespace characters of a continuation row are the UI's indent: at most `indent`, never text. */
function indentWidth(row: string, indent: number): number {
  let width = 0;
  while (width < indent && /\s/.test(row[width] ?? "")) {
    width += 1;
  }
  return width;
}

/**
 * The input rows as drawn, for an exact comparison: the box's side borders, the
 * prompt glyph with the one space (or no-break space) the UI puts after it, a
 * wrapped row's indent and every row's right padding are what the terminal adds
 * and are removed; whitespace inside a row is kept as it is.
 */
function exactRows(rows: string[]): string[] {
  let indent = 2;
  return rows.map((row, index) => {
    // A bordered box's side border is no part of the text and no part of the indent.
    const withoutBorder = row.replace(BORDER_LEFT, "").replace(BORDER_RIGHT, "");
    if (index === 0) {
      // The continuation indent is the width of what precedes the text on the first row (a leading space,
      // the glyph, its one space or no-break space), measured there.
      indent = (/^\s*[>❯][  ]?/.exec(withoutBorder)?.[0] ?? "").length;
    }
    const content = index === 0 ? withoutBorder.replace(/^\s*[>❯][  ]?/, "") : withoutBorder.slice(indentWidth(withoutBorder, indent));
    return content.replace(/\s+$/, "");
  });
}

/**
 * What the input rows hold after the prompt character and the box's side
 * borders. Rows are joined by a space, so a line wrapped mid-word does not
 * read as the text it was typed as: it is refused, never guessed.
 */
function inputContent(rows: string[]): string {
  return rows
    .map((row, index) => {
      const withoutBorder = row.replace(BORDER_LEFT, index === 0 ? "" : " ").replace(BORDER_RIGHT, "");
      return index === 0 ? withoutBorder.replace(/^\s*[>❯]/, "") : withoutBorder;
    })
    .join(" ");
}

/**
 * Whether a visible row is the footer of plan mode (`plan mode on`, with whatever glyph and hint
 * around it, any case): the mode Claude shows after Shift+Tab, which no hook announces until the
 * next one, and whose approval dialog takes any key. Only a recognised plan-mode footer says yes;
 * a footer the model does not know says nothing, and no other mode is derived from the screen.
 */
export function showsPlanMode(screen: ScreenModel): boolean {
  return screen.lines().some((row) => /(^|[^a-z])plan\s+mode\s+on\b/i.test(row));
}

/**
 * Whether the screen shows a dialog or a menu anywhere, framed prompt box or not (a permission
 * dialog replaces the box). For deciding that what the wearer types is an answer; never a
 * reason to type anything.
 */
export function showsDialog(screen: ScreenModel): boolean {
  if (screen.unsettled) {
    return false;
  }
  return screen.lines().some((row) => DIALOG_CHROME.test(row) || SELECTED_MENU_ROW.test(row));
}

/** What the screen shows of the prompt box, for agentd to decide whether a reply may be typed (it still is not the check at the write). */
export type ScreenBox = "empty" | "text" | "dialog" | "plan" | "unreadable";

/**
 * `empty`: the framed box is found and visibly empty (a muted suggestion is empty), with no dialog or menu,
 * whether or not a turn is running (a reply typed then queues); `text`: it holds text; `dialog`: a dialog,
 * a question or a menu is on screen; `plan`: the plan-mode footer; `unreadable`: anything else, a tainted
 * or unsettled screen included.
 */
export function boxState(screen: ScreenModel): ScreenBox {
  if (screen.tainted || screen.unsettled) {
    return "unreadable";
  }
  if (showsPlanMode(screen)) {
    return "plan";
  }
  const seen = probe(screen, { queued: true });
  if (seen.kind === "prompt") {
    return seen.empty ? "empty" : "text";
  }
  if (seen.kind === "blocked") {
    return "dialog";
  }
  return showsDialog(screen) ? "dialog" : "unreadable";
}

/** The largest `screen_shape` frame the hub accepts (see `launcher-hub.ts`); a frame beyond it costs the connection. */
const SHAPE_MAX_COLS = 2000;
const SHAPE_MAX_ROWS = 1000;
const SHAPE_MAX_CHARS = 8000;

/** What the screen looks like by row kinds alone, and where the probe expected the box. No text of the screen is in it. */
export interface ScreenShape {
  cols: number;
  rows: number;
  /** `<row><class><length>` per row, space separated: B blank, R rule, P prompt-glyph row, M muted text, G glyphs only, T text. */
  shape: string;
  reason: string;
  top?: number;
  bottom?: number;
}

/**
 * The screen as classes and lengths, so a layout the probe cannot read can be rebuilt from a log line
 * without a character of what was on it (which can be anything the wearer or Claude wrote). `look` says
 * why the probe refused and, when it got as far as a rule, where it expected the box.
 */
export function describeShape(screen: ScreenModel, look?: ProbeResult): ScreenShape {
  const lines = screen.lines();
  const solid = screen.solidLines();
  const tokens = lines.map((line, index) => `${index}${rowClass(line, solid[index] ?? "")}${[...line].length}`);
  // The hub refuses a frame beyond these limits and drops the connection, so a huge terminal is cut to them
  // here: the numbers are clamped and the shape keeps the rows nearest the bottom, where the box is (each
  // token carries its own row number, so a shape that starts part-way down still says which rows it is).
  let first = 0;
  let length = tokens.reduce((sum, token) => sum + token.length + 1, -1);
  while (length > SHAPE_MAX_CHARS && first < tokens.length - 1) {
    length -= tokens[first].length + 1;
    first += 1;
  }
  return {
    cols: Math.min(SHAPE_MAX_COLS, Math.max(1, screen.width)),
    rows: Math.min(SHAPE_MAX_ROWS, Math.max(1, lines.length)),
    shape: tokens.slice(first).join(" "),
    reason: look?.kind === "unknown" || look?.kind === "blocked" ? look.reason : "none",
    ...(look?.kind === "unknown" && look.top !== undefined ? { top: look.top } : {}),
    ...(look?.kind === "unknown" && look.bottom !== undefined ? { bottom: look.bottom } : {}),
  };
}

/** A row's class: B blank, R rule, P prompt-glyph row, M muted text, G glyphs only, T text. Never any of its characters. */
function rowClass(line: string, solidLine: string): string {
  const trimmed = line.trim();
  if (trimmed === "") {
    return "B";
  }
  if (isRule(line)) {
    return "R";
  }
  if (PROMPT_ROW.test(line)) {
    return "P";
  }
  if (solidLine.trim() === "") {
    return "M";
  }
  return /^[^\p{L}\p{N}]+$/u.test(trimmed) ? "G" : "T";
}

/** The screen's rows as one string of classes (`TBMRPRM...`), without lengths: what a layout is, for telling one from another. */
export function layoutClasses(screen: ScreenModel): string {
  const lines = screen.lines();
  const solid = screen.solidLines();
  return lines.map((line, index) => rowClass(line, solid[index] ?? "")).join("");
}

/** What the launcher tells agentd about its screen when the verdict changes: names, numbers and row classes only. */
export interface VerdictShape {
  probe: string;
  reason: string;
  box: ScreenBox;
  tainted: boolean;
  cols: number;
  rows: number;
  top?: number;
  prompt?: number;
  bottom?: number;
  /** `<class><count>` per class of the rows under the bottom rule (the footer and the agents panel), e.g. `B1 M1 T3`. */
  below: string;
  /** As `ScreenShape.shape`: `<row><class><length>` per row, clamped to what the hub accepts. */
  shape: string;
  /** The probe found a prompt-glyph row in a screen it could not read as the box: a layout nobody has described. */
  unknown: boolean;
  /** With reason `uncertain_width`: the row and the codepoint (`47:U+25B6`), hex only, never the text. */
  uw?: string;
  /** With a refusal for a dialog: the row and what kind of evidence it was (`47:chrome`, `47:menu`, `47:input`), never the text. */
  dlg?: string;
}

/** `describeShape` plus where the probe put the box and the box state. Nothing of the screen's text. */
export function describeVerdict(screen: ScreenModel): VerdictShape {
  const look = probe(screen, { queued: true });
  const shape = describeShape(screen, look);
  const lines = screen.lines();
  const solid = screen.solidLines();
  const { bottom, top } = locateBox(lines, () => solid);
  const boxed = bottom >= 1 && top >= 0 && bottom - top >= 2;
  const below = new Map<string, number>();
  if (bottom >= 0) {
    for (let i = bottom + 1; i < lines.length; i += 1) {
      const kind = rowClass(lines[i], solid[i] ?? "");
      below.set(kind, (below.get(kind) ?? 0) + 1);
    }
  }
  const box = boxState(screen);
  return {
    probe: look.kind,
    reason: shape.reason,
    box,
    tainted: screen.tainted,
    cols: shape.cols,
    rows: shape.rows,
    ...(bottom >= 0 ? { bottom: Math.min(bottom, SHAPE_MAX_ROWS) } : {}),
    ...(boxed ? { top: Math.min(top, SHAPE_MAX_ROWS), prompt: Math.min(top + 1, SHAPE_MAX_ROWS) } : {}),
    below: [...below.entries()].map(([kind, count]) => `${kind}${count}`).sort().join(" ").slice(0, 200),
    shape: shape.shape,
    unknown: box === "unreadable" && lines.some((line) => PROMPT_ROW.test(line)) && look.kind === "unknown",
    ...(look.kind === "unknown" && look.uw !== undefined ? { uw: look.uw } : {}),
    ...(look.kind === "blocked" && look.at !== undefined ? { dlg: look.at } : {}),
  };
}

/** Whether the probe shows the framed prompt box visibly empty, with no dialog, question or other text in it. */
export function showsEmptyPrompt(result: ProbeResult): boolean {
  return result.kind === "prompt" && result.empty;
}

/**
 * Whether the input line holds exactly `expected` (the sanitised text that was
 * pasted) and nothing else: interior whitespace must be the same, so "hello  world"
 * is not "hello world". What is allowed to differ is only what the terminal adds:
 * the right padding of the last row and, where the line wrapped over rows, one
 * space at each break (the wrap may take it). Used before an Enter.
 */
export function showsExactly(result: ProbeResult, expected: string): boolean {
  if (result.kind !== "prompt") {
    return false;
  }
  const want = expected.replace(/\s+$/, "");
  if (want.length === 0) {
    return false;
  }
  let position = 0;
  for (let i = 0; i < result.rows.length; i += 1) {
    const row = result.rows[i];
    if (!want.startsWith(row, position)) {
      return false;
    }
    position += row.length;
    if (i < result.rows.length - 1 && want[position] === " ") {
      position += 1; // the break between wrapped rows may have taken one space
    }
  }
  return position === want.length;
}

/**
 * Whether the probe shows `expected` on the input line, whitespace normalised (runs
 * of it one space, ends trimmed). The loose comparison, for the places that need
 * no more than "this is the text": never the check before an Enter.
 */
export function showsText(result: ProbeResult, expected: string): boolean {
  return result.kind === "prompt" && expected.length > 0 && result.text === normalise(expected);
}

/** Whether the input line no longer holds `expected`: the box is found and the text is gone from it. */
export function showsCleared(result: ProbeResult, expected: string): boolean {
  return result.kind === "prompt" && !result.text.includes(normalise(expected));
}
