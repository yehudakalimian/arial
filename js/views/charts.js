// Dependency-free SVG charts. Time axes stay left→right (dir="ltr"), as clinicians expect on WHO growth curves.
import { curve, PCT_LINES, INDICATORS } from '../logic/who.js';
import { esc, fmtDate } from '../util.js';

export function barChart(series, { key, unit = '', height = 120, decimals = 0, label }) {
  const W = 320, H = height, pad = { t: 16, b: 22, l: 8, r: 8 };
  const max = Math.max(1, ...series.map((d) => d[key])) * 1.15;
  const bw = (W - pad.l - pad.r) / series.length;
  const bars = series.map((d, i) => {
    const h = ((H - pad.t - pad.b) * d[key]) / max;
    const x = pad.l + i * bw + bw * 0.18, y = H - pad.b - h;
    const day = new Date(d.day);
    return `<g><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="3" class="bbar ${i === series.length - 1 ? 'bbar-today' : ''}"/>
      <text x="${(x + bw * 0.32).toFixed(1)}" y="${(y - 4).toFixed(1)}" class="bar-val">${d[key].toFixed(decimals)}</text>
      <text x="${(x + bw * 0.32).toFixed(1)}" y="${H - 6}" class="bar-lbl">${day.getDate()}/${day.getMonth() + 1}</text></g>`;
  }).join('');
  return `<figure class="chart"><figcaption>${esc(label)}${unit ? ` <span class="muted">(${esc(unit)})</span>` : ''}</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" dir="ltr">${bars}</svg></figure>`;
}

export function growthChart(ind, baby, measurements, now = Date.now()) {
  const def = INDICATORS[ind];
  const birth = Date.parse(baby.birth_date);
  const pts = measurements.filter((m) => m[def.field] != null)
    .map((m) => [(Date.parse(m.measured_at) - birth) / 864e5, def.toValue(m), m])
    .sort((a, b) => a[0] - b[0]);
  const ageDays = (now - birth) / 864e5;
  const maxDays = Math.min(730, Math.max(91, Math.ceil((Math.max(ageDays, ...pts.map((p) => p[0])) + 45) / 30) * 30));
  const curves = Object.fromEntries(PCT_LINES.map((p) => [p, curve(ind, baby.sex, p, maxDays, 3)]));
  const allY = [...curves[3].map((p) => p[1]), ...curves[97].map((p) => p[1]), ...pts.map((p) => p[1])];
  const yMin = Math.floor(Math.min(...allY) * 0.97), yMax = Math.ceil(Math.max(...allY) * 1.02);
  const W = 340, H = 230, pad = { t: 10, b: 26, l: 34, r: 30 };
  const X = (d) => pad.l + (d / maxDays) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - ((v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  const path = (c) => c.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const band = (lo, hi) => `${path(curves[lo])}${curves[hi].slice().reverse().map((p) => `L${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')}Z`;
  const yTicks = []; const step = (yMax - yMin) > 12 ? 2 : (yMax - yMin) > 5 ? 1 : 0.5;
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) yTicks.push(v);
  const xTicks = []; for (let m = 0; m * 30.4375 <= maxDays; m += maxDays > 400 ? 3 : 1) xTicks.push(m);
  return `<figure class="chart growth"><figcaption>${def.label} <span class="muted">(${def.unit}, תקני WHO, ${baby.sex === 'female' ? 'בנות' : 'בנים'})</span></figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="עקומת ${def.label}" dir="ltr">
    <path d="${band(3, 97)}" class="band-outer"/><path d="${band(15, 85)}" class="band-inner"/>
    ${yTicks.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" class="gline"/><text x="${pad.l - 4}" y="${Y(v) + 3}" class="axis" text-anchor="end">${v}</text>`).join('')}
    ${xTicks.map((m) => `<text x="${X(m * 30.4375)}" y="${H - 8}" class="axis" text-anchor="middle">${m}</text>`).join('')}
    <text x="${W - pad.r}" y="${H - 8}" class="axis" text-anchor="start" dx="4">ח׳</text>
    ${PCT_LINES.map((p) => `<path d="${path(curves[p])}" class="pct ${p === 50 ? 'pct-50' : ''}"/><text x="${W - pad.r + 3}" y="${Y(curves[p][curves[p].length - 1][1]) + 3}" class="pct-lbl">${p}</text>`).join('')}
    <line x1="${X(ageDays)}" x2="${X(ageDays)}" y1="${pad.t}" y2="${H - pad.b}" class="today"/>
    ${pts.length > 1 ? `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')}" class="pts-line"/>` : ''}
    ${pts.map((p) => `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="4" class="pt"><title>${fmtDate(p[2].measured_at)}: ${p[1]}</title></circle>`).join('')}
  </svg></figure>`;
}
