/**
 * A small model of what Claude's terminal shows, and a probe that finds its
 * idle main prompt on it. Typing into a live terminal on hook evidence alone
 * is not safe (a Stop hook does not prove the main turn ended), so the typist
 * also wants the screen to POSITIVELY show an idle prompt. The probe fails
 * closed: a layout it does not recognise (another version, a narrow window, a
 * dialog or overlay, a screen not yet drawn) is "not idle". The absence of a
 * busy indicator never counts by itself; the input box has to be found.
 */

const MAX_STRING = 4096;
/** The probe does not trust a screen narrower than this to be Claude's layout. */
const MIN_COLS = 40;
/** Rows under the input box that may hold its footer (mode line, `? for shortcuts`, `1 agent`). */
const MAX_FOOTER_ROWS = 4;
/** Rows above the input box where Claude's status line (spinner, `esc to interrupt`) lives. */
const STATUS_ROWS = 4;

type ParseState = "text" | "esc" | "esc_intermediate" | "csi" | "string" | "string_esc";

/**
 * Follows a child's output into a grid of rows: printable text, CR, LF, BS,
 * tab, cursor moves and absolute positions, erase in line and display, line
 * insert and delete, scroll, save and restore. Everything else is ignored, so
 * a screen it draws wrongly is one the probe does not recognise.
 */
export class ScreenModel {
  private grid: string[][] = [];
  private row = 0;
  private col = 0;
  private saved = { row: 0, col: 0 };
  private state: ParseState = "text";
  private params = "";
  private stringLength = 0;

  constructor(
    private cols = 80,
    private rows = 24,
  ) {
    this.clear();
  }

  get width(): number {
    return this.cols;
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.grid = Array.from({ length: this.rows }, (_, i) => this.fit(this.grid[i] ?? []));
    this.row = Math.min(this.row, this.rows - 1);
    this.col = Math.min(this.col, this.cols - 1);
  }

  /** The visible rows, trailing blanks removed. */
  lines(): string[] {
    return this.grid.map((cells) => cells.join("").replace(/\s+$/, ""));
  }

  push(chunk: string): void {
    for (const ch of chunk) {
      this.feed(ch);
    }
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
    this.row = 0;
    this.col = 0;
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) {
      this.row += 1;
    } else {
      this.grid.shift();
      this.grid.push(this.blankRow());
    }
  }

  private put(ch: string): void {
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    this.grid[this.row][this.col] = ch;
    this.col += 1;
  }

  private feed(ch: string): void {
    switch (this.state) {
      case "text":
        if (ch === "\x1b") {
          this.state = "esc";
        } else if (ch === "\x9b") {
          this.state = "csi";
          this.params = "";
        } else if (ch === "\x9d" || ch === "\x90") {
          this.state = "string";
          this.stringLength = 0;
        } else if (ch === "\r") {
          this.col = 0;
        } else if (ch === "\n") {
          this.lineFeed();
        } else if (ch === "\b") {
          this.col = Math.max(0, this.col - 1);
        } else if (ch === "\t") {
          this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        } else if (ch >= " " && ch !== "\x7f") {
          this.put(ch);
        }
        return;
      case "esc":
        if (ch === "[") {
          this.state = "csi";
          this.params = "";
        } else if (ch === "]" || ch === "P" || ch === "X" || ch === "^" || ch === "_") {
          this.state = "string";
          this.stringLength = 0;
        } else if (ch >= " " && ch <= "/") {
          this.state = "esc_intermediate";
        } else {
          if (ch === "7") {
            this.saved = { row: this.row, col: this.col };
          } else if (ch === "8") {
            this.row = this.saved.row;
            this.col = this.saved.col;
          } else if (ch === "c") {
            this.clear();
          }
          this.state = "text";
        }
        return;
      case "esc_intermediate":
        if (ch < " " || ch > "/") {
          this.state = "text";
        }
        return;
      case "csi":
        if (ch >= "@" && ch <= "~") {
          this.state = "text";
          this.csi(ch, this.params);
        } else {
          this.params += ch;
          if (this.params.length > 64) {
            this.state = "text";
          }
        }
        return;
      case "string":
        this.stringLength += 1;
        if (ch === "\x07" || ch === "\x9c" || this.stringLength > MAX_STRING) {
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

  private csi(final: string, raw: string): void {
    // Private modes (`?25l`, `?2004h`, `?1049h`) change nothing this model draws.
    if (/^[<=>?]/.test(raw)) {
      return;
    }
    const args = raw.split(";").map((part) => (part === "" ? NaN : Number.parseInt(part, 10)));
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
        this.col = Math.max(0, this.col - n(0, 1));
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
        } else if (mode === 1) {
          for (let r = 0; r < this.row; r += 1) {
            this.grid[r] = this.blankRow();
          }
          this.grid[this.row].fill(" ", 0, this.col + 1);
        } else {
          this.grid[this.row].fill(" ", this.col);
          for (let r = this.row + 1; r < this.rows; r += 1) {
            this.grid[r] = this.blankRow();
          }
        }
        break;
      }
      case "K": {
        const mode = Number.isFinite(args[0]) ? args[0] : 0;
        const cells = this.grid[this.row];
        if (mode === 2) {
          cells.fill(" ");
        } else if (mode === 1) {
          cells.fill(" ", 0, this.col + 1);
        } else {
          cells.fill(" ", this.col);
        }
        break;
      }
      case "X":
        this.grid[this.row].fill(" ", this.col, this.col + n(0, 1));
        break;
      case "L":
        for (let i = 0; i < n(0, 1); i += 1) {
          this.grid.splice(this.row, 0, this.blankRow());
          this.grid.pop();
        }
        break;
      case "M":
        for (let i = 0; i < n(0, 1); i += 1) {
          this.grid.splice(this.row, 1);
          this.grid.push(this.blankRow());
        }
        break;
      case "S":
        for (let i = 0; i < n(0, 1); i += 1) {
          this.grid.shift();
          this.grid.push(this.blankRow());
        }
        break;
      case "T":
        for (let i = 0; i < n(0, 1); i += 1) {
          this.grid.pop();
          this.grid.unshift(this.blankRow());
        }
        break;
      case "s":
        this.saved = { row: this.row, col: this.col };
        break;
      case "u":
        this.row = this.saved.row;
        this.col = this.saved.col;
        break;
      default:
        break;
    }
  }
}

const RULE_TOP = /^\s*[╭┌]?[─━]{10,}[╮┐]?\s*$/;
const RULE_BOTTOM = /^\s*[╰└]?[─━]{10,}[╯┘]?\s*$/;
/** The input line: a `>` or `❯` prompt, with or without the box's side border. */
const PROMPT_ROW = /^\s*(?:[│┃]\s*)?[>❯](?:\s|$)/;
/** A selection list (`❯ 1. Yes`): a dialog, never the main prompt. */
const MENU_ROW = /^\s*(?:[│┃]\s*)?[>❯]?\s*\d+\.\s/;
const BUSY_INDICATOR = /esc(?:ape)?\s+to\s+interrupt|ctrl\+c\s+to\s+interrupt/i;
const DIALOG_TEXT = /esc to cancel|enter to confirm|press enter to|do you want to|\(y\/n\)|\[y\/n\]/i;

/**
 * True only when the screen positively shows Claude Code's idle main prompt:
 * the input line sits between a rule above it and a rule below it, with at
 * most a few footer rows under the box, no running-turn indicator in the
 * status rows above or the footer below, and no dialog text near it.
 */
export function showsIdlePrompt(screen: ScreenModel): boolean {
  if (screen.width < MIN_COLS) {
    return false;
  }
  const rows = screen.lines();
  let prompt = -1;
  for (let i = rows.length - 2; i >= 1; i -= 1) {
    if (PROMPT_ROW.test(rows[i]) && !MENU_ROW.test(rows[i])) {
      prompt = i;
      break;
    }
  }
  if (prompt < 1 || !RULE_TOP.test(rows[prompt - 1]) || !RULE_BOTTOM.test(rows[prompt + 1])) {
    return false;
  }
  const footer = rows.slice(prompt + 2);
  if (footer.filter((row) => row.length > 0).length > MAX_FOOTER_ROWS) {
    return false;
  }
  const status = rows.slice(Math.max(0, prompt - 1 - STATUS_ROWS), prompt - 1);
  const near = [...status, ...footer];
  if (near.some((row) => BUSY_INDICATOR.test(row) || DIALOG_TEXT.test(row) || MENU_ROW.test(row))) {
    return false;
  }
  return true;
}
