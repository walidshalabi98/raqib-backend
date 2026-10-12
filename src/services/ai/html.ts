/**
 * HTML helpers for the report and assessment HTML built from model output and database text.
 * Every interpolated value goes through escapeHtml, so a "<script>" written by the model or
 * typed into an indicator is shown as text and never runs.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes a value for use in HTML text or a quoted attribute; null and undefined become "". */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/** One escaped <p> per non-empty line of the text; "" when there is no text. */
export function htmlParagraphs(text: string | null | undefined): string {
  return (text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `<p>${escapeHtml(line)}</p>`)
    .join('\n');
}

/** An escaped <ul> (or <ol>) of the non-empty items; "" when there are none. */
export function htmlList(items: readonly string[] | null | undefined, ordered = false): string {
  const entries = (items ?? []).map(item => (item ?? '').trim()).filter(Boolean);
  if (entries.length === 0) return '';
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${entries.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
}

/**
 * A visible warning under model text that holds numbers not found in the data sent to the model
 * (indicatorFigures.unverifiedFigures), so a reviewer checks them before approval; "" when there are
 * none. The figures are escaped.
 */
export function figureWarning(figures: readonly string[] | null | undefined): string {
  const list = (figures ?? []).map(f => (f ?? '').trim()).filter(Boolean);
  if (list.length === 0) return '';
  return `<p class="figure-check">Check these figures: ${escapeHtml(list.join(', '))} — not found in the data provided</p>`;
}
