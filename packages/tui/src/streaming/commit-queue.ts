/**
 * Newline-gated markdown commit queue (Codex tui/src/streaming pattern).
 *
 * Streaming tokens land in a live region; a line is COMMITTED (moved to the
 * <Static> transcript, i.e. native scrollback, never re-rendered) only when it
 * can no longer change visually:
 *   - the line is complete (a newline followed it), AND
 *   - it is not inside an open ``` fence (the fence renders as one block), AND
 *   - it is not part of a markdown table that may still be growing
 *     (TABLE-HOLDBACK: a table is committed only when a non-table line — or
 *     flush() — proves it is finished; committing row-by-row breaks alignment).
 *
 * Pure logic, no Ink dependency — unit-testable and reusable by any front-end.
 */

export class CommitQueue {
  private buffer = "";
  /** Complete lines that are held back (open fence or growing table). */
  private held: string[] = [];
  private inFence = false;

  /** Feed streamed text. Returns the lines that became committable NOW. */
  push(text: string): string[] {
    this.buffer += text;
    const committed: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      committed.push(...this.acceptLine(line));
    }
    return committed;
  }

  /** The not-yet-committed tail (held lines + partial line) for the live region. */
  pending(): string {
    const parts = [...this.held];
    if (this.buffer.length > 0) parts.push(this.buffer);
    return parts.join("\n");
  }

  /** End of stream: everything pending commits as-is (fence closed implicitly). */
  flush(): string[] {
    const out = [...this.held];
    if (this.buffer.length > 0) out.push(this.buffer);
    this.held = [];
    this.buffer = "";
    this.inFence = false;
    return out;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private acceptLine(line: string): string[] {
    if (this.isFenceDelimiter(line)) {
      if (!this.inFence) {
        // Fence OPENS: hold from here — the block renders atomically.
        this.inFence = true;
        this.held.push(line);
        return [];
      }
      // Fence CLOSES: the whole block is final.
      this.inFence = false;
      this.held.push(line);
      const block = this.held;
      this.held = [];
      return block;
    }
    if (this.inFence) {
      this.held.push(line);
      return [];
    }
    if (this.isTableLine(line)) {
      // Table row: hold — the next line may be another row.
      this.held.push(line);
      return [];
    }
    // A non-table, non-fence line: any held table is now provably complete.
    const out = this.held.length > 0 ? [...this.held, line] : [line];
    this.held = [];
    return out;
  }

  private isFenceDelimiter(line: string): boolean {
    return /^\s*(```|~~~)/.test(line);
  }

  private isTableLine(line: string): boolean {
    const t = line.trimEnd();
    return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
  }
}
