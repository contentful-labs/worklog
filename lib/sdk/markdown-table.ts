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
  for (const char of line) {
    if (char === "-") hasDash = true;
    else if (char !== "|" && char !== ":" && char !== " " && char !== "\t") return false;
  }
  return hasDash;
}

/** Split a table row into trimmed cells, honouring `\\` and `\|` escapes. */
export function splitRow(rawLine: string): string[] {
  // GFM allows a row without the outer pipes; only drop the empty strings that a real
  // leading or trailing pipe produces, or the last cell of an unterminated row is lost.
  const line = rawLine.trim();
  const cells: string[] = [];
  let current = "";
  let lastDelimiter = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && (line[i + 1] === "|" || line[i + 1] === "\\")) {
      current += line[i + 1];
      i++;
    } else if (line[i] === "|") {
      cells.push(current);
      current = "";
      lastDelimiter = i;
    } else {
      current += line[i];
    }
  }
  cells.push(current);
  // The scanner already knows which pipes were delimiters, so a cell ending in a literal
  // backslash cannot be mistaken for an escaped closing pipe.
  const start = line.startsWith("|") ? 1 : 0;
  const end = line.length > 1 && lastDelimiter === line.length - 1 ? cells.length - 1 : cells.length;
  return cells.slice(start, end).map((cell) => cell.trim());
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
export function findTable(lines: string[], fromLine = 0): TableBounds | null {
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
