'use strict';
const path = require('node:path');
const express = require('express');
function attachPresence(app) {
  const directory = path.resolve(__dirname, '../../dist/uix-w5');
  app.use('/presence', express.static(directory, { index: false }));
  app.get('/s/idle_presence', (_req, res) => res.sendFile(path.join(directory, 'index.html')));
}
module.exports = { attachPresence };
