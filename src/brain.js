// Canvas rendering of the "脳内メーカー" style brain image.

export const CATEGORY_COLORS = {
  愛情: '#ff6b9d',
  仕事: '#4d96ff',
  欲望: '#ffa24d',
  遊び: '#42c98e',
  悩み: '#9b6bff',
  その他: '#8a8f99',
};

const WIDTH = 1000;
const HEIGHT = 1000;

/**
 * Draw a brain outline (two bumpy hemispheres) onto ctx.
 */
function drawBrainOutline(ctx) {
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2 + 30;
  const rx = 380;
  const ry = 330;

  ctx.save();
  ctx.beginPath();
  // bumpy outline using sinusoidal perturbation
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

  // central fissure
  ctx.beginPath();
  ctx.moveTo(cx, cy - ry * 0.95);
  ctx.bezierCurveTo(cx - 30, cy - ry * 0.3, cx + 30, cy + ry * 0.3, cx, cy + ry * 0.95);
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#e8829f';
  ctx.stroke();

  // a few squiggly sulci for texture
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

/**
 * Place words inside the brain without overlapping, using a spiral search.
 */
function layoutWords(ctx, terms, geo) {
  const { cx, cy, rx, ry } = geo;
  const placed = [];
  const maxWeight = terms.length ? terms[0].weight : 1;

  for (const t of terms) {
    const fontSize = Math.round(22 + (t.weight / maxWeight) * 66);
    ctx.font = `700 ${fontSize}px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
    const metrics = ctx.measureText(t.term);
    const w = metrics.width;
    const h = fontSize;

    let found = null;
    // spiral out from center
    for (let r = 0; r < 420 && !found; r += 10) {
      const angSteps = Math.max(8, Math.floor(r / 6));
      for (let a = 0; a < angSteps; a++) {
        const ang = (a / angSteps) * Math.PI * 2 + r * 0.3;
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r * (ry / rx);
        const box = { x: x - w / 2, y: y - h / 2, w, h };
        // keep inside brain (test corners)
        const inside =
          isInsideEllipse(box.x, box.y, cx, cy, rx * 0.92, ry * 0.92) &&
          isInsideEllipse(box.x + w, box.y + h, cx, cy, rx * 0.92, ry * 0.92) &&
          isInsideEllipse(box.x + w, box.y, cx, cy, rx * 0.92, ry * 0.92) &&
          isInsideEllipse(box.x, box.y + h, cx, cy, rx * 0.92, ry * 0.92);
        if (!inside) continue;
        const overlaps = placed.some(
          (p) => !(box.x + box.w < p.x || box.x > p.x + p.w || box.y + box.h < p.y || box.y > p.y + p.h)
        );
        if (!overlaps) {
          found = { ...box, term: t, fontSize };
          break;
        }
      }
    }
    if (found) placed.push(found);
  }
  return placed;
}

/**
 * Render the brain to a canvas element and return it.
 * `model` is from buildBrainModel(). `meta` carries display info.
 */
export function renderBrain(canvas, model, meta = {}) {
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = '#fff7fb';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // title
  ctx.fillStyle = '#5a2a3a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 44px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif';
  ctx.fillText('Nostr 脳内メーカー', WIDTH / 2, 70);
  if (meta.name) {
    ctx.font = '500 30px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif';
    ctx.fillStyle = '#8a5a6a';
    ctx.fillText(`${meta.name} の あたまの中`, WIDTH / 2, 112);
  }

  const geo = drawBrainOutline(ctx);
  const placed = layoutWords(ctx, model.terms, geo);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of placed) {
    ctx.font = `700 ${p.fontSize}px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
    ctx.fillStyle = CATEGORY_COLORS[p.term.category] || CATEGORY_COLORS['その他'];
    ctx.fillText(p.term.term, p.x + p.w / 2, p.y + p.h / 2);
  }

  // legend
  const cats = Object.entries(model.categories).sort((a, b) => b[1] - a[1]);
  let lx = 60;
  const ly = HEIGHT - 50;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 24px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif';
  for (const [cat] of cats) {
    ctx.fillStyle = CATEGORY_COLORS[cat] || CATEGORY_COLORS['その他'];
    ctx.fillRect(lx, ly - 12, 24, 24);
    ctx.fillStyle = '#5a2a3a';
    ctx.fillText(cat, lx + 32, ly);
    lx += 60 + ctx.measureText(cat).width;
  }

  // footer
  ctx.textAlign = 'right';
  ctx.fillStyle = '#b08a96';
  ctx.font = '400 20px system-ui, sans-serif';
  ctx.fillText(meta.footer || 'nostr-brainmaker', WIDTH - 40, HEIGHT - 24);

  return { placed, count: placed.length };
}

/**
 * Trigger a PNG download of the canvas.
 */
export function exportCanvas(canvas, filename = 'nostr-brain.png') {
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
