/**
 * Cause classification for the AC-1 legality run (criterion L6: *every* distinct rejection or
 * responder-throw cause observed is named in the write-up, never bucketed into "other").
 *
 * The classification is deliberately mechanical rather than a hand-written list of known causes.
 * A hand-written list answers "did any of the causes I already expected occur?"; normalizing the
 * message and grouping by the result answers "what causes occurred?", which is the question L6
 * actually asks, and it is the only version that can surface a cause nobody anticipated.
 */

/** The error's constructor name (`InputError`, `Error`, `TypeError`, ...), or the typeof for a non-Error throw. */
export function errorClassName(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.constructor?.name ?? 'Error';
  }
  return `non-Error(${typeof cause})`;
}

/**
 * The cause's message with everything run-specific normalized away, so two occurrences of the
 * same underlying cause collapse to one signature and the histogram counts causes rather than
 * incidents. Normalized, in order: player ids (`p-red`), game ids (`g-nadia-712345`), card names
 * in quotes, embedded JSON objects (an `InputResponse` echoed into a message), and finally any
 * remaining run of digits.
 *
 * Over-normalizing is the risk worth naming: collapsing `N` over every number means two causes
 * that differ only in a numeric constant look identical. That is the right trade here - the
 * numbers in these messages are counts and costs, which vary per incident by construction - but
 * it is why the raw message of a *representative* incident is kept alongside the signature
 * (`representative`, below) rather than being discarded.
 */
export function causeSignature(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message
    .replace(/\bp-[a-z]+\b/gi, '<player>')
    .replace(/\bg-nadia-\d+\b/gi, '<game>')
    .replace(/\{[^{}]*\}/g, '<json>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first message seen for a signature, kept verbatim so the normalization above stays auditable. */
export function representativeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
