'use strict';
const segmenter = new Intl.Segmenter('id', { granularity: 'grapheme' });
const split = text => [...segmenter.segment(text)].map(item => item.segment);
class Editor {
  constructor({ maxBytes = 8192, historyLimit = 100 } = {}) {
    this.maxBytes = maxBytes; this.historyLimit = historyLimit;
    this.cells = []; this.cursor = 0; this.history = []; this.historyAt = null; this.draft = '';
    this.search = null;
  }
  get text() { return this.cells.join(''); }
  replace(text) {
    if (Buffer.byteLength(text) > this.maxBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw Error('UNSAFE_OR_OVERSIZED_INPUT');
    this.cells = split(text.replace(/\r\n?/g, '\n')); this.cursor = this.cells.length;
  }
  insert(text) {
    const clean = text.replace(/\r\n?/g, '\n');
    if (Buffer.byteLength(this.text + clean) > this.maxBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(clean)) throw Error('UNSAFE_OR_OVERSIZED_INPUT');
    // Resegment the whole draft so a combining mark inserted beside an existing character stays atomic.
    const prefix = this.cells.slice(0, this.cursor).join('') + clean;
    this.cells = split(prefix + this.cells.slice(this.cursor).join(''));
    this.cursor = split(prefix).length; this.historyAt = null;
  }
  backspace() { if (this.cursor) { this.cells.splice(--this.cursor, 1); this.historyAt = null; } }
  delete() { this.cells.splice(this.cursor, 1); this.historyAt = null; }
  left() { this.cursor = Math.max(0, this.cursor - 1); }
  right() { this.cursor = Math.min(this.cells.length, this.cursor + 1); }
  home() { while (this.cursor > 0 && this.cells[this.cursor - 1] !== '\n') this.cursor--; }
  end() { while (this.cursor < this.cells.length && this.cells[this.cursor] !== '\n') this.cursor++; }
  wordLeft() {
    while (this.cursor > 0 && /\s/.test(this.cells[this.cursor - 1])) this.cursor--;
    while (this.cursor > 0 && !/\s/.test(this.cells[this.cursor - 1])) this.cursor--;
  }
  wordRight() {
    while (this.cursor < this.cells.length && !/\s/.test(this.cells[this.cursor])) this.cursor++;
    while (this.cursor < this.cells.length && /\s/.test(this.cells[this.cursor])) this.cursor++;
  }
  clear() { this.cells = []; this.cursor = 0; this.historyAt = null; }
  remember(command) {
    // Persist nothing. Only exact, argument-free, nonsecret read command names enter memory history.
    if (!/^(?:\/?(?:help|status|jobs|doctor|session|catalog)|\?)$/.test(command)) return;
    this.history = this.history.filter(item => item !== command); this.history.push(command);
    this.history = this.history.slice(-this.historyLimit); this.historyAt = null;
  }
  previous() {
    if (!this.history.length) return;
    if (this.historyAt === null) { this.draft = this.text; this.historyAt = this.history.length; }
    this.historyAt = Math.max(0, this.historyAt - 1);
    this.replace(this.history[this.historyAt]);
  }
  next() {
    if (this.historyAt === null) return;
    this.historyAt = Math.min(this.history.length, this.historyAt + 1);
    if (this.historyAt === this.history.length) { this.replace(this.draft); this.historyAt = null; }
    else this.replace(this.history[this.historyAt]);
  }
  find(query, before = this.history.length) {
    if (typeof query !== 'string') throw Error('INVALID_HISTORY_QUERY');
    for (let index = before - 1; index >= 0; index--) if (this.history[index].includes(query)) return { index, text: this.history[index] };
    return null;
  }
}
module.exports = { Editor, split };
