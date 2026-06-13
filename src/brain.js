const WIDTH = 1000;
const HEIGHT = 1000;
const BASE_FONT_SIZE = 56;
const MIN_FONT_SIZE = 24;
const FONT_FAMILY = '"Hiragino Sans", "Noto Sans JP", system-ui, sans-serif';

function colorForLabel(id) {
  const hue = (id * 47) % 360;
  return `hsl(${hue} 72% 56%)`;
}

function shuffle(items, random) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function drawBrainOutline(ctx) {
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2 + 30;
  const rx = 380;
  const ry = 330;

  ctx.save();
  ctx.beginPath();
  const steps = 160;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const bump = 1 + 0.045 * Math.sin(t * 9) + 0.03 * Math.sin(t * 17 + 1);
    const x = cx + Math.cos(t) * rx * bump;
    const y = cy + Math.sin(t) * ry * bump;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
  grad.addColorStop(0, '#ffe3ec');
  grad.addColorStop(1, '#ffd0e0');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#e8829f';
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx, cy - ry * 0.95);
  ctx.bezierCurveTo(cx - 30, cy - ry * 0.3, cx + 30, cy + ry * 0.3, cx, cy + ry * 0.95);
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#e8829f';
  ctx.stroke();

  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(232,130,159,0.5)';
  for (let s = 0; s < 8; s++) {
    ctx.beginPath();
    const side = s % 2 === 0 ? -1 : 1;
    const baseX = cx + side * (80 + (s % 4) * 60);
    const baseY = cy - 180 + (s % 4) * 100;
    ctx.moveTo(baseX, baseY);
    ctx.bezierCurveTo(baseX + side * 60, baseY - 40, baseX + side * 30, baseY + 60, baseX + side * 90, baseY + 30);
    ctx.stroke();
  }
  ctx.restore();

  return { cx, cy, rx, ry };
}

function isInsideEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function resolveFontSize(count) {
  if (count <= 0) return BASE_FONT_SIZE;
  const scale = Math.min(1, Math.sqrt(140 / count));
  return Math.max(MIN_FONT_SIZE, Math.round(BASE_FONT_SIZE * scale));
}

function canPlace(box, geo, placed) {
  const { cx, cy, rx, ry } = geo;
  const insetRx = rx * 0.92;
  const insetRy = ry * 0.92;
  const corners = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h],
  ];
  if (!corners.every(([x, y]) => isInsideEllipse(x, y, cx, cy, insetRx, insetRy))) {
    return false;
  }
  return !placed.some((p) => !(box.x + box.w < p.x || box.x > p.x + p.w || box.y + box.h < p.y || box.y > p.y + p.h));
}

function layoutPosts(ctx, perPost, geo, random = Math.random) {
  const fontSize = resolveFontSize(perPost.length);
  const shuffled = shuffle(perPost, random);
  const placed = [];

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${fontSize}px ${FONT_FAMILY}`;

  for (const post of shuffled) {
    const metrics = ctx.measureText(post.char);
    const w = Math.max(metrics.width, fontSize * 0.9);
    const h = fontSize;
    let found = null;

    for (let attempt = 0; attempt < 800 && !found; attempt++) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * 320;
      const x = geo.cx + Math.cos(angle) * radius;
      const y = geo.cy + Math.sin(angle) * radius * (geo.ry / geo.rx);
      const box = { x: x - w / 2, y: y - h / 2, w, h };
      if (canPlace(box, geo, placed)) {
        found = { ...box, post, fontSize };
      }
    }

    if (found) {
      placed.push(found);
    }
  }

  return { placed, fontSize };
}

export function renderBrainFromPosts(canvas, perPost, meta = {}, options = {}) {
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff7fb';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = '#5a2a3a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 44px ${FONT_FAMILY}`;
  ctx.fillText('Nostr 脳内メーカー', WIDTH / 2, 70);
  if (meta.name) {
    ctx.font = `500 30px ${FONT_FAMILY}`;
    ctx.fillStyle = '#8a5a6a';
    ctx.fillText(`${meta.name} の あたまの中`, WIDTH / 2, 112);
  }

  const geo = drawBrainOutline(ctx);
  const { placed, fontSize } = layoutPosts(ctx, perPost, geo, options.random);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const item of placed) {
    ctx.font = `700 ${item.fontSize}px ${FONT_FAMILY}`;
    ctx.fillStyle = colorForLabel(item.post.id);
    ctx.fillText(item.post.char, item.x + item.w / 2, item.y + item.h / 2);
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = '#b08a96';
  ctx.font = '400 20px system-ui, sans-serif';
  ctx.fillText(meta.footer || 'nostr-brainmaker', WIDTH - 40, HEIGHT - 24);

  return { placed, count: placed.length, fontSize };
}

export function exportCanvas(canvas, filename = 'nostr-brain.png') {
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
