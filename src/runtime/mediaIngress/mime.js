"use strict";

const SIGNATURES = Object.freeze([
  ["image/jpeg", (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/png", (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))],
  ["image/gif", (b) => b.length >= 6 && (b.subarray(0, 6).toString("ascii") === "GIF87a" || b.subarray(0, 6).toString("ascii") === "GIF89a")],
  ["image/webp", (b) => b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP"],
  ["application/pdf", (b) => b.length >= 5 && b.subarray(0, 5).toString("ascii") === "%PDF-"],
  ["application/zip", (b) => b.length >= 4 && ["504b0304", "504b0506", "504b0708"].includes(b.subarray(0, 4).toString("hex"))],
  ["application/gzip", (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b],
  ["application/x-7z-compressed", (b) => b.length >= 6 && b.subarray(0, 6).equals(Buffer.from("377abcaf271c", "hex"))],
  ["audio/wav", (b) => b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WAVE"],
  ["audio/flac", (b) => b.length >= 4 && b.subarray(0, 4).toString("ascii") === "fLaC"],
  ["audio/ogg", (b) => b.length >= 4 && b.subarray(0, 4).toString("ascii") === "OggS"],
  ["audio/mpeg", (b) => b.length >= 3 && (b.subarray(0, 3).toString("ascii") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))],
  ["video/webm", (b) => b.length >= 4 && b.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))],
  ["application/x-tar", (b) => b.length >= 262 && b.subarray(257, 262).toString("ascii") === "ustar"]
]);

function sniffMime(bytes) {
  for (const [mime, matches] of SIGNATURES) if (matches(bytes)) return mime;
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii");
    return brand === "M4A " ? "audio/mp4" : "video/mp4";
  }
  if (bytes.length > 0 && !bytes.includes(0)) {
    const text = bytes.toString("utf8");
    if (!text.includes("\ufffd") && /^[\u0009\u000a\u000d\u0020-\u007e\u0080-\uffff]*$/u.test(text)) {
      const trimmed = text.trimStart();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "application/json";
      return "text/plain";
    }
  }
  return "application/octet-stream";
}

function mediaKind(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (["application/zip", "application/gzip", "application/x-7z-compressed", "application/x-tar"].includes(mime)) return "archive";
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/pdf" || /officedocument|msword|ms-excel|ms-powerpoint/.test(mime)) return "document";
  return "binary";
}

module.exports = { sniffMime, mediaKind };
