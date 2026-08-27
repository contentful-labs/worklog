/**
 * Markdown table helpers shared by the vault writers.
 *
 * Vault files keep the current era's table first and archived eras below it, so
 * "append a row" always means "append to the first table", never end-of-file.
 */

/**
 * Match a table separator row: `|------|`, `| :--- | ---: |`.
 * Written as a scan rather than a regex because the equivalent pattern is
 * polynomial-time backtracking on adversarial input (CodeQL js/polynomial-redos).
 */
export function isTableSeparator(line: string): boolean {
  if (!line.startsWith("|")) return false;
  let hasDash = false;
  for (const char of stripCarriageReturn(line)) {
    if (char === "-") hasDash = true;
    else if (char !== "|" && char !== ":" && char !== " " && char !== "\t") return false;
  }
  return hasDash;
}

/**
 * A file written on Windows carries a `\r` at the end of every line. It is not part of
 * the cell content and it is not part of the separator syntax.
 */
function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export interface ScannedRow {
  /** Cell values with escapes resolved and whitespace trimmed. */
  values: string[];
  /** Cell sources exactly as written, including their surrounding spaces. */
  raw: string[];
  /** Everything before the first cell: indentation and any leading pipe. */
  prefix: string;
  /** Everything after the last cell: any trailing pipe and trailing whitespace. */
  suffix: string;
}

/**
 * Split a table row into its cells, keeping both the value and the source.
 *
 * The source matters because `splitRow` and `renderRow` are not inverses: the scan
 * resolves `\|` and `\\` but leaves every other escape alone, while `escapeCell`
 * escapes the backslash it finds. Re-rendering an untouched cell therefore rewrites
 * `\*literal\*` as `\\*literal\\*` and changes what it means. A caller that edits one
 * cell should keep the raw text of the others and rebuild with `renderScannedRow`.
 */
export function scanRow(line: string): ScannedRow {
  let start = 0;
  while (start < line.length && (line[start] === " " || line[start] === "\t")) start++;
  let end = line.length;
  while (end > start && (line[end - 1] === " " || line[end - 1] === "\t" || line[end - 1] === "\r")) end--;
  const body = line.slice(start, end);

  const values: string[] = [];
  const raw: string[] = [];
  let value = "";
  let source = "";
  let lastDelimiter = -1;

  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && (body[i + 1] === "|" || body[i + 1] === "\\")) {
      value += body[i + 1];
      source += body[i] + body[i + 1];
      i++;
    } else if (body[i] === "|") {
      values.push(value);
      raw.push(source);
      value = "";
      source = "";
      lastDelimiter = i;
    } else {
      value += body[i];
      source += body[i];
    }
  }
  values.push(value);
  raw.push(source);

  // GFM allows a row without the outer pipes; only drop the empty strings that a real
  // leading or trailing pipe produces, or the last cell of an unterminated row is lost.
  // The scanner already knows which pipes were delimiters, so a cell ending in a literal
  // backslash cannot be mistaken for an escaped closing pipe.
  const first = body.startsWith("|") ? 1 : 0;
  const last = body.length > 1 && lastDelimiter === body.length - 1 ? values.length - 1 : values.length;

  return {
    values: values.slice(first, last).map((cell) => cell.trim()),
    raw: raw.slice(first, last),
    prefix: line.slice(0, start) + (first === 1 ? "|" : ""),
    suffix: (last < values.length ? "|" : "") + line.slice(end),
  };
}

/** Split a table row into trimmed cells, honouring `\\` and `\|` escapes. */
export function splitRow(rawLine: string): string[] {
  return scanRow(rawLine).values;
}

/** Rebuild a row from a scan, whose raw cells the caller may have edited. */
export function renderScannedRow(row: ScannedRow): string {
  return row.prefix + row.raw.join("|") + row.suffix;
}

/**
 * Make a value safe to place in a table cell.
 * Backslashes are escaped before pipes, otherwise the escape character introduced for a
 * pipe could be swallowed by a backslash already in the text.
 */
export function escapeCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** Render cells as a table row. */
export function renderRow(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

/** Insert rows after the last row of the first table in `content`. */
export function appendToFirstTable(content: string, rows: string[]): string {
  if (rows.length === 0) return content;
  const lines = content.split("\n");
  const separatorIdx = lines.findIndex(isTableSeparator);
  if (separatorIdx === -1) return content.trimEnd() + "\n" + rows.join("\n");

  let lastRowIdx = separatorIdx;
  while (lastRowIdx + 1 < lines.length && lines[lastRowIdx + 1].startsWith("|")) lastRowIdx++;
  lines.splice(lastRowIdx + 1, 0, ...rows);
  return lines.join("\n");
}

export interface TableBounds {
  /** Line index of the first data row. */
  rowStart: number;
  /** One past the last data row. */
  rowEnd: number;
}

/**
 * Locate the first table at or after `fromLine`, so a caller can read or rewrite the
 * rows of one era's table without disturbing the archived tables below it.
 */
export function findTable(lines: readonly string[], fromLine = 0): TableBounds | null {
  let separatorIdx = -1;
  for (let i = Math.max(fromLine, 0); i < lines.length; i++) {
    if (isTableSeparator(lines[i])) {
      separatorIdx = i;
      break;
    }
  }
  if (separatorIdx === -1) return null;

  let rowEnd = separatorIdx + 1;
  while (rowEnd < lines.length && lines[rowEnd].startsWith("|")) rowEnd++;
  return { rowStart: separatorIdx + 1, rowEnd };
}
