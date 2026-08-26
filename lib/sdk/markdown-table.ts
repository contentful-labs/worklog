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
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && (line[i + 1] === "|" || line[i + 1] === "\\")) {
      current += line[i + 1];
      i++;
    } else if (line[i] === "|") {
      cells.push(current);
      current = "";
    } else {
      current += line[i];
    }
  }
  cells.push(current);
  // Drop the empty strings either side of the outer pipes.
  return cells.slice(1, -1).map((cell) => cell.trim());
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
