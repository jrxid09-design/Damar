"use strict";

// Public barrel for the canonical Surface Notification Domain (frozen). Exactly
// ONE canonical Notification owner: createNotificationDomain. It is not an
// authority source and no notification action executes anything directly.

const domain = require("./domain");
const policy = require("./policy");
const { makeNotificationStore } = require("./store");

module.exports = Object.freeze({
    createNotificationDomain: domain.createNotificationDomain,
    makeNotificationStore,
    notificationPolicy: policy.classify,
    LEVEL: policy.LEVEL,
    STATE: domain.STATE,
    TERMINAL: domain.TERMINAL,
    TRANSITIONS: domain.TRANSITIONS,
    SENSITIVITY: domain.SENSITIVITY,
    NotificationError: domain.NotificationError
});
