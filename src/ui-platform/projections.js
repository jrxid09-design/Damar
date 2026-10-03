'use strict';

function approvalProjection(record = {}) { return Object.freeze({ approvalId: record.approval_id ?? record.approvalId, state: record.state ?? 'UNKNOWN', expiresAt: record.expires_at ?? null, risk: record.risk ?? null, effect: record.effect ?? null, authorityResult: record.authority_result ?? 'UNKNOWN', verificationResult: record.verification_result ?? 'UNKNOWN', source: 'canonical_approval_projection' }); }
function notificationProjection(record = {}) { return Object.freeze({ notificationId: record.notification_id ?? record.notificationId, deliveryState: record.delivery_state ?? 'UNKNOWN', acknowledgementState: record.acknowledgement_state ?? 'UNACKNOWLEDGED', urgency: record.urgency ?? 'NORMAL', privacySensitivity: record.privacy_sensitivity ?? 'NORMAL', sourceEvent: record.source_event ?? null, targetSurfaces: record.target_surfaces ?? [], source: 'canonical_notification_projection' }); }

module.exports = { approvalProjection, notificationProjection };
