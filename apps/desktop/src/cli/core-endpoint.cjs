'use strict';

function coreEndpoint(value = process.env.DAMAR_CORE_URL) {
  const url = new URL(value || `http://127.0.0.1:${process.env.DAMAR_CORE_PORT || '29623'}`);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !Number(url.port)) {
    throw Error('CORE_ENDPOINT_INVALID');
  }
  return url.origin;
}

module.exports = { coreEndpoint };
