// DAMAR support links: the ONE place to set the public repository at publish time (DAMAR is MIT open source; v1 is free;
// support is via GitHub Issues and Discussions). Used by DAMAR Control (served as /control/support-links.js) and by the
// CLI `help` command (require('../control/support-links.js')).
(function (root) {
  var REPO = 'https://github.com/<org>/damar';   // TODO(publish): set the real organisation before release
  var LINKS = Object.freeze({ repo: REPO, issues: REPO + '/issues', discussions: REPO + '/discussions', license: 'MIT' });
  if (typeof module !== 'undefined' && module.exports) module.exports = LINKS;
  else root.DAMAR_SUPPORT = LINKS;
})(typeof window !== 'undefined' ? window : globalThis);
