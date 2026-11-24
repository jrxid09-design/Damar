(function (root) {
  'use strict';
  // Damar Notch behavior engine (Fase 2): pure signal -> decision mapping.
  // The island folds real Core events (approvals, mission lifecycle, alerts,
  // Mata Dewa mode, media) and real PC activity (foreground app category,
  // idle time) into a signals object every 1.2 s; this module decides the
  // character's emote / costume / gesture. No timers, no randomness, no
  // hard-coded "tricks": the Owner's examples (pointing at an approval,
  // dressing for the work at hand, resting when the PC is idle) fall out of
  // the signal combinations and the priority order below.
  //
  // Priorities (highest first): alert > approval > failure > completion >
  // mission > PC-idle rest > Mata Dewa mode > PC context class > media >
  // idle default. Urgent and event decisions preempt immediately; calm
  // context changes are held by a dwell window so the character never
  // flickers between costumes while signals jitter.
  //
  // Speaking is a PARALLEL channel, not an emote: while the Core voice is
  // active (sig.speaking, driven by real TTS/voice events) the decision
  // carries talk:true and the rig lip-syncs its jaw to the voice envelope.
  // Talk sits below alert/approval (an urgent face owns the mouth) and
  // parallel to mission/context. It is computed fresh on every call and is
  // never held by the dwell window: voice start/stop are events.

  const DWELL_MS = 2500;              // calm changes must wait out the dwell
  const PC_REST_IDLE_MS = 300000;     // 5 min of PC idle -> resting face

  // PC foreground-app category -> costume class (the character dresses for
  // the kind of work on screen, whether or not a Core mission is running).
  const CATEGORY_COSTUME = {
    code: 'hacker',
    design: 'artist',
    engineering: 'engineer',
    security: 'detective',
  };

  function decideBehavior(sig, prev, now) {
    sig = sig || {};
    const pc = sig.pc || null;
    let emote = 'senang', costume = null, gesture = null, celebrate = false, kind = 'context';

    if (sig.alertActive) {
      emote = 'siaga'; gesture = 'point'; kind = 'urgent';
      costume = sig.matadewaMode ? 'matadewa' : null;
    } else if (sig.pendingApprovals > 0) {
      emote = 'siaga'; gesture = 'point'; kind = 'urgent';
      costume = sig.matadewaMode ? 'matadewa' : null;
    } else if (sig.recentFailure) {
      emote = 'pulih'; kind = 'event';
    } else if (sig.recentCompletion) {
      emote = 'senang'; gesture = 'wave'; celebrate = true; kind = 'event';
    } else if (pc && pc.idleMs >= PC_REST_IDLE_MS) {
      emote = 'pulih'; kind = 'context';
    } else {
      // Context layer: costume follows Mata Dewa mode first, then the PC
      // app class; the face follows the mission / media / costume context.
      if (sig.matadewaMode) costume = 'matadewa';
      else if (pc && CATEGORY_COSTUME[pc.category]) costume = CATEGORY_COSTUME[pc.category];
      if (sig.missionActive) emote = 'berpikir';
      else if (sig.mediaPlaying || (pc && pc.category === 'media')) emote = 'senang';
      else if (costume) emote = 'berpikir';
      kind = 'context';
    }

    const talk = !!sig.speaking && !sig.alertActive && !(sig.pendingApprovals > 0);
    const decision = { emote, costume, gesture, celebrate, kind, talk, changed: true };
    if (!prev) return decision;
    const same = prev.emote === emote && (prev.costume || null) === costume && (prev.gesture || null) === gesture;
    if (same) { decision.changed = false; return decision; }
    // Dwell: a calm context change is held while the previous (calm)
    // decision is younger than the dwell window. Urgent/event candidates
    // always preempt; a previous urgent/event decision never blocks.
    const prevKind = prev.kind || 'context';
    if (kind === 'context' && prevKind === 'context' && typeof prev.since === 'number' && now - prev.since < DWELL_MS) {
      return { emote: prev.emote, costume: prev.costume || null, gesture: prev.gesture || null, celebrate: false, kind: prevKind, talk, changed: false };
    }
    return decision;
  }

  root.DamarNotchBehavior = { decideBehavior, DWELL_MS, PC_REST_IDLE_MS, CATEGORY_COSTUME };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DamarNotchBehavior;
})(typeof window !== 'undefined' ? window : globalThis);
