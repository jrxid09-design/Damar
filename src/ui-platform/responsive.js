'use strict';
const BREAKPOINTS = Object.freeze({ phone: 0, tablet: 640, compactDesktop: 960, wideDesktop: 1280 });
function responsiveMode(width) { if (width < BREAKPOINTS.tablet) return 'phone'; if (width < BREAKPOINTS.compactDesktop) return 'tablet'; if (width < BREAKPOINTS.wideDesktop) return 'compactDesktop'; return 'wideDesktop'; }
function responsiveProps({ stackAt = 'tablet', drawerAt = 'tablet', tableFallbackAt = 'phone' } = {}) { return Object.freeze({ stackAt, drawerAt, tableFallbackAt, breakpoints: BREAKPOINTS }); }
module.exports = { BREAKPOINTS, responsiveMode, responsiveProps };
