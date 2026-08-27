/**
 * Line-level markdown structure, shared by the vault reader and the vault writers.
 *
 * These are the pieces both files had their own copy of. The fence reader in particular was
 * copied by hand and then diverged: the reader's version closed a block on either marker, so a
 * `~~~` line inside a ```` ```md ```` example ended it early and the table underneath was edited
 * as if it were real. One copy, one set of rules.
 *
 * Nothing here parses a whole document. `lib/sdk/vault.ts` uses remark with node positions when
 * it needs real section boundaries, which is stricter than anything a line scan can be; the
 * writers stay line-based because they edit files in place and must preserve every byte they do
 * not mean to change.
 */

import { canonicalText } from "./text-similarity";

export interface Fence {
  marker: string;
  length: number;
  info: string;
}

/** Read a fence line: up to three leading spaces, then three or more backticks or tildes. */
export function readFence(line: string): Fence | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;

  const marker = line[i];
  if (marker !== "`" && marker !== "~") return null;

  let length = 0;
  while (line[i + length] === marker) length++;
  if (length < 3) return null;

  const info = line.slice(i + length).trim();
  // A backtick fence's info string may not itself contain a backtick.
  if (marker === "`" && info.includes("`")) return null;
  return { marker, length, info };
}

/** Does `fence` close a block opened by `open`? Same marker, no shorter, and no info string. */
export function closesFence(open: Fence, fence: Fence): boolean {
  return fence.marker === open.marker && fence.length >= open.length && fence.info.length === 0;
}

/**
 * The file's lines with everything inside a fenced code block blanked out.
 *
 * A vault file can hold an example of the very shape this code maintains: a fenced block showing
 * "## Key Strengths" and a "- (none)" under it. Read as structure, the writers aimed at the
 * example and the cleanup deleted a line out of it. Blanking the block first means the scans
 * below cannot see into it, while the line numbers still line up with the real file.
 */
export function maskFenced(lines: readonly string[]): string[] {
  const masked = [...lines];
  let open: { start: number; fence: Fence } | null = null;

  for (const [i, line] of lines.entries()) {
    const fence = readFence(line);
    if (!open) {
      if (fence) open = { start: i, fence };
      continue;
    }
    if (fence && closesFence(open.fence, fence)) {
      for (let j = open.start; j <= i; j++) masked[j] = "";
      open = null;
    }
  }
  // An unclosed fence runs to the end of the file.
  if (open) for (let j = open.start; j < masked.length; j++) masked[j] = "";

  return masked;
}

/**
 * True for heading text that opens an archived or historical era.
 *
 * Takes the text rather than the line, because the two callers arrive with it differently: the
 * writers parse an ATX heading off a line, the reader takes it from a remark node. `text` is
 * expected canonical, which both `canonicalText` and remark's node text are put through.
 */
export function isArchivedHeadingText(text: string): boolean {
  const words = canonicalText(text).split(" ");
  return words.includes("archived") || words.includes("historical");
}

/**
 * Index of the line closing a leading YAML frontmatter block, or -1 when there is none.
 * Delimiters sit at column 0; an indented `---` is content inside the block, not its end.
 *
 * Callers use this to find where a document's body starts, because nothing inside frontmatter
 * is a heading, a table or a marker however much it looks like one.
 */
export function frontmatterEnd(lines: readonly string[]): number {
  const isDelimiter = (line: string) => line === "---" || line === "---\r";
  if (!isDelimiter(lines[0] ?? "")) return -1;
  for (let i = 1; i < lines.length; i++) if (isDelimiter(lines[i])) return i;
  return -1;
}
