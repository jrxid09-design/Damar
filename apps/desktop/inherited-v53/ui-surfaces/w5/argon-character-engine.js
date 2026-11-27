function drawVectorParticle(ctx, p) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(p.scale, p.scale);
      ctx.shadowColor = '#FFD166';
      ctx.shadowBlur = 8;

      if (p.kind === 'heart') {
        const hg = ctx.createRadialGradient(-2, -3, 1, 0, 0, 12);
        hg.addColorStop(0, '#FFF9DB');
        hg.addColorStop(0.5, '#F5B942');
        hg.addColorStop(1, '#D97706');
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.moveTo(0, 4);
        ctx.bezierCurveTo(-10, -4, -12, -12, -5, -12);
        ctx.bezierCurveTo(-1, -12, 0, -8, 0, -6);
        ctx.bezierCurveTo(0, -8, 1, -12, 5, -12);
        ctx.bezierCurveTo(12, -12, 10, -4, 0, 4);
        ctx.closePath();
        ctx.fill();
      } else if (p.kind === 'note') {
        ctx.fillStyle = '#FFE082';
        ctx.strokeStyle = '#FFE082';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.ellipse(-4, 2, 4.2, 3.0, -0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-0.5, 1);
        ctx.lineTo(-0.5, -11);
        ctx.quadraticCurveTo(6, -9, 6, -3);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#FFF3C4';
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const r = i % 2 === 0 ? 9 : 2.8;
          const a = (i * Math.PI) / 4;
          if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

// Small interaction surface consumed by the one Notch canvas adapter.
// This keeps event ownership outside the renderer and makes pointer coordinates
// relative to the observed rendering container rather than the window.
if (typeof window !== 'undefined') {
  const clampUnit = value => Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  window.__DAMAR_ARGON_RENDERER__ = Object.freeze({
    isReady: () => {
      const image = preloadedSprites.heroRig;
      return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    },
    setPointer: (x, y, active = true) => {
      mochiPhysics.lookX = clampUnit(x);
      mochiPhysics.lookY = clampUnit(y);
      mochiPhysics.isHoveringStage = Boolean(active);
      mochiPhysics.hoverDuration = active ? Math.min(60, mochiPhysics.hoverDuration + 1) : 0;
    },
    activate: () => {
      mochiPhysics.isDancing = !mochiPhysics.isDancing;
      mochiPhysics.emote = mochiPhysics.isDancing ? 'senang' : 'siaga';
      return mochiPhysics.isDancing;
    },
    getState: () => Object.freeze({ emote: mochiPhysics.emote, isDancing: mochiPhysics.isDancing, lookX: mochiPhysics.lookX, lookY: mochiPhysics.lookY })
  });
}

function drawTalkingLipSyncMouth(ctx, timeSec, phase) {
      const openAmt = 0.35 + 0.65 * Math.abs(Math.sin(phase));
      const widthAmt = 0.80 + 0.30 * Math.cos(phase * 0.65);
      const mw = 10.5 * widthAmt;
      const mh = 3.5 + 11.5 * openAmt;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(-mw, -1);
      ctx.quadraticCurveTo(0, -3.5 - openAmt * 1.5, mw, -1);
      ctx.bezierCurveTo(mw * 0.88, mh, -mw * 0.88, mh, -mw, -1);
      ctx.closePath();

      ctx.fillStyle = '#38120A';
      ctx.fill();

      ctx.save();
      ctx.clip();
      const tongueY = mh * 0.58 + Math.sin(phase * 1.3) * 1.5;
      ctx.beginPath();
      ctx.ellipse(0, tongueY, mw * 0.72, mh * 0.52, 0, 0, Math.PI * 2);
      const tGrad = ctx.createLinearGradient(0, tongueY - 4, 0, tongueY + 6);
      tGrad.addColorStop(0, '#F08268');
      tGrad.addColorStop(1, '#C44B35');
      ctx.fillStyle = tGrad;
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = '#240B06';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();
    }

function drawRealistic3DFlameEye(ctx, x, y, rx, ry, tilt, lx, ly, timeSec) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(tilt);

      ctx.shadowColor = 'rgba(90, 42, 12, 0.45)';
      ctx.shadowBlur = 6;

      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      const baseGrad = ctx.createLinearGradient(0, -ry, 0, ry);
      baseGrad.addColorStop(0, '#0D0604');
      baseGrad.addColorStop(0.46, '#261209');
      baseGrad.addColorStop(0.78, '#854210');
      baseGrad.addColorStop(1, '#F5B942');
      ctx.fillStyle = baseGrad;
      ctx.fill();

      ctx.clip();

      const gx = lx * 4.2;
      const gy = ry * 0.42 + ly * 3.4;
      const irisGrad = ctx.createRadialGradient(gx, gy, 1, gx, gy, rx * 0.85);
      irisGrad.addColorStop(0, '#FFFDF0');
      irisGrad.addColorStop(0.35, '#FFE082');
      irisGrad.addColorStop(0.70, '#D97706');
      irisGrad.addColorStop(1, 'rgba(140, 55, 6, 0)');
      ctx.fillStyle = irisGrad;
      ctx.beginPath();
      ctx.arc(gx, gy, rx * 0.85, 0, Math.PI * 2);
      ctx.fill();

      const flk = Math.sin(timeSec * 9 + x) * 1.2;
      ctx.beginPath();
      ctx.moveTo(gx - 5.2, ry);
      ctx.quadraticCurveTo(gx - 4.8, ry * 0.56, gx - 2.4, ry * 0.40);
      ctx.quadraticCurveTo(gx - 1, ry * 0.58, gx + flk * 0.5, ry * 0.16);
      ctx.quadraticCurveTo(gx + 1.4, ry * 0.58, gx + 2.8, ry * 0.40);
      ctx.quadraticCurveTo(gx + 4.8, ry * 0.56, gx + 5.2, ry);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 248, 210, 0.88)';
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.ellipse(-rx * 0.28 + lx * 2.2, -ry * 0.34 + ly * 2.0, rx * 0.29, ry * 0.24, -0.25, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(255, 252, 235, 0.92)';
      ctx.beginPath();
      ctx.arc(rx * 0.36 + lx * 1.8, ry * 0.24 + ly * 1.8, rx * 0.10, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(tilt);
      ctx.beginPath();
      ctx.arc(0, 0, rx + 0.4, Math.PI * 1.08, Math.PI * 1.92);
      ctx.strokeStyle = '#2B140A';
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    }

function drawRealisticMochiMouth(ctx, x, y, scale) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.beginPath();
      ctx.moveTo(-7.5, -1);
      ctx.quadraticCurveTo(0, -3.2, 7.5, -1);
      ctx.bezierCurveTo(6.5, 11.5, -6.5, 11.5, -7.5, -1);
      ctx.closePath();

      ctx.fillStyle = '#3D160E';
      ctx.fill();

      ctx.save();
      ctx.clip();
      ctx.beginPath();
      ctx.arc(0, 7.5, 6.2, 0, Math.PI * 2);
      ctx.fillStyle = '#DE6C52';
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = '#2B110A';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

function drawDetailedDamarEmblem(ctx, cx, cy, s) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.shadowColor = '#FFD166';
      ctx.shadowBlur = 8;
      ctx.strokeStyle = '#FFE082';
      ctx.lineWidth = Math.max(1.9, s * 0.17);
      ctx.lineCap = 'round';

      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.bezierCurveTo(s * 0.85, -s * 0.35, s * 0.75, s * 0.38, 0, s * 0.68);
      ctx.bezierCurveTo(-s * 0.45, s * 0.85, -s * 0.35, s * 1.15, s * 0.35, s * 0.98);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.bezierCurveTo(-s * 0.85, -s * 0.35, -s * 0.75, s * 0.38, -s * 0.15, s * 0.62);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, -s * 0.36);
      ctx.quadraticCurveTo(s * 0.30, s * 0.08, 0, s * 0.38);
      ctx.quadraticCurveTo(-s * 0.30, s * 0.08, 0, -s * 0.36);
      ctx.stroke();
      ctx.restore();
    }

function drawHappyArcEye(ctx, x, y, r) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x - r, y + 3);
      ctx.quadraticCurveTo(x, y - r * 1.05, x + r, y + 3);
      ctx.strokeStyle = '#24160E';
      ctx.lineWidth = 3.6;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    }

function drawCalmClosedEye(ctx, x, y, r) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x - r, y);
      ctx.quadraticCurveTo(x, y + r * 0.75, x + r, y);
      ctx.strokeStyle = '#24160E';
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    }

function drawSpiralEye(ctx, cx, cy, r, angleOffset) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angleOffset);
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 4.5; a += 0.2) {
        const rad = (a / (Math.PI * 4.5)) * r;
        const px = Math.cos(a) * rad;
        const py = Math.sin(a) * rad;
        if (a === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = '#F5B942';
      ctx.lineWidth = 2.6;
      ctx.stroke();
      ctx.restore();
    }

function drawEmoteRays(ctx, x, y, color) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (x > 0 ? 14 : -14), y - 10);
      ctx.moveTo(x, y + 12);
      ctx.lineTo(x + (x > 0 ? 16 : -16), y + 10);
      ctx.stroke();
      ctx.restore();
    }

function drawOrbStandby60fps(ctx, timeSec) {
      const r = 74;
      ctx.save();
      ctx.shadowColor = 'rgba(245, 185, 66, 0.75)';
      ctx.shadowBlur = 28;
      const orbGrad = ctx.createRadialGradient(-22, -24, 8, 0, 0, r);
      orbGrad.addColorStop(0, '#33497A');
      orbGrad.addColorStop(0.55, '#0B1226');
      orbGrad.addColorStop(0.88, '#9A5812');
      orbGrad.addColorStop(1, '#FFE082');
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = orbGrad;
      ctx.fill();
      ctx.strokeStyle = '#FFE082';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, r * 0.86, Math.PI * 1.1, Math.PI * 1.65);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.stroke();

      ctx.save();
      ctx.rotate(timeSec * 1.8);
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.88, r * 0.34, 0.5, 0, Math.PI * 1.4);
      ctx.strokeStyle = 'rgba(255, 224, 130, 0.82)';
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.restore();
      ctx.restore();

      drawDetailedDamarEmblem(ctx, 0, 2, 32);
    }

function drawMochiOutfit3D(ctx, outfit, eyeLX, eyeLY, eyeRX, eyeRY, mouthX, mouthY, timeSec) {
      ctx.save();
      const eyeCenterX = (eyeLX + eyeRX) * 0.5;
      const eyeCenterY = (eyeLY + eyeRY) * 0.5;
      const eyeAngle = Math.atan2(eyeRY - eyeLY, eyeRX - eyeLX); // ~ -0.18 rad matching 3/4 tilted head!
      const swayOsc = Math.sin(timeSec * 5.2) * 4.0;

      if (outfit === 'crown') {
        // 3D Sculpted Royal Damar Crown anchored cleanly on the forehead/crown above the eyes
        ctx.translate(eyeCenterX - 10, eyeCenterY - 68 + Math.sin(timeSec * 3.6) * 2.0);
        ctx.rotate(eyeAngle);
        ctx.shadowColor = '#FFD166';
        ctx.shadowBlur = 16;

        // Shimmering Golden Halo Ring above Crown
        ctx.beginPath();
        ctx.ellipse(0, -32, 24 + Math.sin(timeSec * 4) * 2, 5.0, 0, 0, Math.PI * 2);
        ctx.strokeStyle = '#FFF9DB';
        ctx.lineWidth = 2.2;
        ctx.stroke();

        // 3D Metallic Gold Crown Body with Beveled Facets
        const cg = ctx.createLinearGradient(-30, -28, 30, 6);
        cg.addColorStop(0, '#FFF8DC');
        cg.addColorStop(0.35, '#F5B942');
        cg.addColorStop(0.75, '#B45309');
        cg.addColorStop(1, '#FFE082');
        ctx.fillStyle = cg;
        ctx.strokeStyle = '#FFF9DB';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(-28, 6);
        ctx.lineTo(-34, -20);
        ctx.lineTo(-15, -8);
        ctx.lineTo(0, -28);
        ctx.lineTo(15, -8);
        ctx.lineTo(34, -20);
        ctx.lineTo(28, 6);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Obsidian-Navy Velvet Base Band
        ctx.fillStyle = '#0F172A';
        ctx.beginPath();
        ctx.roundRect(-29, 1, 58, 7.5, 3.5);
        ctx.fill();
        ctx.stroke();

        // Center Glowing Flame Ruby + Side Sapphire Gems
        ctx.fillStyle = '#F43F5E';
        ctx.beginPath();
        ctx.moveTo(0, -20); ctx.lineTo(5.5, -11); ctx.lineTo(0, -3); ctx.lineTo(-5.5, -11);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#38BDF8';
        ctx.beginPath();
        ctx.arc(-19, -6, 3.2, 0, Math.PI * 2);
        ctx.arc(19, -6, 3.2, 0, Math.PI * 2);
        ctx.fill();

      } else if (outfit === 'sunglasses') {
        // 3D Cyber-Damar Aviator Sunglasses anchored directly to Left & Right Eye Sockets!
        ctx.translate(eyeCenterX, eyeCenterY);
        ctx.rotate(eyeAngle);
        ctx.shadowColor = 'rgba(245, 185, 66, 0.55)';
        ctx.shadowBlur = 14;

        const dist = Math.hypot(eyeRX - eyeLX, eyeRY - eyeLY) * 0.5;
        const lg = ctx.createLinearGradient(-50, -16, 50, 16);
        lg.addColorStop(0, '#050811');
        lg.addColorStop(0.5, '#1E293B');
        lg.addColorStop(1, '#090D16');

        [[-dist, 0, 24, 18], [dist, 0, 21, 17]].forEach(([lx, ly, rw, rh]) => {
          ctx.save();
          ctx.translate(lx, ly);
          ctx.fillStyle = lg;
          ctx.strokeStyle = '#FFE082';
          ctx.lineWidth = 3.0;
          ctx.beginPath();
          ctx.roundRect(-rw, -rh, rw * 2, rh * 1.95, 9);
          ctx.fill();
          ctx.stroke();

          ctx.clip();
          const sweepX = ((timeSec * 48) % 90) - 45;
          ctx.strokeStyle = 'rgba(255, 243, 196, 0.78)';
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(sweepX - 14, -22);
          ctx.lineTo(sweepX + 10, 22);
          ctx.stroke();
          ctx.restore();
        });

        // Sculpted Gold Nose Bridge & Side Temple Arms
        ctx.strokeStyle = '#FFE082';
        ctx.lineWidth = 3.0;
        ctx.beginPath();
        ctx.moveTo(-dist + 23, -5); ctx.lineTo(dist - 20, -5);
        ctx.moveTo(-dist + 23, 0);  ctx.lineTo(dist - 20, 0);
        ctx.moveTo(-dist - 24, -4); ctx.lineTo(-dist - 36, -8);
        ctx.moveTo(dist + 21, -4);  ctx.lineTo(dist + 31, -8);
        ctx.stroke();

      } else if (outfit === 'partyHat') {
        ctx.translate(eyeCenterX - 10, eyeCenterY - 68);
        ctx.rotate(eyeAngle + Math.sin(timeSec * 4.5) * 0.05);
        ctx.shadowColor = '#F472B6';
        ctx.shadowBlur = 14;

        const pg = ctx.createLinearGradient(-24, 6, 24, -42);
        pg.addColorStop(0, '#831843');
        pg.addColorStop(0.5, '#DB2777');
        pg.addColorStop(1, '#F5B942');
        ctx.fillStyle = pg;
        ctx.strokeStyle = '#FFE082';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(-24, 8);
        ctx.lineTo(0, -40);
        ctx.lineTo(24, 8);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.strokeStyle = '#FFF3C4';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(-15, -2); ctx.lineTo(11, -13);
        ctx.moveTo(-9, -19); ctx.lineTo(6, -26);
        ctx.stroke();

        const pomX = Math.sin(timeSec * 9) * 3.8;
        const pomY = -43 + Math.abs(Math.cos(timeSec * 9)) * -3.5;
        const pomG = ctx.createRadialGradient(pomX - 2, pomY - 2, 1, pomX, pomY, 9);
        pomG.addColorStop(0, '#FFFFFF');
        pomG.addColorStop(0.6, '#FFE082');
        pomG.addColorStop(1, '#D97706');
        ctx.fillStyle = pomG;
        ctx.beginPath();
        ctx.arc(pomX, pomY, 8.5, 0, Math.PI * 2);
        ctx.fill();

      } else if (outfit === 'witchHat') {
        ctx.translate(eyeCenterX - 8, eyeCenterY - 66);
        ctx.rotate(eyeAngle);
        ctx.shadowColor = '#F5B942';
        ctx.shadowBlur = 16;

        const wg = ctx.createLinearGradient(-26, 4, 26, -44);
        wg.addColorStop(0, '#090D1A');
        wg.addColorStop(0.55, '#1E1B4B');
        wg.addColorStop(1, '#312E81');
        ctx.fillStyle = wg;
        ctx.strokeStyle = '#FFE082';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(-26, 4);
        ctx.quadraticCurveTo(-8, -38, 28, -40 + swayOsc * 0.5);
        ctx.quadraticCurveTo(15, -18, 26, 4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#D97706';
        ctx.beginPath();
        ctx.roundRect(-26, -3, 52, 7.5, 3);
        ctx.fill();
        ctx.strokeStyle = '#FFF3C4';
        ctx.strokeRect(-6, -4, 12, 9);

        ctx.fillStyle = wg;
        ctx.beginPath();
        ctx.ellipse(0, 5, 44, 10, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#FFE082';
        ctx.stroke();

        const pendX = 28 + Math.sin(timeSec * 6) * 5.5;
        const pendY = -24 + Math.cos(timeSec * 6) * 2;
        ctx.beginPath();
        ctx.moveTo(27, -38 + swayOsc * 0.5);
        ctx.lineTo(pendX, pendY);
        ctx.strokeStyle = '#FFE082';
        ctx.lineWidth = 1.6;
        ctx.stroke();
        drawVectorParticle(ctx, { kind: 'star', x: pendX, y: pendY, rot: timeSec * 2, scale: 0.78, life: 1.0 });

      } else if (outfit === 'santaHat') {
        ctx.translate(eyeCenterX - 8, eyeCenterY - 66);
        ctx.rotate(eyeAngle);
        const sg = ctx.createLinearGradient(-26, 4, 28, -36);
        sg.addColorStop(0, '#991B1B');
        sg.addColorStop(0.6, '#DC2626');
        sg.addColorStop(1, '#F87171');
        ctx.fillStyle = sg;
        ctx.strokeStyle = '#FFE082';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(-26, 4);
        ctx.bezierCurveTo(-10, -40, 22, -36, 34, -8 + swayOsc * 0.6);
        ctx.lineTo(24, 4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        const fg = ctx.createLinearGradient(0, -2, 0, 10);
        fg.addColorStop(0, '#FFFFFF');
        fg.addColorStop(1, '#CBD5E1');
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.roundRect(-29, -1, 58, 11.5, 5.5);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(34 + swayOsc * 0.6, -6 + swayOsc * 0.5, 9.0, 0, Math.PI * 2);
        ctx.fill();

      } else if (outfit === 'scarf') {
        ctx.translate(mouthX - 10, mouthY + 26);
        ctx.rotate(eyeAngle * 0.5);
        const scG = ctx.createLinearGradient(-46, 0, 46, 18);
        scG.addColorStop(0, '#7C2D12');
        scG.addColorStop(0.5, '#D97706');
        scG.addColorStop(1, '#F5B942');
        ctx.fillStyle = scG;
        ctx.strokeStyle = '#FFE082';
        ctx.lineWidth = 2.4;

        ctx.beginPath();
        ctx.roundRect(-42, 0, 84, 16, 8);
        ctx.fill();
        ctx.stroke();

        ctx.save();
        ctx.translate(20, 10);
        ctx.rotate(Math.sin(timeSec * 4.8) * 0.16 - 0.08);
        ctx.beginPath();
        ctx.roundRect(-8, 0, 18, 36, 6);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = '#FFF3C4';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-5, 36); ctx.lineTo(-6, 44);
        ctx.moveTo(1, 36);  ctx.lineTo(1, 45);
        ctx.moveTo(7, 36);  ctx.lineTo(8, 44);
        ctx.stroke();
        ctx.restore();

      } else if (outfit === 'headphones') {
        ctx.translate(eyeCenterX - 4, eyeCenterY + 2);
        ctx.rotate(eyeAngle);
        ctx.shadowColor = '#F5B942';
        ctx.shadowBlur = 14;

        ctx.strokeStyle = '#FFE082';
        ctx.lineWidth = 5.5;
        ctx.beginPath();
        ctx.arc(0, -6, 68, Math.PI * 1.06, Math.PI * 1.94);
        ctx.stroke();

        [[-66, 6], [66, 6]].forEach(([ex, ey], idx) => {
          ctx.save();
          ctx.translate(ex, ey);
          ctx.fillStyle = '#0F172A';
          ctx.strokeStyle = '#FFE082';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.roundRect(-9, -18, 18, 36, 8);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#F5B942';
          for (let b = -1; b <= 1; b++) {
            const bh = 4 + Math.abs(Math.sin(timeSec * 10 + b * 1.5 + idx)) * 10;
            ctx.fillRect(b * 4 - 1.2, -bh * 0.5, 2.4, bh);
          }
          ctx.restore();
        });
      }
      ctx.restore();
    }

function drawPlayfulDamarSpiritOrb(ctx, ox, oy, timeSec) {
      ctx.save();
      ctx.translate(ox, oy);
      for (let t = 1; t <= 3; t++) {
        ctx.beginPath();
        ctx.arc(-Math.cos(timeSec * 3.4) * t * 8, Math.sin(timeSec * 6.8) * t * 4 + t * 3, Math.max(1.2, 4.5 - t), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 224, 130, ${0.55 - t * 0.14})`;
        ctx.fill();
      }
      ctx.shadowColor = '#FFD166';
      ctx.shadowBlur = 16;
      const og = ctx.createRadialGradient(-4, -4, 1, 0, 0, 14);
      og.addColorStop(0, '#FFFDF5');
      og.addColorStop(0.45, '#FFE082');
      og.addColorStop(0.85, '#D97706');
      og.addColorStop(1, 'rgba(217, 119, 6, 0)');
      ctx.fillStyle = og;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.fill();

      ctx.rotate(timeSec * 3.5);
      ctx.strokeStyle = '#FFF8DC';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(0, 0, 11, 4.5, 0.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

function drawGlowingFireflyProp(ctx, fx, fy, timeSec) {
      ctx.save();
      ctx.translate(fx, fy);
      const wingFlap = Math.sin(timeSec * 38) * 0.5;
      ctx.shadowColor = '#FFE082';
      ctx.shadowBlur = 14;
      ctx.fillStyle = 'rgba(255, 245, 200, 0.75)';
      ctx.save();
      ctx.rotate(-0.5 + wingFlap);
      ctx.beginPath();
      ctx.ellipse(-6, -2, 6, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.rotate(0.5 - wingFlap);
      ctx.beginPath();
      ctx.ellipse(6, -2, 6, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#FFFDF2';
      ctx.beginPath();
      ctx.arc(0, 0, 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

function drawCohesiveDamarFilePortal(ctx, timeSec, remTimer) {
      const progress = 1.0 - Math.min(1.0, remTimer / 2.4);
      ctx.save();
      const portalX = 8;
      const portalY = 44;

      ctx.save();
      ctx.translate(portalX, portalY);
      const portalRadius = 34 * Math.sin(Math.min(1, progress * 2.2) * (Math.PI * 0.5)) * (remTimer < 0.4 ? remTimer / 0.4 : 1);
      ctx.shadowColor = '#FFD166';
      ctx.shadowBlur = 22;

      const pg = ctx.createRadialGradient(0, 0, 2, 0, 0, Math.max(4, portalRadius));
      pg.addColorStop(0, '#FFFDF5');
      pg.addColorStop(0.35, 'rgba(255, 224, 130, 0.88)');
      pg.addColorStop(0.75, 'rgba(24, 36, 68, 0.90)');
      pg.addColorStop(1, 'rgba(245, 185, 66, 0)');
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(4, portalRadius), 0, Math.PI * 2);
      ctx.fill();

      ctx.rotate(timeSec * 4.5);
      ctx.strokeStyle = '#FFE082';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.ellipse(0, 0, Math.max(2, portalRadius * 0.92), Math.max(1, portalRadius * 0.42), 0.35, 0, Math.PI * 1.65);
      ctx.stroke();

      ctx.rotate(-timeSec * 8.0);
      ctx.strokeStyle = '#F5B942';
      ctx.beginPath();
      ctx.ellipse(0, 0, Math.max(2, portalRadius * 0.72), Math.max(1, portalRadius * 0.32), -0.4, 0, Math.PI * 1.5);
      ctx.stroke();

      drawDetailedDamarEmblem(ctx, 0, 0, Math.max(3, portalRadius * 0.45));
      ctx.restore();

      if (progress < 0.78) {
        const t = progress / 0.78;
        const docX = portalX + Math.sin(t * Math.PI * 2) * (1 - t) * 24;
        const docY = -85 * (1 - t) + portalY * t;
        const docScale = (1 - t * 0.68);
        ctx.save();
        ctx.translate(docX, docY);
        ctx.rotate((1 - t) * 0.35);
        ctx.scale(docScale, docScale);
        ctx.shadowColor = '#FFE082';
        ctx.shadowBlur = 16;

        const dg = ctx.createLinearGradient(-20, -26, 20, 26);
        dg.addColorStop(0, '#1E2C52');
        dg.addColorStop(1, '#0B1224');
        ctx.fillStyle = dg;
        ctx.strokeStyle = '#FFE082';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.roundRect(-20, -26, 40, 52, 7);
        ctx.fill();
        ctx.stroke();

        ctx.strokeStyle = '#F5B942';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(-11, -12); ctx.lineTo(11, -12);
        ctx.moveTo(-11, -2);  ctx.lineTo(11, -2);
        ctx.moveTo(-11, 8);   ctx.lineTo(5, 8);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    }

const mochiPhysics = {
      emote: 'senang',        // 'senang' | 'berpikir' | 'siaga' | 'pulih' | 'orbStandby'
      outfit: 'none',         // 'none' | 'crown' | 'sunglasses' | 'partyHat' | 'witchHat' | 'santaHat' | 'scarf' | 'headphones'
      idlePlayIdx: 0,
      idlePlayTimer: 0,
      userInteractingCursor: false,
      lastCursorMoveMs: 0,
      lookX: 0,
      lookY: 0,
      targetLookX: 0,
      targetLookY: 0,
      bodyX: 0,
      bodyY: 0,
      headTilt: 0,
      scaleX: 1,
      scaleY: 1,
      velScaleX: 0,
      velScaleY: 0,
      jumpY: 0,
      velJumpY: 0,
      waveTimer: 2.6,
      talkTimer: 0,           // > 0 when speaking (lip-sync active!)
      talkVowelPhase: 0,
      annoyedTimer: 0,
      dizzyTimer: 0,
      heartsTimer: 0,
      boxTimer: 0,            // > 0 when absorbing a dropped file into the DAMAR Spirit Portal!
      droppedFileLabel: 'Papan_Konsep_Damar.pdf',
      isDancing: false,
      isHoveringStage: false,
      hoverDuration: 0,
      clickTimes: [],
      particles: [],          // kind: 'heart' | 'note' | 'spark' | 'star'
      embers: Array.from({ length: 28 }, (_, i) => ({
        angle: (i / 28) * Math.PI * 2,
        radius: 35 + (i % 7) * 16,
        y: -110 + (i % 9) * 28,
        speed: 0.45 + (i % 5) * 0.2,
        size: 1.3 + (i % 3) * 0.9,
        phase: i * 0.7
      }))
    };
// Sprite loader: memakai aset PNG asli yang disetujui Owner (bukan data URI).
const preloadedSprites = {};
['heroRig'].forEach(key => {
  const map = { heroRig: '/__preview-adapters/argon-assets/visuals/mochi_damar_hero_rig.png' };
  const img = new Image();
  img.addEventListener('load', () => window.dispatchEvent(new Event('damar-character-renderer-ready')));
  img.addEventListener('error', () => window.dispatchEvent(new Event('damar-character-renderer-unavailable')));
  img.src = map[key];
  preloadedSprites[key] = img;
});

const IDLE_ACTIVITIES = [
      { id: 'juggleOrb', label: 'Idle Aktif: Bermain Bola Api Damar' },
      { id: 'curiousPeek', label: 'Idle Aktif: Melongok Penasaran Kiri-Kanan' },
      { id: 'fireflyChase', label: 'Idle Aktif: Mengejar Kunang-Kunang Cahaya' },
      { id: 'happyWiggle', label: 'Idle Aktif: Senandung Goyang Gembira' }
    ];

    // =========================================================================
    // ARTICULATED 60FPS MOCHI DAMAR ENGINE
    // - Lively Autonomous Idle Play Choreography (visible in Notch & Stage)
    // - Real-Time Lip-Sync Speech Animation (Vowel A-I-U-E-O mouth shapes)
    // - Cohesive Mochi Damar File-Drop Spirit Portal Absorption
    // - Rich 3D Shaded Costumes with Secondary Physics
    // - Zero Emoji Vector Particles (3D hearts, stars, music notes, sparks)
    // =========================================================================

function drawMochiDamar60fps(ctx, w, h, timeSec, isCompactNotch) {
      ctx.clearRect(0, 0, w, h);
      const scale = isCompactNotch ? (Math.min(w, h) / 215) : (Math.min(w, h) / 310);
      ctx.save();
      ctx.translate(w * 0.5, isCompactNotch ? h * 0.60 : h * 0.54);
      ctx.scale(scale, scale);

      const danceBounce = mochiPhysics.isDancing ? Math.abs(Math.sin(timeSec * 8.5)) * -16 : 0;
      const danceTilt = mochiPhysics.isDancing ? Math.sin(timeSec * 4.25) * 0.15 : 0;
      const breathY = Math.sin(timeSec * 3.2) * 6.5;
      const breathScale = 1 + Math.sin(timeSec * 3.2) * 0.024;
      const talkScaleY = mochiPhysics.talkTimer > 0 ? (1 + Math.sin(timeSec * 22) * 0.025) : 1;

      if (!isCompactNotch) {
        const bgAura = ctx.createRadialGradient(0, -10, 12, 0, -10, 145);
        bgAura.addColorStop(0, 'rgba(255, 215, 110, 0.25)');
        bgAura.addColorStop(0.55, 'rgba(245, 165, 45, 0.09)');
        bgAura.addColorStop(1, 'rgba(11, 16, 33, 0)');
        ctx.fillStyle = bgAura;
        ctx.beginPath();
        ctx.arc(0, -10, 145, 0, Math.PI * 2);
        ctx.fill();

        for (const emb of mochiPhysics.embers) {
          const ey = ((emb.y - timeSec * 18 * emb.speed + 140) % 260) - 130;
          const ex = Math.sin(timeSec * emb.speed + emb.phase) * emb.radius * 1.15;
          const alpha = (0.35 + 0.65 * Math.sin(timeSec * 3.5 + emb.phase)) * (1 - Math.abs(ey) / 135);
          if (alpha > 0.05) {
            ctx.save();
            ctx.fillStyle = `rgba(255, 228, 140, ${alpha.toFixed(2)})`;
            ctx.shadowColor = '#FFD166';
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.arc(ex, ey, emb.size, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
}

        }
      }

      if (!isCompactNotch) {
        ctx.save();
        ctx.translate(mochiPhysics.bodyX * 0.35, 114);
        const pedGlow = ctx.createRadialGradient(0, 0, 4, 0, 0, 88);
        pedGlow.addColorStop(0, 'rgba(255, 232, 150, 0.55)');
        pedGlow.addColorStop(0.5, 'rgba(245, 185, 66, 0.20)');
        pedGlow.addColorStop(1, 'rgba(245, 185, 66, 0)');
        ctx.fillStyle = pedGlow;
        ctx.beginPath();
        ctx.ellipse(0, 0, 88 * breathScale, 18, 0, 0, Math.PI * 2);
        ctx.fill();

        const rings = [
          { rx: 46, ry: 7.5, w: 2.8, a: 0.95 },
          { rx: 66, ry: 11.0, w: 2.0, a: 0.72 },
          { rx: 82, ry: 14.2, w: 1.2, a: 0.40 }
        ];
        rings.forEach((rg, idx) => {
          ctx.beginPath();
          ctx.ellipse(0, idx * 1.5, rg.rx * breathScale, rg.ry, 0, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255, 220, 120, ${rg.a})`;
          ctx.lineWidth = rg.w;
          ctx.stroke();
        });
        ctx.restore();
      }

      ctx.translate(mochiPhysics.bodyX, breathY + mochiPhysics.bodyY + mochiPhysics.jumpY + danceBounce);
      ctx.rotate(danceTilt + mochiPhysics.headTilt);
      ctx.scale(mochiPhysics.scaleX * breathScale, mochiPhysics.scaleY * breathScale * talkScaleY);

      if (mochiPhysics.emote === 'orbStandby') {
        drawOrbStandby60fps(ctx, timeSec);
        ctx.restore();
        return;
      }

      if (mochiPhysics.talkTimer > 0) {
        ctx.save();
        for (let wIdx = 0; wIdx < 2; wIdx++) {
          const prog = ((timeSec * 2.4 + wIdx * 0.5) % 1.0);
          const rad = 75 + prog * 55;
          ctx.beginPath();
          ctx.arc(0, -15, rad, -Math.PI * 0.35, Math.PI * 0.35);
          ctx.strokeStyle = `rgba(255, 224, 130, ${(1 - prog) * 0.65})`;
          ctx.lineWidth = 2.6;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(0, -15, rad, Math.PI * 0.65, Math.PI * 1.35);
          ctx.stroke();
        }
        ctx.restore();
      }

      const rigImg = preloadedSprites.heroRig;
      if (rigImg && rigImg.complete && rigImg.naturalWidth > 0) {
        const px = mochiPhysics.lookX * 9.5;
        const py = mochiPhysics.lookY * 6.5;
        const drawW = 224;
        const drawH = 296.8;
        const x0 = -drawW * 0.50 - 6;
        const y0 = -drawH * 0.50 - 36;

        ctx.save();
        ctx.translate(px * 0.55, py * 0.45);
        ctx.rotate(mochiPhysics.lookX * 0.045);

        // Smooth continuous 2.5D elastic shear + breathing transform (100% crisp anti-aliased golden lines, zero stair-stepping!)
        const shearX = Math.sin(timeSec * 4.2) * 0.045 + mochiPhysics.lookX * 0.055;
        const shearY = Math.cos(timeSec * 3.6) * 0.022;
        ctx.save();
        ctx.transform(1, shearY, shearX, 1, 0, 0);
        ctx.drawImage(rigImg, x0, y0, drawW, drawH);
        ctx.restore();

        const scaleRig = drawW / 320.0;
        const eyeLX = x0 + 153.0 * scaleRig + px * 0.38;
        const eyeLY = y0 + 224.0 * scaleRig + py * 0.38;
        const eyeRX = x0 + 256.5 * scaleRig + px * 0.38;
        const eyeRY = y0 + 205.0 * scaleRig + py * 0.38;
        const mouthX = x0 + 214.0 * scaleRig + px * 0.38;
        const mouthY = y0 + 230.5 * scaleRig + py * 0.38;

        const blinkCycle = timeSec % 3.4;
        const isBlinking = blinkCycle < 0.14;

        if (mochiPhysics.dizzyTimer > 0) {
          drawSpiralEye(ctx, eyeLX, eyeLY, 17.5, timeSec * 10);
          drawSpiralEye(ctx, eyeRX, eyeRY, 15.0, -timeSec * 10);
          ctx.beginPath();
          ctx.arc(mouthX, mouthY, 6.0, 0, Math.PI * 2);
          ctx.strokeStyle = '#3D160E';
          ctx.lineWidth = 2.6;
          ctx.stroke();
          for (let s = 0; s < 3; s++) {
            const ang = timeSec * 4.8 + (s * Math.PI * 2) / 3;
            drawVectorParticle(ctx, { kind: 'star', x: Math.cos(ang) * 68, y: -118 + Math.sin(ang) * 15, rot: timeSec * 3, scale: 1.0, life: 1.0 });
          }
        } else if (mochiPhysics.emote === 'pulih' && mochiPhysics.annoyedTimer <= 0 && mochiPhysics.talkTimer <= 0 && mochiPhysics.boxTimer <= 0) {
          drawCalmClosedEye(ctx, eyeLX, eyeLY, 16.5);
          drawCalmClosedEye(ctx, eyeRX, eyeRY, 14.5);
          ctx.beginPath();
          ctx.arc(mouthX, mouthY - 2, 6.0, 0.1 * Math.PI, 0.9 * Math.PI);
          ctx.strokeStyle = '#3D160E';
          ctx.lineWidth = 2.5;
          ctx.stroke();
          ctx.save();
          ctx.shadowColor = '#FFD166';
          ctx.shadowBlur = 14;
          ctx.beginPath();
          ctx.ellipse(6, 26, 94, 24, Math.sin(timeSec * 2) * 0.12, 0, Math.PI * 2);
          ctx.strokeStyle = '#FFE082';
          ctx.lineWidth = 3.2;
          ctx.stroke();
          drawVectorParticle(ctx, { kind: 'spark', x: 78, y: -54 + Math.sin(timeSec * 4) * 5, rot: 0, scale: 1.1, life: 1.0 });
          drawVectorParticle(ctx, { kind: 'spark', x: 96, y: -32 + Math.cos(timeSec * 4) * 4, rot: 0, scale: 0.75, life: 1.0 });
          ctx.restore();
        } else {
          if (isBlinking) {
            drawHappyArcEye(ctx, eyeLX, eyeLY, 16.5);
            drawHappyArcEye(ctx, eyeRX, eyeRY, 14.5);
          } else {
            drawRealistic3DFlameEye(ctx, eyeLX, eyeLY, 19.8, 18.5, -0.10, mochiPhysics.lookX, mochiPhysics.lookY, timeSec);
            drawRealistic3DFlameEye(ctx, eyeRX, eyeRY, 16.2, 17.5, -0.12, mochiPhysics.lookX, mochiPhysics.lookY, timeSec);
          }

          if (mochiPhysics.talkTimer > 0) {
            ctx.save();
            ctx.translate(mouthX, mouthY - 2);
            ctx.rotate(-0.11);
            drawTalkingLipSyncMouth(ctx, timeSec, mochiPhysics.talkVowelPhase);
            ctx.restore();
          } else if (mochiPhysics.boxTimer > 0) {
            ctx.save();
            ctx.translate(mouthX, mouthY - 2);
            ctx.rotate(-0.11);
            drawRealisticMochiMouth(ctx, 0, 0, 1.48);
            ctx.restore();
          } else if (mochiPhysics.emote === 'siaga' || mochiPhysics.annoyedTimer > 0) {
            ctx.strokeStyle = '#2B140A';
            ctx.lineWidth = 3.8;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(eyeLX - 14, eyeLY - 19);
            ctx.lineTo(eyeLX + 12, eyeLY - 12);
            ctx.moveTo(eyeRX + 12, eyeRY - 19);
            ctx.lineTo(eyeRX - 11, eyeRY - 11);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(mouthX - 7, mouthY + 2);
            ctx.quadraticCurveTo(mouthX - 3.5, mouthY + 6, mouthX, mouthY + 2);
            ctx.quadraticCurveTo(mouthX + 3.5, mouthY + 6, mouthX + 7, mouthY + 2);
            ctx.strokeStyle = '#3D160E';
            ctx.lineWidth = 2.5;
            ctx.stroke();
            drawEmoteRays(ctx, 88, -48, '#F5B942');
          } else if (mochiPhysics.emote === 'berpikir') {
            ctx.beginPath();
            ctx.arc(mouthX, mouthY + 2, 4.2, 0, Math.PI * 2);
            ctx.fillStyle = '#3D160E';
            ctx.fill();
            ctx.save();
            ctx.shadowColor = '#F5B942';
            ctx.shadowBlur = 12;
            ctx.fillStyle = '#FFE082';
            ctx.font = 'bold 36px Georgia, serif';
            ctx.fillText('?', 76, -48 + Math.sin(timeSec * 4.5) * 6);
            ctx.restore();
          } else {
            ctx.save();
            ctx.translate(mouthX, mouthY - 3);
            ctx.rotate(-0.11);
            drawRealisticMochiMouth(ctx, 0, 0, 1.32);
            ctx.restore();
            if (mochiPhysics.emote === 'senang') {
              drawEmoteRays(ctx, -84, -54, '#FFE082');
            }
          }
        }

        if (mochiPhysics.boxTimer > 0) {
          drawCohesiveDamarFilePortal(ctx, timeSec, mochiPhysics.boxTimer);
        } else if (mochiPhysics.talkTimer <= 0) {
          const playId = IDLE_ACTIVITIES[mochiPhysics.idlePlayIdx].id;
          if (playId === 'juggleOrb' && mochiPhysics.emote !== 'pulih') {
            const orbPhase = timeSec * 3.4;
            const ox = Math.sin(orbPhase) * 64;
            const oy = 52 - Math.abs(Math.cos(orbPhase)) * 42;
            drawPlayfulDamarSpiritOrb(ctx, ox, oy, timeSec);
          } else if (playId === 'fireflyChase' && mochiPhysics.emote !== 'pulih') {
            const fx = Math.sin(timeSec * 3.2) * 66;
            const fy = -18 + Math.sin(timeSec * 6.4) * 24;
            drawGlowingFireflyProp(ctx, fx, fy, timeSec);
          }
        }

        if (mochiPhysics.outfit !== 'none') {
          drawMochiOutfit3D(ctx, mochiPhysics.outfit, eyeLX, eyeLY, eyeRX, eyeRY, mouthX, mouthY, timeSec);
        }
        ctx.restore();

        for (const p of mochiPhysics.particles) {
          drawVectorParticle(ctx, p);
        }
        ctx.restore();
        return;
      }

      ctx.restore();
    }
