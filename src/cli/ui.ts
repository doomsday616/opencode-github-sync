import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { displayWidth, paint, stripAnsi, style } from "./theme.js";

/**
 * Interactive terminal primitives with no dependencies.
 *
 * Two input modes share one interface:
 *
 *   - raw mode, when the input is a TTY: arrow keys move, space toggles,
 *     enter confirms, a hotkey jumps straight to an item;
 *   - line mode otherwise: each prompt prints numbered choices and reads one
 *     line. This is what runs under `curl | sh`, in CI and in the tests, where
 *     the input is a pipe.
 *
 * Every prompt resolves to `undefined` at end of input, so a caller that runs
 * out of answers backs out instead of hanging.
 */

export interface Io {
  input: Readable;
  output: Writable;
  /** Use raw-mode key handling. */
  interactive: boolean;
}

export interface Choice<T = string> {
  value: T;
  label: string;
  /** Single character typed to pick this item directly. */
  key?: string;
  hint?: string;
  disabled?: boolean;
}

interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

/** Queued reader over a stream: lines in line mode, keys in raw mode. */
class InputQueue {
  private lines: string[] = [];
  private keys: Key[] = [];
  private waiters: (() => void)[] = [];
  private ended = false;
  private buffer = "";
  private rawDepth = 0;

  constructor(private readonly io: Io) {
    if (io.interactive) {
      readline.emitKeypressEvents(io.input);
      io.input.on("keypress", (str: string, key: Key) => {
        this.keys.push(key ?? { sequence: str, name: str });
        this.wake();
      });
    }
    io.input.on("data", (chunk: Buffer | string) => {
      if (io.interactive) return;
      this.buffer += chunk.toString();
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        this.lines.push(this.buffer.slice(0, index).replace(/\r$/, ""));
        this.buffer = this.buffer.slice(index + 1);
        index = this.buffer.indexOf("\n");
      }
      this.wake();
    });
    io.input.on("end", () => {
      if (this.buffer) this.lines.push(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
      this.ended = true;
      this.wake();
    });
    io.input.on("close", () => {
      this.ended = true;
      this.wake();
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async line(): Promise<string | undefined> {
    for (;;) {
      if (this.lines.length > 0) return this.lines.shift();
      if (this.ended) return undefined;
      this.io.input.resume?.();
      await this.wait();
    }
  }

  async key(): Promise<Key | undefined> {
    for (;;) {
      if (this.keys.length > 0) return this.keys.shift();
      if (this.ended) return undefined;
      this.io.input.resume?.();
      await this.wait();
    }
  }

  setRaw(on: boolean): void {
    const input = this.io.input as Readable & { setRawMode?: (mode: boolean) => void };
    if (typeof input.setRawMode !== "function") return;
    this.rawDepth += on ? 1 : -1;
    input.setRawMode(this.rawDepth > 0);
  }

  pause(): void {
    this.io.input.pause?.();
  }
}

export class Ui {
  private readonly queue: InputQueue;
  private renderedLines = 0;

  constructor(readonly io: Io) {
    this.queue = new InputQueue(io);
  }

  write(text = ""): void {
    this.io.output.write(`${text}\n`);
  }

  /** Release the input so the process can exit. */
  close(): void {
    this.queue.pause();
  }

  /**
   * Read one line in line mode. A terminal echoes what was typed; a pipe does
   * not, so the answer is echoed here to keep transcripts readable.
   */
  private async readLine(): Promise<string | undefined> {
    const answer = await this.queue.line();
    const echoed = Boolean((this.io.input as { isTTY?: boolean }).isTTY);
    if (!echoed) this.io.output.write(`${answer ?? ""}\n`);
    return answer;
  }

  private clearRendered(): void {
    if (this.renderedLines > 0) {
      this.io.output.write(`\x1b[${this.renderedLines}A\x1b[0J`);
      this.renderedLines = 0;
    }
  }

  private render(lines: string[]): void {
    this.clearRendered();
    this.io.output.write(`${lines.join("\n")}\n`);
    this.renderedLines = lines.length;
  }

  /** Pick one item. Returns `undefined` on Escape, `q` or end of input. */
  async select<T>(title: string, choices: Choice<T>[], initial = 0): Promise<T | undefined> {
    const enabled = choices.map((c, i) => (c.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return undefined;
    const keyOf = (c: Choice<T>, i: number) => (c.key ?? String(i + 1)).toLowerCase();

    if (!this.io.interactive) {
      if (title) this.write(`  ${paint(title, style.bold, style.text)}`);
      choices.forEach((c, i) => {
        const tag = `[${keyOf(c, i)}]`.padEnd(5);
        const line = `    ${paint(tag, style.cyan)}${c.label}${c.hint ? paint(`  ${c.hint}`, style.faint) : ""}`;
        this.write(c.disabled ? paint(stripAnsi(line), style.faint) : line);
      });
      for (;;) {
        this.io.output.write(`  ${paint("›", style.brand)} `);
        const answer = await this.readLine();
        if (answer === undefined) return undefined;
        const text = answer.trim().toLowerCase();
        if (text === "") continue;
        const index = choices.findIndex((c, i) => !c.disabled && keyOf(c, i) === text);
        if (index >= 0) return choices[index]!.value;
        if (text === "q") return undefined;
        this.write(`  ${paint("?", style.yellow)} ${text}`);
      }
    }

    let cursor = enabled.includes(initial) ? initial : enabled[0]!;
    const draw = () => {
      const lines = [title ? `  ${paint(title, style.bold, style.text)}` : ""];
      choices.forEach((c, i) => {
        const active = i === cursor;
        const pointer = active ? paint("❯", style.brand) : " ";
        const tag = paint(`${keyOf(c, i)}`.padEnd(2), style.faint);
        const label = c.disabled
          ? paint(c.label, style.faint)
          : active
            ? paint(c.label, style.bold, style.text)
            : c.label;
        lines.push(
          `  ${pointer} ${tag} ${label}${c.hint ? paint(`  ${c.hint}`, style.faint) : ""}`,
        );
      });
      this.render(lines);
    };
    this.queue.setRaw(true);
    try {
      draw();
      for (;;) {
        const key = await this.queue.key();
        if (!key) return undefined;
        if (key.ctrl && key.name === "c") {
          this.queue.setRaw(false);
          process.exit(130);
        }
        const pos = enabled.indexOf(cursor);
        if (key.name === "up" || key.name === "k") {
          cursor = enabled[(pos - 1 + enabled.length) % enabled.length]!;
        } else if (key.name === "down" || key.name === "j" || key.name === "tab") {
          cursor = enabled[(pos + 1) % enabled.length]!;
        } else if (key.name === "return" || key.name === "enter") {
          this.renderedLines = 0;
          return choices[cursor]!.value;
        } else if (key.name === "escape" || key.sequence === "q") {
          this.renderedLines = 0;
          return undefined;
        } else if (key.sequence) {
          const typed = key.sequence.toLowerCase();
          const index = choices.findIndex((c, i) => !c.disabled && keyOf(c, i) === typed);
          if (index >= 0) {
            cursor = index;
            draw();
            this.renderedLines = 0;
            return choices[index]!.value;
          }
        }
        draw();
      }
    } finally {
      this.queue.setRaw(false);
    }
  }

  /**
   * Toggle several items. Space toggles, enter saves. In line mode the user
   * types the numbers to toggle (space or comma separated) and an empty line
   * to save. Returns `undefined` when cancelled.
   */
  async checkbox<T>(
    title: string,
    choices: Choice<T>[],
    selected: Set<T>,
    footer = "",
  ): Promise<Set<T> | undefined> {
    const current = new Set(selected);
    const mark = (on: boolean) => (on ? paint("[x]", style.green) : paint("[ ]", style.faint));

    if (!this.io.interactive) {
      for (;;) {
        this.write(`  ${paint(title, style.bold, style.text)}`);
        choices.forEach((c, i) => {
          this.write(
            `    ${paint(String(i + 1).padEnd(3), style.cyan)}${mark(current.has(c.value))} ${c.label}${c.hint ? paint(`  ${c.hint}`, style.faint) : ""}`,
          );
        });
        if (footer) this.write(`  ${paint(footer, style.faint)}`);
        this.io.output.write(`  ${paint("›", style.brand)} `);
        const answer = await this.readLine();
        if (answer === undefined) return undefined;
        const text = answer.trim().toLowerCase();
        if (text === "" || text === "s") return current;
        if (text === "q") return undefined;
        for (const token of text.split(/[\s,]+/)) {
          const index = Number(token) - 1;
          const choice = choices[index];
          if (!choice || choice.disabled) continue;
          if (current.has(choice.value)) current.delete(choice.value);
          else current.add(choice.value);
        }
      }
    }

    let cursor = 0;
    const draw = () => {
      const lines = [`  ${paint(title, style.bold, style.text)}`];
      choices.forEach((c, i) => {
        const pointer = i === cursor ? paint("❯", style.brand) : " ";
        const label = c.disabled ? paint(c.label, style.faint) : c.label;
        lines.push(
          `  ${pointer} ${mark(current.has(c.value))} ${label}${c.hint ? paint(`  ${c.hint}`, style.faint) : ""}`,
        );
      });
      if (footer) lines.push(`  ${paint(footer, style.faint)}`);
      this.render(lines);
    };
    this.queue.setRaw(true);
    try {
      draw();
      for (;;) {
        const key = await this.queue.key();
        if (!key) return undefined;
        if (key.ctrl && key.name === "c") {
          this.queue.setRaw(false);
          process.exit(130);
        }
        if (key.name === "up" || key.name === "k") {
          cursor = (cursor - 1 + choices.length) % choices.length;
        } else if (key.name === "down" || key.name === "j" || key.name === "tab") {
          cursor = (cursor + 1) % choices.length;
        } else if (key.name === "space") {
          const choice = choices[cursor]!;
          if (!choice.disabled) {
            if (current.has(choice.value)) current.delete(choice.value);
            else current.add(choice.value);
          }
        } else if (key.name === "return" || key.name === "enter") {
          this.renderedLines = 0;
          return current;
        } else if (key.name === "escape" || key.sequence === "q") {
          this.renderedLines = 0;
          return undefined;
        }
        draw();
      }
    } finally {
      this.queue.setRaw(false);
    }
  }

  /** Read one line of text. Returns `undefined` at end of input. */
  async text(question: string, initial = ""): Promise<string | undefined> {
    const suffix = initial ? paint(` (${initial})`, style.faint) : "";
    if (!this.io.interactive) {
      this.io.output.write(`  ${question}${suffix} ${paint("›", style.brand)} `);
      const answer = await this.readLine();
      if (answer === undefined) return undefined;
      return answer.trim() === "" ? initial : answer.trim();
    }

    this.io.output.write(`  ${question}${suffix} ${paint("›", style.brand)} `);
    let value = "";
    this.queue.setRaw(true);
    try {
      for (;;) {
        const key = await this.queue.key();
        if (!key) return undefined;
        if (key.ctrl && key.name === "c") {
          this.queue.setRaw(false);
          process.exit(130);
        }
        if (key.name === "return" || key.name === "enter") {
          this.write();
          return value.trim() === "" ? initial : value.trim();
        }
        if (key.name === "escape") {
          this.write();
          return undefined;
        }
        if (key.name === "backspace") {
          if (value.length > 0) {
            const last = [...value].pop() ?? "";
            value = [...value].slice(0, -1).join("");
            const width = displayWidth(last);
            this.io.output.write("\b \b".repeat(width));
          }
          continue;
        }
        const seq = key.sequence ?? "";
        const control = seq.length > 0 && (seq.charCodeAt(0) < 0x20 || seq.charCodeAt(0) === 0x7f);
        if (seq && !key.ctrl && !control) {
          value += seq;
          this.io.output.write(seq);
        }
      }
    } finally {
      this.queue.setRaw(false);
    }
  }

  /** Yes/no question. Enter takes the default. */
  async confirm(question: string, defaultYes = false, yesWords = ["y", "yes"]): Promise<boolean> {
    const hint = defaultYes ? "Y/n" : "y/N";
    const answer = await this.text(`${question} ${paint(`[${hint}]`, style.faint)}`);
    if (answer === undefined) return false;
    const text = answer.trim().toLowerCase();
    if (text === "") return defaultYes;
    return yesWords.includes(text);
  }

  /** Require the user to type an exact word. */
  async confirmWord(question: string, word: string): Promise<boolean> {
    const answer = await this.text(`${question} ${paint(word, style.bold, style.red)}`);
    return answer !== undefined && answer.trim() === word;
  }

  /** Wait for enter (or any key) before returning to a menu. */
  async pause(message: string): Promise<void> {
    if (!this.io.interactive) return;
    this.io.output.write(`  ${paint(message, style.faint)}`);
    this.queue.setRaw(true);
    try {
      await this.queue.key();
    } finally {
      this.queue.setRaw(false);
      this.write();
    }
  }
}
