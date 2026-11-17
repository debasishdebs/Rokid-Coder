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
/** Rows under the input box that may hold its footer (mode line, `? for shortcuts`, `1 agent`). */
const MAX_FOOTER_ROWS = 4;
/** Rows above the input box that are looked at for a running-turn sign (spinner, `esc to interrupt`) or a dialog's text. */
const STATUS_ROWS = 8;
/** The most rows the input line may wrap over. */
const MAX_INPUT_ROWS = 10;

/** Prefixes the cell of a muted character; never a character a terminal would draw. */
const MUTED = "\u0001";

type ParseState ="text" | "esc" | "esc_intermediate" | "csi" | "string" | "string_esc";

/** Private modes that change nothing this model draws. */
const BENIGN_PRIVATE_MODES: ReadonlySet<number> = new Set([
  7, // autowrap on; switching it off is a taint, since the model always wraps
  12, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004, 2026,
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
  private dubious: boolean[] = [];
  private row = 0;
  private col = 0;
  private saved = { row: 0, col: 0 };
  private state: ParseState = "text";
  private params = "";
  private intermediates = "";
  private stringLength = 0;
  private alt = false;
  private taintCount = 0;
  /** The taint count when the whole screen was last erased: what happened before it no longer matters. */
  private cleanFrom = 0;
  /** SGR state: text drawn now is muted (faint or a gray foreground), as placeholders and suggestions are. */
  private faint = false;
  private grayFg = false;

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

  /** Right now: the child is mid-sequence, or on the alternate screen. */
  get unsettled(): boolean {
    return this.state !== "text" || this.alt;
  }

  resize(cols: number, rows: number): void {
    this.taint();
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.grid = Array.from({ length: this.rows }, (_, i) => this.fit(this.grid[i] ?? []));
    this.dubious = Array.from({ length: this.rows }, (_, i) => this.dubious[i] ?? false);
    this.row = Math.min(this.row, this.rows - 1);
    this.col = Math.min(this.col, this.cols - 1);
  }

  /** The visible rows, trailing blanks removed. */
  lines(): string[] {
    return this.grid.map((cells) => cells.join("").split(MUTED).join("").replace(/\s+$/, ""));
  }

  /** The visible rows with every muted character blanked: what is on screen that is not a placeholder or a suggestion. */
  solidLines(): string[] {
    return this.grid.map((cells) =>
      cells
        .map((cell) => (cell.startsWith(MUTED) ? " ".repeat(Math.max(1, [...cell].length - 1)) : cell))
        .join("")
        .replace(/\s+$/, ""),
    );
  }

  rowDubious(index: number): boolean {
    return this.dubious[index] === true;
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
    this.dubious = Array.from({ length: this.rows }, () => false);
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
      this.dubious.push(false);
    }
  }

  private scrollDown(count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.grid.pop();
      this.grid.unshift(this.blankRow());
      this.dubious.pop();
      this.dubious.unshift(false);
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
    // Writing over half of a wide character leaves the other half meaningless.
    if (cellsRow[this.col] === "" || (cells === 1 && cellsRow[this.col + 1] === "")) {
      this.dubious[this.row] = true;
    }
    if (width === undefined) {
      this.dubious[this.row] = true;
    }
    cellsRow[this.col] = this.faint || this.grayFg ? MUTED + ch : ch;
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
        } else if (ch === "\x0e" || ch === "\x0f") {
          this.taint(); // a shifted character set draws other glyphs
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
        if (mode === 2 || mode === 3) {
          this.grid = Array.from({ length: this.rows }, () => this.blankRow());
          this.dubious = Array.from({ length: this.rows }, () => false);
          if (!this.alt) {
            // Every cell is now what the child draws next, whatever the model lost track of before.
            this.cleanFrom = this.taintCount;
          }
        } else if (mode === 1) {
          for (let r = 0; r < this.row; r += 1) {
            this.grid[r] = this.blankRow();
            this.dubious[r] = false;
          }
          this.grid[this.row].fill(" ", 0, Math.min(this.col + 1, this.cols));
        } else {
          this.grid[this.row].fill(" ", Math.min(this.col, this.cols));
          for (let r = this.row + 1; r < this.rows; r += 1) {
            this.grid[r] = this.blankRow();
            this.dubious[r] = false;
          }
        }
        break;
      }
      case "K": {
        const mode = Number.isFinite(args[0]) ? args[0] : 0;
        const cells = this.grid[this.row];
        if (mode === 2) {
          cells.fill(" ");
          this.dubious[this.row] = false;
        } else if (mode === 1) {
          cells.fill(" ", 0, Math.min(this.col + 1, this.cols));
        } else {
          cells.fill(" ", Math.min(this.col, this.cols));
        }
        break;
      }
      case "X":
        this.grid[this.row].fill(" ", Math.min(this.col, this.cols), Math.min(this.col + n(0, 1), this.cols));
        break;
      case "L":
        for (let i = 0; i < n(0, 1); i += 1) {
          this.grid.splice(this.row, 0, this.blankRow());
          this.grid.pop();
          this.dubious.splice(this.row, 0, false);
          this.dubious.pop();
        }
        break;
      case "M":
        for (let i = 0; i < n(0, 1); i += 1) {
          this.grid.splice(this.row, 1);
          this.grid.push(this.blankRow());
          this.dubious.splice(this.row, 1);
          this.dubious.push(false);
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
      case "m":
        this.sgr(args, raw.includes(":"));
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
   * in an input box that holds nothing of the wearer's. A style the model
   * cannot read (colon sub-parameters) is not muted, so such text counts as
   * text and an input line holding it is not empty.
   */
  private sgr(args: number[], colon: boolean): void {
    if (colon) {
      this.grayFg = false;
      return;
    }
    const list = args.length === 0 || (args.length === 1 && Number.isNaN(args[0])) ? [0] : args;
    for (let i = 0; i < list.length; i += 1) {
      const code = Number.isNaN(list[i]) ? 0 : list[i];
      if (code === 0) {
        this.faint = false;
        this.grayFg = false;
      } else if (code === 2) {
        this.faint = true;
      } else if (code === 22) {
        this.faint = false;
      } else if (code === 39 || (code >= 30 && code <= 37) || (code >= 91 && code <= 97)) {
        this.grayFg = false;
      } else if (code === 90) {
        this.grayFg = true;
      } else if (code === 38) {
        if (list[i + 1] === 5) {
          const n = list[i + 2];
          this.grayFg = n === 8 || (n >= 232 && n <= 255);
          i += 2;
        } else if (list[i + 1] === 2) {
          const [r, g, b] = [list[i + 2], list[i + 3], list[i + 4]];
          this.grayFg = [r, g, b].every(Number.isFinite) && Math.max(r, g, b) - Math.min(r, g, b) <= 8;
          i += 4;
        } else {
          this.grayFg = false;
          i = list.length;
        }
      }
    }
  }

  private privateMode(set: boolean, args: number[], prefix: string): void {
    if (prefix !== "?") {
      return;
    }
    for (const mode of args) {
      if (ALT_SCREEN_MODES.has(mode)) {
        // Switching screens swaps in a buffer this model does not hold.
        this.alt = set;
        this.taint();
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

/** A horizontal rule of the prompt box, with or without its corners. */
function isRule(row: string): boolean {
  const text = row.replace(RULE_TRIM, "");
  if (text.length < 10) {
    return false;
  }
  let rule = 0;
  for (const ch of text) {
    if (RULE_CHARS.includes(ch)) {
      rule += 1;
    }
  }
  return rule / text.length >= 0.8 && RULE_CHARS.includes(text[0]) && RULE_CHARS.includes(text[text.length - 1]);
}

/** The input line: a `>` or `❯` prompt, with or without the box's side border. */
const PROMPT_ROW = /^\s*(?:[│┃]\s*)?[>❯](?:\s|$)/;
const BORDER_LEFT = /^\s*[│┃]\s?/;
const BORDER_RIGHT = /\s*[│┃]\s*$/;
/** A selection list (`❯ 1. Yes`): a dialog, never the main prompt. */
const MENU_ROW = /^\s*(?:[│┃]\s*)?[>❯]?\s*\d+[.)]\s+\S/;
const BUSY_INDICATOR = /(?:esc(?:ape)?|ctrl\+c)\s+to\s+interrupt/i;
const DIALOG_TEXT =
  /esc to cancel|enter to (?:confirm|select)|press enter|do you want to|\(y\/n\)|\[y\/n\]|allow (?:once|always)|don't ask again|tab to amend|to navigate|ctrl\+e to explain|waiting for (?:your )?(?:input|approval)/i;

export type ProbeResult =
  | { kind: "unknown"; reason: string }
  /** A dialog, a question, a permission prompt or a running-turn sign is on screen. */
  | { kind: "blocked"; reason: string }
  /**
   * The framed prompt box, with what is on its input line (whitespace removed),
   * and whether that line is visibly empty: nothing on it but muted text (the
   * placeholder or a suggestion Claude draws in faint or gray) or Claude's own
   * `Try "..."` hint.
   */
  | { kind: "prompt"; text: string; empty: boolean };

export interface ProbeOptions {
  /**
   * `screen.taints` as read when the screen was last verified clean (never
   * while it was `tainted`); any later taint is `unknown`. Without it the
   * screen must not be tainted at all.
   */
  sinceTaints?: number;
}

/** Whitespace runs become one space and the ends are trimmed: where a line wrapped does not matter, a missing word space does. */
const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * What the screen shows right now. `prompt` only when the framed input box is
 * found (a rule above, the `>`/`❯` input line, a rule below, a short footer),
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
  // The lowest rule with at most a footer under it closes the box.
  let bottom = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (isRule(rows[i])) {
      bottom = i;
      break;
    }
  }
  if (bottom < 1) {
    return { kind: "unknown", reason: "no_box" };
  }
  const footer = rows.slice(bottom + 1);
  if (footer.filter((row) => row.length > 0).length > MAX_FOOTER_ROWS) {
    return { kind: "unknown", reason: "no_box" };
  }
  let top = -1;
  for (let i = bottom - 1; i >= Math.max(0, bottom - 1 - MAX_INPUT_ROWS); i -= 1) {
    if (isRule(rows[i])) {
      top = i;
      break;
    }
  }
  if (top < 0 || bottom - top < 2) {
    return { kind: "unknown", reason: "no_box" };
  }
  const inputRows = rows.slice(top + 1, bottom);
  for (let i = top; i <= bottom; i += 1) {
    if (screen.rowDubious(i)) {
      return { kind: "unknown", reason: "uncertain_width" };
    }
  }
  // Where a running-turn sign or a dialog's own text would be: the rows above the box and its footer.
  const around = [...rows.slice(Math.max(0, top - STATUS_ROWS), top), ...footer];
  if (inputRows.some((row, index) => MENU_ROW.test(row) || (index > 0 && PROMPT_ROW.test(row)))) {
    return { kind: "blocked", reason: "menu" };
  }
  if (!PROMPT_ROW.test(inputRows[0])) {
    return { kind: "unknown", reason: "no_prompt" };
  }
  if (around.some((row) => BUSY_INDICATOR.test(row))) {
    return { kind: "blocked", reason: "busy_indicator" };
  }
  if ([...around, ...inputRows].some((row) => DIALOG_TEXT.test(row) || MENU_ROW.test(row))) {
    return { kind: "blocked", reason: "dialog" };
  }
  const text = normalise(inputContent(inputRows));
  const solid = normalise(inputContent(screen.solidLines().slice(top + 1, bottom)));
  return { kind: "prompt", text, empty: solid === "" || TRY_HINT.test(text) };
}

/** Claude's own hint in an empty box, `Try "fix lint errors"`. */
const TRY_HINT = /^Try\s*["“'‘].*["”'’]$/;

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

/** Whether the probe shows the framed prompt box visibly empty, with no dialog, question or other text in it. */
export function showsEmptyPrompt(result: ProbeResult): boolean {
  return result.kind === "prompt" && result.empty;
}

/** Whether the probe shows `expected` (already sanitised) on the input line, and nothing but it. */
export function showsText(result: ProbeResult, expected: string): boolean {
  return result.kind === "prompt" && expected.length > 0 && result.text === normalise(expected);
}

/** Whether the input line no longer holds `expected`: the box is found and the text is gone from it. */
export function showsCleared(result: ProbeResult, expected: string): boolean {
  return result.kind === "prompt" && !result.text.includes(normalise(expected));
}
