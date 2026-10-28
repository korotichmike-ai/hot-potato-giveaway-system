// Hot Potato Arena: the overlay animation (1920x1080 canvas, transparent background for OBS).
// The animation is cosmetic: the winner and the elimination order come from the server's draw.
// The potato steers toward the next ball in that order; subs it brushes past get a luck save.
import { buildSchedule, CARD_DELAY } from './pacing.js';

const W = 1920, H = 1080;
const A = { x: 90, y: 150, w: 1740, h: 820 };
const CARD_SECONDS = 8;
const EMOJI = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
const DISPLAY = 'Bungee, "Arial Black", Impact, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const BODY = 'Figtree, system-ui, sans-serif';

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = a => a[Math.floor(Math.random() * a.length)];
const backOut = t => { const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const short = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
const hashHue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = name => {
  const parts = String(name).replace(/[^A-Za-z0-9]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().split(/\s+/);
  return ((parts[0] || '?')[0] + ((parts[1] || '')[0] || '')).toUpperCase();
};

function makeSprite(e, r, img) {
  const pad = r * 0.45, s = Math.ceil(r * 2 + pad * 2), c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d'), m = s / 2;
  g.save();
  g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); g.clip();
  if (img) {
    g.drawImage(img, m - r, m - r, r * 2, r * 2);
  } else {
    const grad = g.createRadialGradient(m - r * .35, m - r * .4, r * .1, m, m, r);
    grad.addColorStop(0, `hsl(${e.hue} 75% 66%)`);
    grad.addColorStop(1, `hsl(${e.hue} 60% 34%)`);
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
    g.fillStyle = 'rgba(255,255,255,.95)';
    g.font = `700 ${Math.round(r * .78)}px ${BODY}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(e.initials, m, m + r * .05);
  }
  g.restore();
  if (e.isSub) {
    const lw = Math.max(3, r * .13);
    g.lineWidth = lw; g.strokeStyle = '#f3c14b'; g.shadowColor = 'rgba(243,193,75,.9)'; g.shadowBlur = r * .35;
    g.beginPath(); g.arc(m, m, r - lw / 2 + 1, 0, Math.PI * 2); g.stroke();
    g.shadowBlur = 0;
    g.font = `${Math.round(r * .55)}px ${EMOJI}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('🍀', m + r * .72, m - r * .72);
  } else {
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.35)';
    g.beginPath(); g.arc(m, m, r - 1, 0, Math.PI * 2); g.stroke();
  }
  return c;
}

const imageCache = new Map();
function loadAvatar(url) {
  if (!url) return Promise.resolve(null);
  if (!imageCache.has(url)) {
    imageCache.set(url, new Promise(res => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = url;
      setTimeout(() => res(null), 2500);
    }));
  }
  return imageCache.get(url);
}

export function createArena(canvas, { potato = '🥔', backdrop = false, now = () => Date.now(), reducedMotion = false } = {}) {
  const ctx = canvas.getContext('2d');
  canvas.width = W; canvas.height = H;
  let S = null;          // current round
  let banner = null;     // { kind: 'entries'|'locked', count, closesAt, subWeight }
  let skin = potato;

  /* ---------- round setup ---------- */
  async function play(round) {
    const n = round.entrants.length;
    const sched = buildSchedule(n, { short: !!round.short });
    const r = clamp(Math.sqrt(A.w * A.h * 0.28 / (Math.max(n, 1) * Math.PI)), 26, 62);
    const imgs = await Promise.all(round.entrants.map(e => loadAvatar(e.avatarUrl)));
    const balls = [], byId = new Map();
    const cx = A.x + A.w / 2, cy = A.y + A.h / 2;
    round.entrants.forEach((src, i) => {
      const e = { ...src, name: src.username, hue: hashHue(src.id), initials: initials(src.username) };
      let x, y, ok = false;
      for (let tries = 0; tries < 80 && !ok; tries++) {
        x = rnd(A.x + r, A.x + A.w - r); y = rnd(A.y + r, A.y + A.h - r);
        ok = Math.hypot(x - cx, y - cy) > 170 && balls.every(b => Math.hypot(b.x - x, b.y - y) > b.r + r + 4);
      }
      const ang = rnd(0, Math.PI * 2), sp = rnd(60, 160);
      const b = { e, x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r, alive: true, doomed: false, saveCd: 0, popT: -1, spawn: rnd(0, round.short ? 0.4 : 0.9), sprite: makeSprite(e, r, imgs[i]), img: imgs[i] };
      balls.push(b); byId.set(String(e.id), b);
    });
    let k = 0;
    for (const h of sched.hits) { h.victims = round.eliminationOrder.slice(k, k + h.count).map(id => byId.get(String(id))); k += h.count; }
    const subs = round.entrants.filter(e => e.isSub).length;
    S = {
      round, n, sched, balls, r, subs,
      winner: byId.get(String(round.winnerId)),
      potato: { x: cx, y: cy, vx: 0, vy: 0, r: clamp(r * 0.95, 34, 54), spin: 0, trail: [] },
      t: 0, hitIdx: 0, alive: n, phase: 'run', winT: 0, saves: 0,
      queue: [], fx: [], parts: [], shake: 0, lastSave: -9, cardSprite: null,
    };
    // Joining mid-round (overlay reloaded): simulate silently up to the current moment.
    const offset = Math.max(0, (round.offsetMs || 0) / 1000);
    for (let t = 0; t < offset && S.phase !== 'gone'; t += 1 / 60) update(1 / 60, true);
  }

  function burst(x, y, color, count, speed = 520) {
    for (let i = 0; i < count; i++) {
      const a = rnd(0, Math.PI * 2), s = rnd(speed * .3, speed);
      S.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(.35, .7), age: 0, size: rnd(4, 9), color, g: 400 });
    }
  }

  function pop(b, kind) {
    if (!b || !b.alive) return;
    b.alive = false; b.popT = S.t; S.alive--;
    burst(b.x, b.y, `hsl(${b.e.hue} 85% 62%)`, kind === 'fast' ? 14 : 24);
    burst(b.x, b.y, '#ffd08a', 6, 300);
    S.fx.push({ type: 'name', text: b.e.name, x: b.x, y: b.y - b.r, t0: S.t });
    S.fx.push({ type: 'ring', x: b.x, y: b.y, r: b.r, t0: S.t });
    S.shake = Math.max(S.shake, kind === 'final' ? 22 : kind === 'late' ? 10 : 5);
  }

  function kill(hit) {
    const [first, ...rest] = hit.victims;
    pop(first, hit.kind);
    const P = S.potato;
    if (first) {
      const d = Math.hypot(P.x - first.x, P.y - first.y) || 1;
      const nx = (P.x - first.x) / d, ny = (P.y - first.y) / d, vn = P.vx * nx + P.vy * ny;
      if (vn < 0) { P.vx -= 1.6 * vn * nx; P.vy -= 1.6 * vn * ny; }
    }
    let prev = first;
    rest.forEach((b, i) => { if (!b) return; b.doomed = true; S.queue.push({ b, from: prev || b, at: S.t + 0.08 * (i + 1), kind: hit.kind }); prev = b; });
    S.hitIdx++;
    if (hit.kind === 'final') startWin();
  }

  function startWin() {
    S.phase = 'win'; S.winT = S.t;
    S.fx.push({ type: 'boom', x: S.potato.x, y: S.potato.y, t0: S.t });
    burst(S.potato.x, S.potato.y, '#ff8a3d', 30, 700);
    S.confettiAt = S.t + 0.25;
  }

  function confetti(x, y) {
    const cols = ['#f3c14b', '#ff8a3d', '#5fd47a', '#6ec6ff', '#ff6fa8', '#ffffff'];
    for (let i = 0; i < 220; i++) {
      const a = rnd(-Math.PI, 0), s = rnd(400, 1300);
      S.parts.push({ x, y, vx: Math.cos(a) * s * 1.2, vy: Math.sin(a) * s, life: rnd(1.6, 3), age: 0, size: rnd(8, 16), color: pick(cols), g: 900, conf: true, rot: rnd(0, 6), vr: rnd(-12, 12) });
    }
  }

  /* ---------- simulation ---------- */
  function update(dt, silent = false) {
    if (!S || S.phase === 'gone') return;
    S.t += dt;
    const sc = S.sched, P = S.potato, t = S.t;
    const hit = sc.hits[S.hitIdx];
    const finalChase = S.phase === 'run' && hit && hit.kind === 'final';
    const sdt = dt * (finalChase ? 0.6 : 1);

    if (S.phase === 'run' && S.n === 1 && t >= 0.6) startWin();
    if (S.confettiAt && t >= S.confettiAt) { S.confettiAt = 0; if (!silent && S.winner) confetti(S.winner.x, S.winner.y); }
    if (S.phase === 'win' && t - S.winT > (S.n === 1 ? 0.3 : CARD_DELAY) + CARD_SECONDS + 0.5) { S.phase = 'gone'; return; }

    for (let i = S.queue.length - 1; i >= 0; i--) {
      const q = S.queue[i];
      if (t >= q.at) {
        S.fx.push({ type: 'arc', x1: q.from.x, y1: q.from.y, x2: q.b.x, y2: q.b.y, t0: t });
        pop(q.b, q.kind); S.queue.splice(i, 1);
      }
    }

    const speedGoal = S.n > 60 ? 110 : 150;
    for (const b of S.balls) {
      if (!b.alive) continue;
      if (S.phase === 'win' && b === S.winner) {
        b.x += (A.x + A.w / 2 - b.x) * Math.min(1, 2.5 * dt);
        b.y += (A.y + A.h / 2 - b.y) * Math.min(1, 2.5 * dt);
        continue;
      }
      if (t < b.spawn) continue;
      b.saveCd -= dt;
      b.vx += rnd(-1, 1) * 60 * sdt; b.vy += rnd(-1, 1) * 60 * sdt;
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const f = 1 + (speedGoal / sp - 1) * Math.min(1, 1.2 * sdt);
      b.vx *= f; b.vy *= f;
      b.x += b.vx * sdt; b.y += b.vy * sdt;
      if (b.x < A.x + b.r) { b.x = A.x + b.r; b.vx = Math.abs(b.vx); }
      if (b.x > A.x + A.w - b.r) { b.x = A.x + A.w - b.r; b.vx = -Math.abs(b.vx); }
      if (b.y < A.y + b.r) { b.y = A.y + b.r; b.vy = Math.abs(b.vy); }
      if (b.y > A.y + A.h - b.r) { b.y = A.y + A.h - b.r; b.vy = -Math.abs(b.vy); }
    }
    const live = S.balls.filter(b => b.alive && t >= b.spawn && !(S.phase === 'win' && b === S.winner));
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r, d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr || d2 === 0) continue;
      const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, ov = (rr - d) / 2;
      a.x -= nx * ov; a.y -= ny * ov; b.x += nx * ov; b.y += ny * ov;
      const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rv < 0) { a.vx += rv * nx; a.vy += rv * ny; b.vx -= rv * nx; b.vy -= rv * ny; }
    }

    P.spin += sdt * (finalChase ? 3 : 8);
    if (S.phase === 'run' && hit) {
      if (t < sc.intro) {
        P.x = A.x + A.w / 2; P.y = A.y + A.h / 2;
      } else {
        if (!P.launched) { const a = rnd(0, Math.PI * 2); P.vx = Math.cos(a) * 500; P.vy = Math.sin(a) * 500; P.launched = true; }
        const tgt = hit.victims[0];
        if (!tgt) { kill(hit); return; }
        const timeLeft = hit.t - t, armed = timeLeft < 0.25;
        const dx = tgt.x - P.x, dy = tgt.y - P.y, dist = Math.hypot(dx, dy) || 1;
        const base = hit.kind === 'fast' ? 640 : hit.kind === 'late' ? 520 : 330;
        let dvx, dvy, steer;
        if (timeLeft <= dist / base * 1.25 + 0.12) {
          const cap = timeLeft < -0.3 ? base * 6 : base * 3.5;
          const spd = Math.min(cap, Math.max(base, dist / Math.max(timeLeft, 0.06)));
          dvx = dx / dist * spd; dvy = dy / dist * spd; steer = timeLeft < -0.3 ? 16 : 7;
        } else {
          const v = Math.hypot(P.vx, P.vy) || 1;
          dvx = P.vx / v * base + dx / dist * base * 0.3; dvy = P.vy / v * base + dy / dist * base * 0.3; steer = 2;
        }
        const k = Math.min(1, steer * sdt);
        P.vx += (dvx - P.vx) * k; P.vy += (dvy - P.vy) * k;
        P.x += P.vx * sdt; P.y += P.vy * sdt;
        if (P.x < A.x + P.r) { P.x = A.x + P.r; P.vx = Math.abs(P.vx); }
        if (P.x > A.x + A.w - P.r) { P.x = A.x + A.w - P.r; P.vx = -Math.abs(P.vx); }
        if (P.y < A.y + P.r) { P.y = A.y + P.r; P.vy = Math.abs(P.vy); }
        if (P.y > A.y + A.h - P.r) { P.y = A.y + A.h - P.r; P.vy = -Math.abs(P.vy); }
        P.trail.push({ x: P.x, y: P.y }); if (P.trail.length > 14) P.trail.shift();
        if (armed) { tgt.vx *= 1 - Math.min(1, 3 * sdt); tgt.vy *= 1 - Math.min(1, 3 * sdt); }

        for (const b of live) {
          if (b.doomed) continue;
          const bx = P.x - b.x, by = P.y - b.y, d = Math.hypot(bx, by) || 1, touch = P.r + b.r;
          const nx = bx / d, ny = by / d;
          if (b === tgt && armed) {
            if (d < touch * 0.92) { kill(hit); break; }
            continue;
          }
          // At most one luck save every 0.6 s so they stay special; otherwise subs get shoved aside like everyone else.
          if (b.e.isSub && b.saveCd <= 0 && d < touch && b !== tgt && t - S.lastSave > 0.6) {
            S.lastSave = t;
            const vn = P.vx * nx + P.vy * ny;
            if (vn < 0) { P.vx -= 2 * vn * nx; P.vy -= 2 * vn * ny; }
            P.x = b.x + nx * (touch + 1); P.y = b.y + ny * (touch + 1);
            b.vx -= nx * 260; b.vy -= ny * 260;
            b.saveCd = 1.2; S.saves++;
            S.fx.push({ type: 'save', x: b.x, y: b.y, r: b.r, t0: t });
            burst(b.x - nx * b.r, b.y - ny * b.r, '#5fd47a', 10, 380);
            continue;
          }
          const margin = P.r * 1.5;
          if (d < touch + margin) {
            const push = 1 - (d - touch) / margin;
            b.vx -= nx * push * 2600 * sdt; b.vy -= ny * push * 2600 * sdt;
            if (d < touch) { const ov = touch - d; b.x -= nx * ov * 0.6; b.y -= ny * ov * 0.6; }
          }
        }
        if (S.phase === 'run' && sc.hits[S.hitIdx] === hit && t - hit.t > 1.2) kill(hit); // safety net
      }
    }

    for (let i = S.parts.length - 1; i >= 0; i--) {
      const p = S.parts[i]; p.age += dt;
      if (p.age > p.life) { S.parts.splice(i, 1); continue; }
      p.vx *= p.conf ? 0.985 : 0.96; p.vy = p.vy * (p.conf ? 0.985 : 0.96) + p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; if (p.vr) p.rot += p.vr * dt;
    }
    if (!silent && S.phase === 'run' && t >= sc.intro * 0.4) {
      const fa = P.spin * 0.3 - 1.0, fx = P.x + Math.cos(fa) * P.r * .7, fy = P.y - P.r * .75;
      for (let i = 0; i < 2; i++) S.parts.push({ x: fx, y: fy, vx: rnd(-120, 120), vy: rnd(-220, -40), life: rnd(.2, .45), age: 0, size: rnd(3, 6), color: pick(['#ffd36b', '#ff8a3d', '#fff2c4']), g: 300 });
    }
    S.fx = S.fx.filter(f => t - f.t0 < 1.4);
    S.shake *= Math.exp(-9 * dt);
  }

  /* ---------- drawing ---------- */
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
  function text(str, x, y, font, color, align = 'left', base = 'alphabetic') { ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base; ctx.fillText(str, x, y); }
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  let bg = null;
  function drawBackdrop() {
    if (!bg) {
      bg = document.createElement('canvas'); bg.width = W; bg.height = H;
      const g = bg.getContext('2d'), lg = g.createLinearGradient(0, 0, W, H);
      lg.addColorStop(0, '#13202a'); lg.addColorStop(1, '#0a1112');
      g.fillStyle = lg; g.fillRect(0, 0, W, H);
    }
    ctx.drawImage(bg, 0, 0);
  }

  function drawBanner() {
    const b = banner;
    const w = 1100, h = 190, x = (W - w) / 2, y = H - h - 70;
    roundRect(x, y, w, h, 28);
    ctx.fillStyle = 'rgba(10,18,20,.92)'; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = b.kind === 'entries' ? 'rgba(255,138,61,.9)' : 'rgba(243,193,75,.8)'; ctx.stroke();
    if (b.kind === 'entries') {
      const left = Math.max(0, (b.closesAt - now()) / 1000);
      text('TYPE !join TO ENTER', x + 50, y + 92, `62px ${DISPLAY}`, '#ffffff');
      text(`${b.count} entered`, x + 50, y + 150, `700 36px ${BODY}`, '#f3c14b');
      if (b.subWeight > 1) text(`Subs get ${b.subWeight}x luck 🍀`, x + 330, y + 150, `600 32px ${BODY}`, 'rgba(255,255,255,.7)');
      text(mmss(Math.ceil(left)), x + w - 50, y + 125, `600 88px ${MONO}`, left < 10 ? '#ff8a3d' : '#5fd47a', 'right', 'middle');
    } else {
      text('ENTRIES CLOSED', x + 50, y + 92, `62px ${DISPLAY}`, '#ffffff');
      text(`${b.count} in the arena · starting soon`, x + 50, y + 150, `700 36px ${BODY}`, '#f3c14b');
      text('🥔', x + w - 110, y + 100, `110px ${EMOJI}`, '#fff', 'center', 'middle');
    }
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (backdrop) drawBackdrop();
    if (!S || S.phase === 'gone') { if (banner) drawBanner(); return; }
    const t = S.t, sc = S.sched, P = S.potato;
    const hit = sc.hits[S.hitIdx];
    const finalChase = S.phase === 'run' && hit && hit.kind === 'final';
    if (!reducedMotion && S.shake > 0.3) ctx.translate(rnd(-1, 1) * S.shake, rnd(-1, 1) * S.shake);

    roundRect(A.x - 10, A.y - 10, A.w + 20, A.h + 20, 28);
    ctx.fillStyle = 'rgba(6,12,14,.74)'; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = finalChase ? 'rgba(255,138,61,.85)' : 'rgba(255,170,90,.35)'; ctx.stroke();

    text('HOT POTATO', A.x, 96, `56px ${DISPLAY}`, '#ffffff');
    text(S.round.short ? 'Reroll' : 'Last ball standing wins', A.x + 470, 92, `600 28px ${BODY}`, 'rgba(255,255,255,.6)');
    const label = t < sc.intro && S.phase === 'run' ? `${S.n} ENTERED` : `${S.alive} LEFT`;
    text(label, A.x + A.w, 96, `48px ${DISPLAY}`, S.alive <= 2 && S.phase === 'run' ? '#ff8a3d' : '#f3c14b', 'right');

    for (const b of S.balls) {
      let s = 1, alpha = 1;
      if (!b.alive) {
        const p = (t - b.popT) / 0.3; if (p > 1) continue;
        s = 1 + 0.6 * p; alpha = 1 - p;
      } else if (t < b.spawn + 0.35) {
        if (t < b.spawn) continue;
        s = Math.max(0.01, backOut((t - b.spawn) / 0.35));
      }
      if (S.phase === 'win' && b === S.winner) s = 1 + Math.min(1, (t - S.winT) * 1.5) * 0.9 + Math.sin(t * 6) * 0.04;
      const sz = b.sprite.width * s;
      ctx.globalAlpha = alpha;
      ctx.drawImage(b.sprite, b.x - sz / 2, b.y - sz / 2, sz, sz);
      ctx.globalAlpha = 1;
    }
    const lf = Math.round(clamp(S.r * 0.4, 14, 22));
    ctx.lineJoin = 'round';
    for (const b of S.balls) {
      if (!b.alive || t < b.spawn + 0.2 || (S.phase === 'win' && b === S.winner)) continue;
      ctx.font = `600 ${lf}px ${BODY}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const nm = short(b.e.name, S.n > 80 ? 10 : 14);
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(nm, b.x, b.y + b.r + 4);
      ctx.fillStyle = b.e.isSub ? '#ffe3a0' : '#ffffff'; ctx.fillText(nm, b.x, b.y + b.r + 4);
    }

    for (const f of S.fx) {
      const p = t - f.t0;
      if (f.type === 'arc' && p < 0.3) {
        ctx.strokeStyle = `rgba(255,214,120,${1 - p / 0.3})`; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(f.x1, f.y1);
        for (let i = 1; i < 8; i++) { const q = i / 8; ctx.lineTo(f.x1 + (f.x2 - f.x1) * q + rnd(-14, 14), f.y1 + (f.y2 - f.y1) * q + rnd(-14, 14)); }
        ctx.lineTo(f.x2, f.y2); ctx.stroke();
      }
      if (f.type === 'ring' && p < 0.4) {
        ctx.strokeStyle = `rgba(255,170,90,${1 - p / 0.4})`; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (1 + p * 3), 0, Math.PI * 2); ctx.stroke();
      }
      if (f.type === 'save' && p < 0.9) {
        const q = p / 0.9;
        ctx.strokeStyle = `rgba(95,212,122,${1 - q})`; ctx.lineWidth = 7;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (1.05 + q * 0.8), 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = `rgba(95,212,122,${0.25 * (1 - q)})`; ctx.fill();
        ctx.globalAlpha = 1 - q;
        text('🍀 LUCK SAVE', f.x, f.y - f.r - 24 - q * 50, `26px ${DISPLAY}`, '#7dffa0', 'center');
        ctx.globalAlpha = 1;
      }
    }

    if (S.phase === 'run') {
      const appear = clamp((t - 0.5) / 0.4, 0, 1);
      if (appear > 0) {
        ctx.save();
        for (let i = 0; i < P.trail.length; i++) {
          const tr = P.trail[i], q = i / P.trail.length;
          ctx.fillStyle = `rgba(255,${120 + 60 * q},60,${0.18 * q})`;
          ctx.beginPath(); ctx.arc(tr.x, tr.y, P.r * (0.4 + 0.6 * q), 0, Math.PI * 2); ctx.fill();
        }
        const heat = 1 - S.alive / Math.max(S.n, 2);
        const pulse = 0.5 + 0.5 * Math.sin(t * (6 + heat * 18));
        const gr = ctx.createRadialGradient(P.x, P.y, P.r * .3, P.x, P.y, P.r * (2.2 + pulse * .6));
        gr.addColorStop(0, `rgba(255,140,60,${.55 + .3 * heat})`); gr.addColorStop(1, 'rgba(255,90,30,0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(P.x, P.y, P.r * 3, 0, Math.PI * 2); ctx.fill();
        const ps = backOut(appear);
        ctx.translate(P.x, P.y); ctx.rotate(Math.sin(P.spin) * 0.5); ctx.scale(ps, ps);
        ctx.font = `${Math.round(P.r * 2)}px ${EMOJI}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(skin, 0, P.r * 0.08);
        ctx.restore();
      }
    }
    for (const p of S.parts) {
      const a = 1 - p.age / p.life;
      ctx.globalAlpha = Math.max(0, a); ctx.fillStyle = p.color;
      if (p.conf) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); ctx.restore(); }
      else { ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.5 + a * 0.5), 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    for (const f of S.fx) {
      if (f.type !== 'name') continue;
      const p = (t - f.t0) / 1.1; if (p > 1) continue;
      ctx.globalAlpha = 1 - p;
      ctx.font = `600 ${S.n > 60 ? 22 : 28}px ${BODY}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(f.text, f.x, f.y - p * 70);
      ctx.fillStyle = '#ffb38a'; ctx.fillText(f.text, f.x, f.y - p * 70);
      ctx.globalAlpha = 1;
    }

    if (S.phase === 'run' && t < sc.intro + 0.3 && S.n > 1) {
      const q = clamp(t / 0.3, 0, 1) * clamp((sc.intro + 0.3 - t) / 0.3, 0, 1);
      ctx.globalAlpha = q;
      text(S.round.short ? 'REROLL' : `${S.n} ENTERED`, W / 2, A.y + 110, `64px ${DISPLAY}`, '#ffffff', 'center');
      const sw = S.round.subWeight || 1;
      text(S.subs && sw > 1 ? `Subs have ${sw}x luck 🍀` : 'Good luck, everyone', W / 2, A.y + 170, `600 34px ${BODY}`, '#ffe3a0', 'center');
      ctx.globalAlpha = 1;
    }
    if (finalChase) {
      const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vg; ctx.fillRect(-40, -40, W + 80, H + 80);
      const prev = sc.hits.length >= 2 ? sc.hits[sc.hits.length - 2].t : sc.intro;
      if (t - prev < 1.0) {
        ctx.globalAlpha = 0.85;
        text('FINAL 2', W / 2, A.y + 120, `80px ${DISPLAY}`, '#ff8a3d', 'center');
        ctx.globalAlpha = 1;
      }
    }
    for (const f of S.fx) {
      if (f.type !== 'boom') continue;
      const p = (t - f.t0) / 0.5; if (p > 1) continue;
      ctx.fillStyle = `rgba(255,220,150,${0.8 * (1 - p)})`;
      ctx.beginPath(); ctx.arc(f.x, f.y, 40 + p * 260, 0, Math.PI * 2); ctx.fill();
    }

    if (S.phase === 'win') winnerCard(t - S.winT);
    footer();
  }

  function siteName() {
    return (S.round.claimSite || location.host).replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  function winnerCard(dtw) {
    const start = S.n === 1 ? 0.3 : CARD_DELAY, end = start + CARD_SECONDS;
    if (dtw < start || dtw > end + 0.4 || !S.winner) return;
    const fade = Math.min(1, (dtw - start) / 0.3) * Math.min(1, (end + 0.4 - dtw) / 0.4);
    const w = S.winner, cw = 900, ch = 470, x = (W - cw) / 2, y = (H - ch) / 2 + 20;
    if (!S.cardSprite) S.cardSprite = makeSprite(w.e, 92, w.img);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(W / 2, H / 2); ctx.scale(0.9 + 0.1 * fade, 0.9 + 0.1 * fade); ctx.translate(-W / 2, -H / 2);
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 50;
    roundRect(x, y, cw, ch, 30); ctx.fillStyle = 'rgba(12,20,22,.96)'; ctx.fill();
    ctx.shadowBlur = 0; ctx.lineWidth = 5; ctx.strokeStyle = '#f3c14b'; ctx.stroke();
    text('WINNER', W / 2, y + 78, `60px ${DISPLAY}`, '#f3c14b', 'center');
    const ss = S.cardSprite.width;
    ctx.drawImage(S.cardSprite, x + 60, y + 110, ss, ss);
    const tx = x + 60 + ss + 30;
    text(short(w.e.name, 18), tx, y + 190, `700 56px ${BODY}`, '#ffffff');
    const sw = S.round.subWeight || 1;
    const chip = w.e.isSub ? (sw > 1 ? `🍀 SUBSCRIBER · ${sw}x LUCK` : '🍀 SUBSCRIBER') : 'VIEWER';
    ctx.font = `700 24px ${BODY}`; const cwid = ctx.measureText(chip).width + 32;
    roundRect(tx, y + 215, cwid, 44, 22); ctx.fillStyle = w.e.isSub ? 'rgba(243,193,75,.18)' : 'rgba(255,255,255,.1)'; ctx.fill();
    text(chip, tx + 16, y + 237, `700 24px ${BODY}`, w.e.isSub ? '#f3c14b' : '#dfe8e6', 'left', 'middle');
    const left = S.round.claimDeadline ? Math.max(0, (S.round.claimDeadline - now()) / 1000) : 120;
    ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(x + 50, y + ch - 140, cw - 100, 2);
    text('Claim your prize at', x + 60, y + ch - 92, `600 28px ${BODY}`, 'rgba(255,255,255,.7)');
    text(short(siteName(), 26) + '/claim', x + 60, y + ch - 46, `700 38px ${BODY}`, '#ffffff');
    text(mmss(Math.ceil(left)), x + cw - 60, y + ch - 46, `600 64px ${MONO}`, left < 30 ? '#ff8a3d' : '#5fd47a', 'right');
    ctx.restore();
  }

  function footer() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const y = H - 46;
    if (S.round.seed) {
      text('SEED REVEALED', A.x, y, `600 22px ${MONO}`, '#5fd47a');
      text(S.round.seed.slice(0, 40) + '…   verify at ' + siteName() + '/verify/' + S.round.id, A.x + 230, y, `400 22px ${MONO}`, 'rgba(255,255,255,.7)');
    } else if (S.round.seedHash) {
      text('FAIRNESS HASH', A.x, y, `600 22px ${MONO}`, '#f3c14b');
      text('sha256  ' + S.round.seedHash, A.x + 230, y, `400 22px ${MONO}`, 'rgba(255,255,255,.7)');
    }
  }

  let last = performance.now(), raf = 0;
  function frame(ts) {
    const dt = Math.min(1 / 30, (ts - last) / 1000); last = ts;
    update(dt); draw();
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    play,
    setBanner(b) { banner = b; },
    reveal(seed) { if (S) S.round.seed = seed; },
    setPotato(p) { skin = p; },
    get playing() { return !!S && S.phase !== 'gone'; },
    get roundId() { return S ? S.round.key : null; },
    stop() { S = null; },
    debug: () => S,
  };
}
