"use strict";

function createMediaContextAuthority() {
  const branded = new WeakSet();
  function mint(attachments) {
    if (!Array.isArray(attachments) || !Object.isFrozen(attachments) || attachments.length > 8) throw new TypeError("MEDIA_CONTEXT_INVALID");
    const safe = [];
    for (let i = 0; i < attachments.length; i += 1) {
      const entry = Object.getOwnPropertyDescriptor(attachments, String(i));
      if (!entry || !("value" in entry) || entry.value === null || typeof entry.value !== "object" || require("node:util").types.isProxy(entry.value)) throw new TypeError("MEDIA_CONTEXT_INVALID");
      const value = entry.value, proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("MEDIA_CONTEXT_INVALID");
      const names = Object.getOwnPropertyNames(value).sort(), id = Object.getOwnPropertyDescriptor(value, "attachmentId"), read = Object.getOwnPropertyDescriptor(value, "read");
      if (names.length !== 2 || names[0] !== "attachmentId" || names[1] !== "read" || !id || !("value" in id) || typeof id.value !== "string" || !read || !("value" in read) || typeof read.value !== "function") throw new TypeError("MEDIA_CONTEXT_INVALID");
      safe.push(Object.freeze({ attachmentId: id.value, read: read.value }));
    }
    const context = Object.freeze({ attachments: Object.freeze(safe) });
    branded.add(context);
    return context;
  }
  function recognize(value) { return value !== null && typeof value === "object" && !require("node:util").types.isProxy(value) && branded.has(value); }
  return Object.freeze({ mint, recognize });
}

module.exports = Object.freeze({ createMediaContextAuthority });
