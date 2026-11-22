'use strict';
// Separates a model's reasoning from its answer in a streamed reply. Some models (MiniMax, DeepSeek-R1 style) inline it
// as <think>...</think> in the content; a tag may be split across chunks, so a trailing partial tag is held back until
// the next chunk decides it. Text outside the tags is the answer; text inside is reasoning (never shown as the answer,
// never replayed to the model as the assistant's words).
const OPEN = '<think>', CLOSE = '</think>';

function createReasoningSplitter() {
  let inside = false, held = '';
  // Longest suffix of s that is a proper prefix of tag (a tag that may continue in the next chunk).
  const partial = (s, tag) => { for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n; return 0; };
  function feed(chunk, final = false) {
    let s = held + String(chunk || ''); held = '';
    const out = { answer: '', reasoning: '' };
    for (;;) {
      const tag = inside ? CLOSE : OPEN, at = s.toLowerCase().indexOf(tag);
      if (at === -1) {
        const keep = final ? 0 : partial(s.toLowerCase(), tag);
        out[inside ? 'reasoning' : 'answer'] += s.slice(0, s.length - keep); held = s.slice(s.length - keep);
        return out;
      }
      out[inside ? 'reasoning' : 'answer'] += s.slice(0, at);
      s = s.slice(at + tag.length); inside = !inside;
    }
  }
  return { feed, flush: () => feed('', true) };
}
module.exports = { createReasoningSplitter };
