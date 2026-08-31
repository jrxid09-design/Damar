"use strict";

const CODES = Object.freeze({
  INVALID_INPUT: "MEDIA_INVALID_INPUT",
  UNSUPPORTED_SOURCE: "MEDIA_UNSUPPORTED_SOURCE",
  OVERSIZE: "MEDIA_OVERSIZE",
  AGGREGATE_EXCEEDED: "MEDIA_AGGREGATE_EXCEEDED",
  INVALID_FILENAME: "MEDIA_INVALID_FILENAME",
  INVALID_METADATA: "MEDIA_INVALID_METADATA",
  STORAGE_FAILURE: "MEDIA_STORAGE_FAILURE",
  PARTIAL_READ: "MEDIA_PARTIAL_READ",
  HASH_FAILURE: "MEDIA_HASH_FAILURE",
  DETECTION_FAILURE: "MEDIA_DETECTION_FAILURE",
  STORAGE_ESCAPE: "MEDIA_STORAGE_ESCAPE",
  INVALID_DESCRIPTOR: "MEDIA_INVALID_DESCRIPTOR",
  FOREIGN_REFERENCE: "MEDIA_FOREIGN_REFERENCE"
});

class MediaIngressError extends Error {
  constructor(code, message, details) {
    super(`[${code}] ${message || "media ingress rejected"}`);
    this.name = "MediaIngressError";
    this.code = code;
    if (details !== undefined) this.details = Object.freeze({ ...details });
  }
}

module.exports = { CODES, MediaIngressError };
