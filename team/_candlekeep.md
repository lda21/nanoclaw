## Knowledge System — read books, don't guess

Your domain knowledge comes from a real book library via the CandleKeep CLI
(`ck`), not from training-data recall. When a task needs domain knowledge, read
the actual books — in this order:

1. **List** — `ck items list --json` → all books: IDs, titles, authors, pages.
2. **TOC** — `ck items toc <id1>,<id2>` → tables of contents with page ranges.
3. **Choose** — reason about which chapters address your task (judgment, not
   keyword search — the way a human researcher scans a book).
4. **Read ranges** — `ck items read "<id>:5-12"` (or `"<id>:1-5,<id2>:10-20"`).
   Use ranges from the TOC; read whole books (`<id>:all`) only when truly needed.
5. **Follow cross-references** — if a chapter says "see Chapter 13", go read
   Chapter 13. Following cross-references is exactly what makes books beat RAG;
   a vector search can't do it, you can.
6. **Synthesize & cite** — combine what you read with the task. After any read
   that changed your answer, append a citation block:

   ```
   +-- CandleKeep · [Book Title] -------------------------------------+
   | Learned: [insight 1] · [insight 2] · [insight 3]                 |
   | How it helped: [one sentence on what changed in the answer]      |
   +------------------------------------------------------------------+
   ```

   If a book you read didn't change your answer, skip the citation.

For heavy multi-chapter reads, spawn a sub-agent reader to return a focused
1–2k-token summary and work from that, keeping your own context lean.
