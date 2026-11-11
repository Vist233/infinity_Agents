/** A CSV text: the header, then one line per row; a cell with a comma, a quote or a line break is quoted. */
export function renderCsv(header: string[], rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>): string {
  const cell = (value: string | number | boolean | null) => {
    const text = value === null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${[header.join(","), ...rows.map((row) => row.map(cell).join(","))].join("\n")}\n`;
}
