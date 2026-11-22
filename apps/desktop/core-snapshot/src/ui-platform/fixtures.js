'use strict';
const FIXTURE_ONLY = 'TEST_FIXTURE_ONLY';
const visualStates = ['DORMANT', 'IDLE', 'LISTENING', 'THINKING', 'ACTING', 'WAITING_FOR_USER', 'WAITING_FOR_AUTHORITY', 'VERIFYING', 'COMPLETED', 'DEGRADED', 'ATTENTION', 'SECURITY_ALERT', 'OFFLINE', 'UNKNOWN'];
const FIXTURES = Object.freeze(Object.fromEntries(visualStates.map((state) => [state, Object.freeze({ fixture: FIXTURE_ONLY, state, freshness: state === 'UNKNOWN' ? 'UNKNOWN' : 'LIVE', label: state.replaceAll('_', ' ') })])));
module.exports = { FIXTURE_ONLY, FIXTURES };
