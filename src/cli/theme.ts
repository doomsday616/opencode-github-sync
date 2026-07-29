/**
 * Terminal theme.
 *
 * Colour is opt-out: it is disabled when stdout is not a TTY, when `NO_COLOR`
 * is set, or when `TERM=dumb`, so piping the CLI into a file or a CI log
 * produces clean text. Truecolor is used when the terminal advertises it and
 * degrades to the 256-colour palette otherwise.
 */

const supportsColor = ((): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
})();

const truecolor = supportsColor && /truecolor|24bit/i.test(process.env.COLORTERM ?? "");

function rgb(r: number, g: number, b: number, fallback: number): string {
  if (!supportsColor) return "";
  return truecolor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${fallback}m`;
}

function code(sequence: string): string {
  return supportsColor ? sequence : "";
}

export const style = {
  reset: code("\x1b[0m"),
  bold: code("\x1b[1m"),
  dim: code("\x1b[2m"),
  italic: code("\x1b[3m"),

  // Palette — a cool blue/violet base with high-contrast accents.
  brand: rgb(122, 162, 247, 111),
  accent: rgb(187, 154, 247, 141),
  cyan: rgb(125, 207, 255, 117),
  green: rgb(158, 206, 106, 149),
  yellow: rgb(224, 175, 104, 179),
  red: rgb(247, 118, 142, 204),
  text: rgb(192, 202, 245, 189),
  muted: rgb(108, 119, 158, 103),
  faint: rgb(70, 79, 115, 60),
};

export function paint(text: string, ...styles: string[]): string {
  if (!supportsColor) return text;
  return `${styles.join("")}${text}${style.reset}`;
}

/** Strip ANSI sequences — used for width calculations. */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Display width, counting CJK and emoji as two columns. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp === 0) continue;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff);
    width += wide ? 2 : 1;
  }
  return width;
}

export const glyph = {
  ok: "✓",
  fail: "✗",
  warn: "!",
  info: "i",
  step: "›",
  bullet: "·",
  added: "+",
  modified: "~",
  deleted: "-",
  renamed: "»",
  arrow: "→",
};

/** Braille spinner frames — smooth at 80ms. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const canAnimate = supportsColor && Boolean(process.stdout.isTTY);
