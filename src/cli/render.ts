import type { ChangeSummary, ChangedFile, Reporter } from "../core/reporter.js";
import { SPINNER, canAnimate, displayWidth, glyph, paint, style } from "./theme.js";

const INDENT = "  ";

export function write(line = ""): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The product wordmark.
 *
 * Rendered on every command so the output reads as one coherent tool rather
 * than a pile of scripts.
 */
export function banner(subtitle?: string, badge?: string): void {
  const mark =
    paint("opencode", style.bold, style.brand) + paint("-sync", style.bold, style.accent);
  const tail = subtitle
    ? `${paint(" ".repeat(1) + glyph.bullet + " ", style.faint)}${paint(subtitle, style.muted)}`
    : "";
  const tag = badge ? `  ${paint(` ${badge} `, style.bold, style.yellow)}` : "";
  write();
  write(`${INDENT}${mark}${tail}${tag}`);
  write();
}

export function rule(width = 52): void {
  write(`${INDENT}${paint("─".repeat(width), style.faint)}`);
}

export function heading(text: string): void {
  write();
  write(`${INDENT}${paint(text, style.bold, style.text)}`);
}

export function keyValue(key: string, value: string, width = 16): void {
  const padding = " ".repeat(Math.max(0, width - displayWidth(key)));
  write(`${INDENT}${paint(key, style.muted)}${padding}${value}`);
}

export function ok(message: string): void {
  write(`${INDENT}${paint(glyph.ok, style.green)} ${message}`);
}

export function fail(message: string): void {
  for (const [index, line] of message.split("\n").entries()) {
    if (index === 0) write(`${INDENT}${paint(glyph.fail, style.red)} ${paint(line, style.text)}`);
    else write(`${INDENT}  ${paint(line, style.muted)}`);
  }
}

export function warn(message: string): void {
  write(`${INDENT}${paint(glyph.warn, style.yellow)} ${message}`);
}

export function info(message: string): void {
  write(`${INDENT}${paint(glyph.info, style.cyan)} ${message}`);
}

export function step(message: string): void {
  write(`${INDENT}${paint(glyph.step, style.faint)} ${paint(message, style.muted)}`);
}

export function detail(message: string): void {
  write(`${INDENT}  ${paint(message, style.faint)}`);
}

const CHANGE_STYLE = {
  added: { glyph: glyph.added, color: style.green, label: "added" },
  modified: { glyph: glyph.modified, color: style.yellow, label: "modified" },
  deleted: { glyph: glyph.deleted, color: style.red, label: "deleted" },
  renamed: { glyph: glyph.renamed, color: style.cyan, label: "renamed" },
} as const;

export function summaryLine(summary: ChangeSummary): string {
  const parts: string[] = [];
  for (const kind of ["added", "modified", "deleted", "renamed"] as const) {
    const count = summary[kind];
    if (count === 0) continue;
    const meta = CHANGE_STYLE[kind];
    parts.push(paint(`${meta.glyph}${count} ${meta.label}`, meta.color));
  }
  if (parts.length === 0) return paint("no changes", style.muted);
  return parts.join(paint("  ", style.faint));
}

/**
 * Print the changed files.
 *
 * The list is capped so a large sync does not bury the important lines; the
 * full list is one environment variable away.
 */
export function changeList(files: ChangedFile[]): void {
  if (files.length === 0) return;
  const cap = process.env.OPENCODE_SYNC_VERBOSE === "1" ? Number.POSITIVE_INFINITY : 20;
  const shown = files.slice(0, cap);
  for (const file of shown) {
    const meta = CHANGE_STYLE[file.kind];
    write(`${INDENT}  ${paint(meta.glyph, meta.color)} ${paint(file.path, style.faint)}`);
  }
  const hidden = files.length - shown.length;
  if (hidden > 0) {
    write(
      `${INDENT}  ${paint(`… ${hidden} more (set OPENCODE_SYNC_VERBOSE=1 to see all)`, style.faint)}`,
    );
  }
}

export function outcome(message: string, changed: boolean): void {
  write();
  const icon = changed ? paint("✦", style.accent) : paint(glyph.ok, style.green);
  write(`${INDENT}${icon} ${paint(message, style.bold, style.text)}`);
  write();
}

/** A live spinner that degrades to a single static line when not a TTY. */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private active = false;
  /** Last label printed in non-animated mode, so restarts do not duplicate it. */
  private printed: string | undefined;

  constructor(private label: string) {}

  start(): void {
    if (!canAnimate) {
      this.print();
      return;
    }
    this.active = true;
    this.timer = setInterval(() => {
      const glyphFrame = SPINNER[this.frame % SPINNER.length];
      this.frame++;
      process.stdout.write(
        `\r${INDENT}${paint(glyphFrame!, style.brand)} ${paint(this.label, style.muted)}`,
      );
    }, 80);
    this.timer.unref?.();
  }

  update(label: string): void {
    this.label = label;
    if (!canAnimate) this.print();
  }

  /** In non-animated mode each distinct label is printed exactly once. */
  private print(): void {
    if (this.printed === this.label) return;
    this.printed = this.label;
    step(this.label);
  }

  stop(): void {
    if (!this.active) return;
    if (this.timer) clearInterval(this.timer);
    this.active = false;
    process.stdout.write("\r\x1b[2K");
  }
}

/** Reporter that renders straight to the terminal. */
export function createCliReporter(spinner?: Spinner): Reporter {
  const pause = <T>(fn: () => T): T => {
    spinner?.stop();
    const result = fn();
    spinner?.start();
    return result;
  };

  return {
    step: (message) => (spinner ? spinner.update(message) : step(message)),
    info: (message) => pause(() => info(message)),
    success: (message) => pause(() => ok(message)),
    warn: (message) => pause(() => warn(message)),
    error: (message) => pause(() => fail(message)),
    detail: (message) => pause(() => detail(message)),
    changes: (summary, files) =>
      pause(() => {
        ok(summaryLine(summary));
        changeList(files);
      }),
  };
}
