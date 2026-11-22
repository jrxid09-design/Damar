"use strict";

const { BusError } = require("./errors");
const { assertEnum, STREAM_EVENT_SET } = require("./enums");
const { canonicalize, byteLength, isPlainObject } = require("./payloads");
const { deepFreeze } = require("./envelope");

const IDLE = "idle";
const STARTED = "started";
const FINALIZED = "finalized";
const COMPLETED = "completed";
const FAILED = "failed";

function maxStreamDataBytes(bounds) {
  return Math.min(bounds.maxPayloadBytes, 16384);
}

class InteractionStream {
  constructor({ interactionId, bounds, clock, onTransition, expectedGeneration }) {
    this.interactionId = interactionId;
    this.bounds = bounds;
    this.clock = clock;
    this.onTransition = onTransition || (() => {});
    this.expectedGeneration = expectedGeneration || null;
    this.state = IDLE;
    this.cancelRequested = false;
    this.closed = false;
    this.seq = 0;
    this.emittedCounts = new Map();
    this.subscriptions = [];
    this.buffer = [];
  }

  get terminal() {
    return this.state === COMPLETED || this.state === FAILED;
  }

  _checkData(data, type) {
    if (data === undefined || data === null) return undefined;
    const value = isPlainObject(data) || Array.isArray(data) || typeof data !== "object" ? data : undefined;
    if (value === undefined) {
      throw new BusError("STREAM_DATA_INVALID", "stream event data must be plain or primitive", {
        type
      });
    }
    const bytes = byteLength(canonicalize(value));
    if (bytes > maxStreamDataBytes(this.bounds)) {
      throw new BusError("BOUNDS_EXCEEDED", "stream event data too large", { type });
    }
    return value;
  }

  emit(type, data) {
    assertEnum(type, STREAM_EVENT_SET, "stream event type");
    if (this.closed && !this.terminal) {
      throw new BusError("STREAM_CLOSED", "stream closed before terminal state", {
        interactionId: this.interactionId
      });
    }
    if (this.terminal) {
      throw new BusError("STREAM_INVALID_TRANSITION", `event ${type} after terminal state`, {
        interactionId: this.interactionId,
        state: this.state,
        type
      });
    }
    const safeData = this._checkData(data, type);
    if (
      safeData &&
      typeof safeData === "object" &&
      !Array.isArray(safeData) &&
      this.expectedGeneration &&
      safeData.generation !== undefined &&
      safeData.generation !== this.expectedGeneration
    ) {
      throw new BusError("STALE_GENERATION", "event carries a stale runtime generation", {
        interactionId: this.interactionId,
        expectedGeneration: this.expectedGeneration
      });
    }
    const next = this._transition(type);
    const event = deepFreeze({
      type,
      seq: ++this.seq,
      at: this.clock(),
      data: safeData === undefined ? null : safeData
    });
    this.emittedCounts.set(type, (this.emittedCounts.get(type) || 0) + 1);
    this._fanout(event);
    this.onTransition(type, next, event);
    return event;
  }

  _transition(type) {
    switch (type) {
      case "START":
        if (this.state !== IDLE) {
          throw new BusError("STREAM_INVALID_TRANSITION", "START may occur at most once", {
            interactionId: this.interactionId,
            state: this.state
          });
        }
        this.state = STARTED;
        break;
      case "DELTA":
      case "STATUS":
      case "APPROVAL_REQUIRED":
        if (this.state !== STARTED) {
          throw new BusError("STREAM_INVALID_TRANSITION", `${type} requires an active stream`, {
            interactionId: this.interactionId,
            state: this.state
          });
        }
        break;
      case "FINAL":
        if (this.state !== STARTED) {
          throw new BusError("STREAM_INVALID_TRANSITION", "FINAL requires an active stream", {
            interactionId: this.interactionId,
            state: this.state
          });
        }
        this.state = FINALIZED;
        break;
      case "ERROR":
        if (this.emittedCounts.get("ERROR")) {
          throw new BusError("STREAM_INVALID_TRANSITION", "ERROR may occur at most once", {
            interactionId: this.interactionId
          });
        }
        this.state = FAILED;
        break;
      case "COMPLETE":
        if (this.state !== FINALIZED) {
          throw new BusError("STREAM_INVALID_TRANSITION", "COMPLETE requires FINAL first", {
            interactionId: this.interactionId,
            state: this.state
          });
        }
        this.state = COMPLETED;
        break;
      default:
        throw new BusError("STREAM_INVALID_TRANSITION", `unhandled event ${type}`);
    }
    return this.state;
  }

  notifyCancellationRequested() {
    if (this.terminal || this.closed) return false;
    this.cancelRequested = true;
    try {
      this.emit("STATUS", { cancelRequested: true });
      return true;
    } catch (error) {
      if (error && error.code === "STREAM_INVALID_TRANSITION") {
        return false;
      }
      throw error;
    }
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      throw new BusError("SUBSCRIBER_INVALID", "stream subscriber must be a function");
    }
    if (typeof listener === "function" && listener.__closed) {
      throw new BusError("SUBSCRIBER_INVALID", "subscriber already closed");
    }
    const subscription = {
      listener,
      paused: false,
      open: true
    };
    this.subscriptions.push(subscription);
    return Object.freeze({
      pause: () => {
        subscription.paused = true;
      },
      resume: () => {
        subscription.paused = false;
        this._drainBuffered(subscription);
      },
      close: () => {
        subscription.open = false;
        listener.__closed = true;
      }
    });
  }

  _deliver(subscription, event) {
    if (!subscription.open) return;
    try {
      subscription.listener(event);
    } catch (error) {
      void error;
    }
  }

  _drainBuffered(subscription) {
    while (subscription.open && !subscription.paused && this.buffer.length > 0) {
      const event = this.buffer.shift();
      this._deliver(subscription, event);
    }
  }

  _fanout(event) {
    for (const subscription of this.subscriptions) {
      if (!subscription.open) continue;
      if (subscription.paused) {
        if (this.buffer.length >= this.bounds.maxStreamBufferEvents) {
          this._overflow(subscription);
          continue;
        }
        this.buffer.push(event);
        continue;
      }
      this._deliver(subscription, event);
    }
  }

  _overflow(subscription) {
    subscription.paused = false;
    const overflowEvent = deepFreeze({
      type: "ERROR",
      seq: Number.MAX_SAFE_INTEGER,
      at: this.clock(),
      data: { reason: "STREAM_BUFFER_OVERFLOW", interactionId: this.interactionId }
    });
    if (!this.terminal) {
      this.state = FAILED;
      this.onTransition("ERROR", FAILED, overflowEvent);
    }
    this._deliver(subscription, overflowEvent);
    subscription.open = false;
  }

  closeForTerminal() {
    this.closed = true;
    for (const subscription of this.subscriptions) {
      subscription.open = false;
    }
    this.buffer.length = 0;
  }

  snapshot() {
    return Object.freeze({
      state: this.state,
      cancelRequested: this.cancelRequested,
      emitted: Object.freeze(Object.fromEntries(this.emittedCounts)),
      buffered: this.buffer.length,
      subscribers: this.subscriptions.filter((s) => s.open).length
    });
  }
}

module.exports = { InteractionStream };
