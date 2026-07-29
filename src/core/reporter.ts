/**
 * Terminal presentation layer.
 *
 * The core never writes to stdout directly. It emits structured events through
 * a `Reporter`, so the same sync logic can render as a pretty CLI, as silent
 * JSON, or as OpenCode toast notifications from inside the plugin.
 */

export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface ChangeSummary {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
}

export interface ChangedFile {
  kind: ChangeKind;
  path: string;
}

export interface Reporter {
  step(message: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  detail(message: string): void;
  changes(summary: ChangeSummary, files: ChangedFile[]): void;
}

export const silentReporter: Reporter = {
  step() {},
  info() {},
  success() {},
  warn() {},
  error() {},
  detail() {},
  changes() {},
};

/** Collects everything for later inspection — used by the plugin and tests. */
export class CollectingReporter implements Reporter {
  readonly lines: { level: string; message: string }[] = [];
  summary: ChangeSummary = { added: 0, modified: 0, deleted: 0, renamed: 0 };
  files: ChangedFile[] = [];

  private push(level: string, message: string) {
    this.lines.push({ level, message });
  }

  step(message: string) {
    this.push("step", message);
  }
  info(message: string) {
    this.push("info", message);
  }
  success(message: string) {
    this.push("success", message);
  }
  warn(message: string) {
    this.push("warn", message);
  }
  error(message: string) {
    this.push("error", message);
  }
  detail(message: string) {
    this.push("detail", message);
  }
  changes(summary: ChangeSummary, files: ChangedFile[]) {
    this.summary = summary;
    this.files = files;
  }

  get text(): string {
    return this.lines.map((l) => l.message).join("\n");
  }
}

export function emptySummary(): ChangeSummary {
  return { added: 0, modified: 0, deleted: 0, renamed: 0 };
}

export function summarize(files: ChangedFile[]): ChangeSummary {
  const summary = emptySummary();
  for (const file of files) summary[file.kind]++;
  return summary;
}

export function totalChanges(summary: ChangeSummary): number {
  return summary.added + summary.modified + summary.deleted + summary.renamed;
}
