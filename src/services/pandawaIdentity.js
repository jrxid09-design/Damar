"use strict";

/** Canonical Pandawa identity/target vocabulary. Roles are descriptive only. */
const RECORDS = Object.freeze([
  { id: "pandawa:puntadewa", agentId: "puntadewa", displayName: "Puntadewa", role: "strategy" },
  { id: "pandawa:werkudara", agentId: "werkudara", displayName: "Werkudara", role: "security" },
  { id: "pandawa:janaka", agentId: "janaka", displayName: "Janaka", role: "engineering" },
  { id: "pandawa:nakula", agentId: "nakula", displayName: "Nakula", role: "data" },
  { id: "pandawa:sadewa", agentId: "sadewa", displayName: "Sadewa", role: "research" }
].map(Object.freeze));

const ALIASES = Object.freeze({
  yudistira: "pandawa:puntadewa",
  bima: "pandawa:werkudara",
  arjuna: "pandawa:janaka"
});

const BY_ID = new Map(RECORDS.map(record => [record.id, record]));
const BY_AGENT = new Map(RECORDS.map(record => [record.agentId, record]));
const BY_NAME = new Map(RECORDS.flatMap(record => [
  [record.displayName.toLowerCase(), record],
  [record.agentId, record]
]));

function normalize(value) {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

function resolve(value) {
  const key = normalize(value);
  const canonicalId = ALIASES[key] ?? (key.startsWith("pandawa:") ? key : null);
  const record = canonicalId ? BY_ID.get(canonicalId) : BY_NAME.get(key);
  return record ? Object.freeze({ ...record }) : null;
}

function resolveTarget(text) {
  const input = String(text ?? "").trim();
  const leading = input.match(/^@?([\p{L}][\p{L}0-9_-]*)\s*[,;:]?/u);
  const first = leading ? leading[1] : "";
  const target = resolve(first);
  if (target) return target;
  if (/^(?:pandawa|koloni pandawa)\b/i.test(input)) {
    return Object.freeze({ id: "pandawa:colony", agentId: null, displayName: "Pandawa Colony", role: "colony" });
  }
  return Object.freeze({ id: "damar", agentId: "damar", displayName: "Damar", role: "primary" });
}

function assertPandawaId(id) {
  const record = resolve(id);
  if (!record) throw new TypeError("PANDAWA_ID_INVALID");
  return record.id;
}

module.exports = Object.freeze({
  records: () => Object.freeze(RECORDS.map(record => Object.freeze({ ...record }))),
  aliases: () => ALIASES,
  resolve,
  resolveTarget,
  assertPandawaId,
  isPandawa: value => Boolean(resolve(value))
});
