
// ParkWise analytics dashboard. No dependencies: charts are plain SVG so the page works under the backend's
// Content-Security-Policy (scripts only from this origin). All data comes from GET /api/v1/analytics/summary.

const API = '/api/v1';
const TOKEN_KEY = 'parkwise.dashboard.token';
const REFRESH_MS = 30_000;

const $ = id => document.getElementById(id);
const storage = {
  get() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(value) { try { sessionStorage.setItem(TOKEN_KEY, value); } catch { /* private mode: keep it in memory */ } },
  clear() { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }
};

let token = storage.get();
let timer = null;
let lastSummary = null;

// ---------------------------------------------------------------- DOM and format helpers

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (parent) parent.append(node);
  return node;
}
function text(parent, value, attrs) {
  const node = s('text', attrs, parent);
  node.textContent = value;
  return node;
}

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const sum = values => values.reduce((total, value) => total + (value ?? 0), 0);

const fmtInt = value => (value === null || value === undefined ? '–' : new Intl.NumberFormat('en-US').format(value));
const fmtPct = (ratio, digits = 0) => (ratio === null || ratio === undefined ? '–' : `${(ratio * 100).toFixed(digits)}%`);
const fmtAvailability = value => (value === null || value === undefined ? '–' : `${value.toFixed(1)}%`);
const fmtMin = value => (value === null || value === undefined ? '–' : `${value} min`);
const fmtMs = value => (value === null || value === undefined ? '–' : `${Math.round(value)} ms`);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LEVELS = ['P1', 'P2', 'P3'];
const levelColor = level => css(`--series-${LEVELS.indexOf(level) + 1}`) || css('--series-1');

function niceMax(value) {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const n = value / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * power;
}

/** Shortens an SVG label until it fits, keeping the full text in a <title>. */
function fit(node, maxWidth) {
  const full = node.textContent;
  if (node.getComputedTextLength() <= maxWidth) return;
  let value = full;
  while (value.length > 1 && node.getComputedTextLength() > maxWidth) {
    value = value.slice(0, -1);
    node.textContent = `${value.trimEnd()}…`;
  }
  s('title', {}, node).textContent = full;
}

// Rounded data end on the right, square at the baseline.
function barPath(x, y, width, height, radius = 4) {
  const r = Math.min(radius, width, height / 2);
  return `M${x},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height - r} Q${x + width},${y + height} ${x + width - r},${y + height} H${x} Z`;
}

// ---------------------------------------------------------------- tooltip

const tip = $('tooltip');
function showTip(point, title, rows) {
  tip.replaceChildren();
  if (title) tip.append(h('div', { class: 't-title', text: title }));
  for (const row of rows) {
    const line = h('div', { class: 't-row' });
    if (row.color) {
      const key = h('span', { class: 't-key' });
      key.style.background = row.color;
      line.append(key);
    }
    line.append(h('b', { text: row.value }), h('span', { text: row.label }));
    tip.append(line);
  }
  tip.hidden = false;
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  let left = point.clientX + 14;
  let top = point.clientY - height - 10;
  if (left + width > window.innerWidth - 8) left = point.clientX - width - 14;
  if (top < 8) top = point.clientY + 16;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}
const hideTip = () => { tip.hidden = true; };

function bindTip(node, title, rows) {
  node.setAttribute('tabindex', '0');
  node.addEventListener('pointermove', event => showTip(event, title, rows));
  node.addEventListener('pointerleave', hideTip);
  node.addEventListener('focus', () => {
    const box = node.getBoundingClientRect();
    showTip({ clientX: box.left + box.width / 2, clientY: box.top }, title, rows);
  });
  node.addEventListener('blur', hideTip);
}

// ---------------------------------------------------------------- chart primitives

const resizer = new ResizeObserver(entries => {
  for (const entry of entries) {
    const node = entry.target;
    const width = Math.floor(entry.contentRect.width);
    if (width && width !== node.dataWidth) {
      node.dataWidth = width;
      node.replaceChildren();
      node.draw(width);
    }
  }
});

function chart(container, draw) {
  const node = h('div', { class: 'chart' });
  node.draw = width => draw(node, width);
  container.append(node);
  resizer.observe(node);
  return node;
}

function chartTitle(container, value) {
  container.append(h('p', { class: 'chart-title', text: value }));
}

function empty(container, message) {
  container.append(h('p', { class: 'empty', text: message }));
}

function legend(container, items, kind = 'box') {
  const node = h('div', { class: 'legend' });
  for (const item of items) {
    const swatch = h('i', { class: kind === 'line' ? 'line' : '' });
    swatch.style.background = item.color;
    node.append(h('span', {}, [swatch, item.label]));
  }
  container.append(node);
}

/** Horizontal bars, one series. items: [{ label, value, color?, note? }] */
function hbars(container, items, { format = fmtInt, max, valueLabel = '', color } = {}) {
  return chart(container, (node, width) => {
    const fill = color ?? css('--series-1');
    const labelWidth = Math.min(200, Math.max(90, Math.round(width * 0.34)));
    const valueWidth = 72;
    const rowHeight = 32;
    const barHeight = 16;
    const plotWidth = Math.max(40, width - labelWidth - valueWidth);
    const top = max ?? niceMax(Math.max(0, ...items.map(item => item.value ?? 0)));
    const height = items.length * rowHeight;
    const svg = s('svg', { width, height, role: 'img', 'aria-label': items.map(item => `${item.label}: ${format(item.value, item)}`).join('; ') }, node);
    items.forEach((item, index) => {
      const y = index * rowHeight;
      const middle = y + rowHeight / 2;
      fit(text(svg, item.label, { x: labelWidth - 10, y: middle, 'text-anchor': 'end', 'dominant-baseline': 'middle' }), labelWidth - 14);
      const barWidth = item.value > 0 ? Math.max(2, (item.value / top) * plotWidth) : 0;
      const group = s('g', { class: 'mark' }, svg);
      s('rect', { class: 'hit', x: 0, y, width, height: rowHeight }, group);
      if (barWidth > 0) s('path', { d: barPath(labelWidth, middle - barHeight / 2, barWidth, barHeight), fill: item.color ?? fill }, group);
      text(svg, format(item.value, item), { x: labelWidth + barWidth + 8, y: middle, 'dominant-baseline': 'middle', class: 'value-text' });
      const rows = [{ value: format(item.value, item), label: valueLabel, color: item.color ?? fill }];
      if (item.note) rows.push({ value: '', label: item.note });
      bindTip(group, item.label, rows);
    });
    s('line', { x1: labelWidth, x2: labelWidth, y1: 0, y2: height, stroke: css('--axis'), 'stroke-width': 1 }, svg);
  });
}

/** Funnel: horizontal bars on an ordinal ramp, first step darkest. */
function funnel(container, steps) {
  return chart(container, (node, width) => {
    const labelWidth = Math.min(170, Math.max(132, Math.round(width * 0.34)));
    const valueWidth = 96;
    const rowHeight = 42;
    const barHeight = 22;
    const plotWidth = Math.max(40, width - labelWidth - valueWidth);
    const first = steps[0].count || 1;
    const height = steps.length * rowHeight;
    const svg = s('svg', { width, height, role: 'img', 'aria-label': steps.map(step => `${step.label}: ${step.count}`).join('; ') }, node);
    steps.forEach((step, index) => {
      const y = index * rowHeight;
      const middle = y + rowHeight / 2;
      const color = css(`--step-${index + 1}`);
      fit(text(svg, step.label, { x: labelWidth - 10, y: middle, 'text-anchor': 'end', 'dominant-baseline': 'middle' }), labelWidth - 14);
      const barWidth = step.count > 0 ? Math.max(2, (step.count / first) * plotWidth) : 0;
      const group = s('g', { class: 'mark' }, svg);
      s('rect', { class: 'hit', x: 0, y, width, height: rowHeight }, group);
      if (barWidth > 0) s('path', { d: barPath(labelWidth, middle - barHeight / 2, barWidth, barHeight), fill: color }, group);
      const share = index === 0 ? '' : ` · ${fmtPct(step.fromPrevious)}`;
      text(svg, `${fmtInt(step.count)}${share}`, { x: labelWidth + barWidth + 8, y: middle, 'dominant-baseline': 'middle', class: 'value-text' });
      const rows = [{ value: fmtInt(step.count), label: 'user-days', color }];
      if (index > 0) rows.push({ value: fmtPct(step.fromPrevious), label: 'of the previous step' }, { value: fmtPct(step.count / first), label: 'of those who checked availability' });
      bindTip(group, step.label, rows);
    });
    s('line', { x1: labelWidth, x2: labelWidth, y1: 0, y2: height, stroke: css('--axis'), 'stroke-width': 1 }, svg);
  });
}

/** Line chart with one y axis and a crosshair. series: [{ name, color, values: (number|null)[] }] */
function lines(container, labels, series, { format = fmtInt, yMax, xLabel = value => value, integer = false } = {}) {
  return chart(container, (node, width) => {
    const height = 230;
    const margin = { top: 12, right: 18, bottom: 30, left: 46 };
    const plotWidth = Math.max(60, width - margin.left - margin.right);
    const plotHeight = height - margin.top - margin.bottom;
    let max = yMax ?? niceMax(Math.max(0, ...series.flatMap(item => item.values.filter(value => value !== null))));
    if (integer) max = Math.max(4, Math.ceil(max / 4) * 4); // counts: four whole-number steps
    const x = index => margin.left + (labels.length === 1 ? plotWidth / 2 : (index * plotWidth) / (labels.length - 1));
    const y = value => margin.top + plotHeight - (value / max) * plotHeight;
    const svg = s('svg', { width, height, role: 'img', 'aria-label': series.map(item => item.name).join(', ') }, node);

    for (let tick = 0; tick <= 4; tick++) {
      const value = (max * tick) / 4;
      const ty = y(value);
      s('line', { x1: margin.left, x2: margin.left + plotWidth, y1: ty, y2: ty, stroke: tick === 0 ? css('--axis') : css('--grid'), 'stroke-width': 1 }, svg);
      text(svg, format(value), { x: margin.left - 8, y: ty, 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'axis-text' });
    }
    const every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(plotWidth / 56))));
    let lastShown = -Infinity;
    labels.forEach((label, index) => {
      const isLast = index === labels.length - 1;
      if (index % every === 0 || (isLast && index - lastShown >= every * 0.75)) {
        text(svg, xLabel(label), { x: x(index), y: height - 8, 'text-anchor': isLast && labels.length > 1 ? 'end' : 'middle', class: 'axis-text' });
        lastShown = index;
      }
    });

    for (const item of series) {
      let d = '';
      let pen = false;
      item.values.forEach((value, index) => {
        if (value === null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(index)},${y(value)}`;
        pen = true;
      });
      s('path', { d, fill: 'none', stroke: item.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      item.values.forEach((value, index) => {
        const lonely = value !== null && item.values[index - 1] == null && item.values[index + 1] == null;
        const last = value !== null && item.values.slice(index + 1).every(next => next === null);
        if (lonely || last) s('circle', { cx: x(index), cy: y(value), r: 4, fill: item.color, stroke: css('--surface'), 'stroke-width': 2 }, svg);
      });
    }

    const cross = s('line', { y1: margin.top, y2: margin.top + plotHeight, stroke: css('--axis'), 'stroke-width': 1, visibility: 'hidden' }, svg);
    const overlay = s('rect', { x: margin.left, y: margin.top, width: plotWidth, height: plotHeight, fill: 'transparent', tabindex: 0, 'aria-label': 'Move with the arrow keys to read each value' }, svg);
    let current = labels.length - 1;
    const show = (index, point) => {
      current = Math.min(labels.length - 1, Math.max(0, index));
      cross.setAttribute('x1', x(current));
      cross.setAttribute('x2', x(current));
      cross.setAttribute('visibility', 'visible');
      showTip(point, xLabel(labels[current]), series.map(item => ({ value: format(item.values[current]), label: item.name, color: item.color })));
    };
    const nearest = clientX => {
      const box = overlay.getBoundingClientRect();
      const ratio = (clientX - box.left) / box.width;
      return Math.round(ratio * (labels.length - 1));
    };
    overlay.addEventListener('pointermove', event => show(nearest(event.clientX), event));
    overlay.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
    const keyPoint = () => {
      const box = overlay.getBoundingClientRect();
      return { clientX: box.left + (x(current) - margin.left), clientY: box.top };
    };
    overlay.addEventListener('focus', () => show(current, keyPoint()));
    overlay.addEventListener('blur', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        current += event.key === 'ArrowLeft' ? -1 : 1;
        show(current, keyPoint());
      }
    });
  });
}

/** Heatmap on a single-hue ramp. matrix[row][col] holds counts. */
function heatmap(container, rowLabels, colLabels, matrix, { rowTitle = label => label, colTitle = label => label } = {}) {
  const max = Math.max(1, ...matrix.flat());
  const shade = value => (value <= 0 ? css('--seq-0') : css(`--seq-${Math.min(7, 1 + Math.floor((value / max) * 6.999))}`));
  chart(container, (node, width) => {
    const labelWidth = 44;
    const top = 20;
    const gap = 2;
    const cellWidth = Math.max(8, (width - labelWidth) / colLabels.length);
    const cellHeight = 24;
    const height = top + rowLabels.length * (cellHeight + gap);
    const svg = s('svg', { width, height, role: 'img', 'aria-label': 'Heatmap of unmet demand by weekday and hour' }, node);
    colLabels.forEach((label, col) => {
      if (col % 3 === 0) text(svg, label, { x: labelWidth + col * cellWidth + cellWidth / 2, y: 12, 'text-anchor': 'middle', class: 'axis-text' });
    });
    rowLabels.forEach((label, row) => {
      const y = top + row * (cellHeight + gap);
      text(svg, label, { x: labelWidth - 8, y: y + cellHeight / 2, 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'axis-text' });
      colLabels.forEach((col, colIndex) => {
        const value = matrix[row][colIndex];
        const cell = s('rect', {
          class: 'mark', x: labelWidth + colIndex * cellWidth + gap / 2, y, width: Math.max(1, cellWidth - gap), height: cellHeight, rx: 2, fill: shade(value)
        }, svg);
        bindTip(cell, `${rowTitle(label)} ${colTitle(col)}`, [{ value: fmtInt(value), label: value === 1 ? 'query without a free spot' : 'queries without a free spot' }]);
      });
    });
  });
  const scale = h('div', { class: 'scale' }, [h('span', { text: '0' })]);
  const ramp = h('span', { class: 'ramp' });
  for (let step = 0; step <= 7; step++) {
    const swatch = h('i');
    swatch.style.background = css(`--seq-${step}`);
    ramp.append(swatch);
  }
  scale.append(ramp, h('span', { text: fmtInt(max) }));
  container.append(scale);
}

function table(container, headers, rows, numeric = []) {
  const head = h('tr', {}, headers.map((label, index) => h('th', { class: numeric.includes(index) ? 'num' : '', text: label })));
  const body = rows.map(row => h('tr', {}, row.map((cell, index) => h('td', { class: numeric.includes(index) ? 'num' : '', text: cell }))));
  container.append(h('div', { class: 'table-wrap' }, h('table', {}, [h('thead', {}, head), h('tbody', {}, body)])));
}

function tableView(container, headers, rows, numeric = []) {
  const details = h('details', { class: 'table-view' }, h('summary', { text: 'View as table' }));
  table(details, headers, rows, numeric);
  container.append(details);
}

function stats(container, items) {
  container.append(h('div', { class: 'stats' }, items.map(item => h('div', { class: 'stat' }, [
    h('span', { class: 'label', text: item.label }),
    h('span', { class: 'value', text: item.value }),
    item.note ? h('span', { class: 'note', text: item.note }) : null
  ]))));
}

function block(container, title) {
  const node = h('div');
  if (title) chartTitle(node, title);
  container.append(node);
  return node;
}

// ---------------------------------------------------------------- sections

function renderKpis(summary) {
  const { parking, reservations, eventCounts } = summary;
  const busy = parking.reserved + parking.occupied;
  const occupancy = parking.total ? busy / parking.total : 0;
  const meter = h('div', { class: 'meter', role: 'presentation' }, h('span'));
  meter.firstChild.style.width = `${Math.round(occupancy * 100)}%`;
  const tile = (label, value, note, extra, hero = false) => h('div', { class: `kpi${hero ? ' hero' : ''}` }, [
    h('span', { class: 'label', text: label }), h('span', { class: 'value', text: value }), extra ?? null, note ? h('span', { class: 'note', text: note }) : null
  ]);
  $('kpis').replaceChildren(
    tile('Live occupancy', fmtPct(occupancy), `${fmtInt(parking.occupied)} occupied and ${fmtInt(parking.reserved)} reserved out of ${fmtInt(parking.total)} usable spots · ${fmtInt(parking.disabled)} unavailable`, meter, true),
    tile('Free spots', fmtInt(parking.free), 'available right now'),
    tile('Accessible free', fmtInt(parking.accessibleFree), 'accessible spots'),
    tile('Electric free', fmtInt(parking.evFree), 'charging spots'),
    tile('Active user reservations', fmtInt(reservations.user.active), `${fmtInt(reservations.user.fulfilled)} fulfilled, ${fmtInt(reservations.user.expired)} expired`),
    tile('Events recorded', fmtInt(sum(Object.values(eventCounts))), `${Object.keys(eventCounts).length} event types from both apps`)
  );
}

const FAILURE_LABELS = {
  spot_taken: 'Spot taken',
  already_active: 'Already reserved',
  expired: 'Hold expired',
  offline: 'No connection',
  server_error: 'Server error',
  other: 'Other'
};

function renderBq7(container, funnelData) {
  const [viewed, , , reserved] = funnelData.steps;
  if (!viewed.count) {
    empty(container, 'No funnel events yet. Find a spot and Reserve send them when a signed-in user checks availability.');
    return;
  }
  const failures = funnelData.failures;
  const drop = funnelData.biggestDrop;
  stats(container, [
    { label: 'Conversion', value: fmtPct(funnelData.conversionRate), note: `${fmtInt(reserved.count)} of ${fmtInt(viewed.count)} user-days, last ${funnelData.windowDays} days` },
    { label: 'Biggest drop', value: drop ? fmtPct(drop.dropRate) : '–', note: drop ? `${drop.from} → ${drop.to}` : 'No drop between steps' },
    { label: 'Failed attempts', value: fmtInt(sum(failures.map(row => row.count))), note: failures[0] ? `Most common: ${FAILURE_LABELS[failures[0].reason] ?? failures[0].reason}` : 'None recorded' }
  ]);
  const split = h('div', { class: 'split' });
  container.append(split);
  funnel(block(split, 'Users at each step (one user on one day)'), funnelData.steps);
  const reasons = block(split, 'Why a reservation attempt failed');
  if (failures.length) {
    hbars(reasons, failures.map(row => ({ label: FAILURE_LABELS[row.reason] ?? row.reason, value: row.count })), { valueLabel: 'attempts' });
  } else {
    empty(reasons, 'No failed attempts recorded.');
  }
  const trend = block(container, 'Last 14 days: users who checked availability and users who reserved');
  const series = [
    { name: 'Checked availability', color: css('--series-1'), values: funnelData.daily.map(day => day.viewed) },
    { name: 'Reserved', color: css('--series-2'), values: funnelData.daily.map(day => day.reserved) }
  ];
  legend(trend, series.map(item => ({ label: item.name, color: item.color })), 'line');
  lines(trend, funnelData.daily.map(day => day.day), series, { xLabel: day => day.slice(5), integer: true });
  tableView(container, ['Platform', 'Checked', 'Opened a spot', 'Tapped confirm', 'Reserved', 'Conversion'],
    funnelData.byPlatform.map(row => [row.platform, fmtInt(row.viewed), fmtInt(row.selected), fmtInt(row.confirmed), fmtInt(row.reserved), fmtPct(row.conversionRate)]), [1, 2, 3, 4, 5]);
}

function renderBq8(container, data) {
  if (!data.totalSessions) {
    empty(container, 'No forecast or live-availability sessions recorded yet.');
    return;
  }
  stats(container, [
    { label: 'User-days analysed', value: fmtInt(data.totalSessions) },
    { label: 'Forecast checked first', value: fmtPct(data.forecastShare), note: `${fmtInt(data.forecastSessions)} user-days` },
    { label: 'Parked after forecast', value: fmtPct(data.forecastParkingRate), note: 'confirmed reservation check-ins' },
    { label: 'Parked with live-only use', value: fmtPct(data.liveOnlyParkingRate), note: `${fmtInt(data.liveOnlySessions)} user-days` }
  ]);
  if (data.forecastParkingRate !== null && data.liveOnlyParkingRate !== null) {
    hbars(block(container, 'Confirmed parking rate by usage'), [
      { label: 'Forecast first', value: data.forecastParkingRate, color: css('--series-1'), note: `${fmtInt(data.forecastSessions)} user-days` },
      { label: 'Live availability only', value: data.liveOnlyParkingRate, color: css('--series-2'), note: `${fmtInt(data.liveOnlySessions)} user-days` }
    ], { format: value => fmtPct(value), max: 1, valueLabel: 'checked in' });
  }
  tableView(container, ['Usage group', 'User-days', 'Share', 'Check-in rate'], [
    ['Forecast before live availability', fmtInt(data.forecastSessions), fmtPct(data.forecastShare), fmtPct(data.forecastParkingRate)],
    ['Live availability only', fmtInt(data.liveOnlySessions), fmtPct(data.totalSessions ? data.liveOnlySessions / data.totalSessions : null), fmtPct(data.liveOnlyParkingRate)]
  ], [1, 2, 3]);
}

function renderBq9(container, data) {
  if (!data.redirects) {
    empty(container, `No redirects to nearby lots in the last ${data.windowDays} days. They appear when a driver taps Navigate in No campus spots.`);
    return;
  }
  stats(container, [
    { label: 'Drivers sent to nearby lots', value: fmtInt(data.redirects), note: `last ${data.windowDays} days, ${fmtInt(data.byLot.length)} lots` },
    { label: 'Answered "Did you park here?"', value: fmtPct(data.answerRate), note: `${fmtInt(data.answers)} answers` },
    { label: 'Parked among the answers', value: fmtPct(data.parkedShare), note: `${fmtInt(data.parked)} drivers confirmed it` }
  ]);
  const split = h('div', { class: 'split' });
  container.append(split);
  hbars(block(split, 'Drivers sent to each lot'), data.byLot.map(lot => ({
    label: lot.name, value: lot.redirects, note: lot.estimatedDrivers === null ? 'no answers yet' : `about ${fmtInt(lot.estimatedDrivers)} parked there`
  })), { valueLabel: 'redirects' });
  hbars(block(split, 'Share that parked, among the answers'), data.byLot.map(lot => ({
    label: lot.name, value: lot.parkedShare ?? 0, note: `${fmtInt(lot.answers)} answers`
  })), { format: value => fmtPct(value), max: 1, valueLabel: 'parked' });
  const hours = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);
  const series = data.byLot.map((lot, index) => ({
    name: lot.name,
    color: css(`--series-${(index % 3) + 1}`),
    values: hours.map(hour => data.byLotHour.find(row => row.lotId === lot.lotId && row.hour === hour)?.redirects ?? 0)
  }));
  const trend = block(container, 'Redirects by hour of the redirect (Bogotá time)');
  legend(trend, series.map(item => ({ label: item.name, color: item.color })), 'line');
  lines(trend, hours, series, { integer: true });
  const names = new Map(data.byLot.map(lot => [lot.lotId, lot.name]));
  tableView(container, ['Lot', 'Hour', 'Redirects', 'Answers', 'Parked', 'Share parked'],
    data.byLotHour.map(row => [names.get(row.lotId) ?? row.lotId, row.hour, fmtInt(row.redirects), fmtInt(row.answers), fmtInt(row.parked), fmtPct(row.parkedShare)]), [2, 3, 4, 5]);
}

function renderBq10(container, data) {
  if (!data.overall.samples && !data.forecastViews.total) {
    empty(container, `No snapshots with a prediction or forecast_viewed events in the last ${data.windowDays} days yet.`);
    return;
  }
  const worst = [...data.byLevel].sort((a, b) => b.meanAbsError - a.meanAbsError)[0];
  stats(container, [
    { label: 'Forecast views', value: fmtInt(data.forecastViews.total), note: `last ${data.windowDays} days` },
    { label: 'Mean absolute error', value: fmtPct(data.overall.meanAbsError, 1), note: `${fmtInt(data.overall.samples)} snapshots compared` },
    { label: 'Least accurate level', value: worst ? worst.level : '–', note: worst ? `${fmtPct(worst.meanAbsError, 1)} average error` : 'No predictions to compare' }
  ]);
  if (!data.byLevel.length) {
    empty(container, 'No snapshot in this window has history from the previous 28 days to predict it.');
  } else {
    const split = h('div', { class: 'split' });
    container.append(split);
    const comparison = block(split, 'Predicted versus real occupancy');
    legend(comparison, [{ label: 'Predicted', color: css('--series-1') }, { label: 'Real', color: css('--series-2') }]);
    hbars(comparison, data.byLevel.flatMap(row => [
      { label: `${row.level} predicted`, value: row.predictedAvg, color: css('--series-1'), note: `${fmtInt(row.samples)} snapshots` },
      { label: `${row.level} real`, value: row.realAvg, color: css('--series-2'), note: `${fmtInt(row.samples)} snapshots` }
    ]), { format: value => fmtPct(value), max: 1, valueLabel: 'average occupancy' });
    const maxError = Math.max(...data.byLevel.map(row => row.meanAbsError));
    hbars(block(split, 'Mean absolute error by level'), data.byLevel.map(row => ({ label: row.level, value: row.meanAbsError, color: levelColor(row.level), note: `${fmtInt(row.samples)} snapshots` })),
      { format: value => fmtPct(value, 1), max: Math.min(1, niceMax(maxError || 0.1)), valueLabel: 'average error' });
  }
  tableView(container, ['Level', 'Snapshots', 'Predicted', 'Real', 'Mean abs. error'],
    data.byLevel.map(row => [row.level, fmtInt(row.samples), fmtPct(row.predictedAvg, 1), fmtPct(row.realAvg, 1), fmtPct(row.meanAbsError, 1)]), [1, 2, 3, 4]);
  if (data.forecastViews.byPlatform.length) {
    tableView(container, ['Platform', 'Forecast views'], data.forecastViews.byPlatform.map(row => [row.platform, fmtInt(row.views)]), [1]);
  }
}

// ---------------------------------------------------------------- BQ12: special spot availability

function renderBq12(container, data) {
  if (!data.levels?.length) {
    empty(container, 'No parking levels or special-spot snapshots available yet.');
    return;
  }

  stats(container, [
    {
      label: 'Analysis period',
      value: `${data.period.days} days`,
      note: `${data.intervalMinutes}-minute intervals`
    },
    {
      label: 'Parking levels',
      value: fmtInt(data.levels.length)
    }
  ]);

  for (const level of data.levels) {
    const slots = level.slots ?? [];
    const area = block(container, `Level ${level.code}`);

    const series = [
      {
        name: 'Accessible availability',
        color: css('--series-1'),
        values: slots.map(slot => slot.accessibleAvailability)
      },
      {
        name: 'EV availability',
        color: css('--series-2'),
        values: slots.map(slot => slot.evAvailability)
      }
    ];

    legend(
      area,
      series.map(item => ({
        label: item.name,
        color: item.color
      })),
      'line'
    );

    lines(
      area,
      slots.map(slot => slot.slot),
      series,
      {
        format: fmtAvailability,
        yMax: 100
      }
    );

    tableView(
      area,
      [
        'Time slot',
        'Accessible availability',
        'Accessible snapshots',
        'EV availability',
        'EV snapshots'
      ],
      slots.map(slot => [
        slot.slot,
        fmtAvailability(slot.accessibleAvailability),
        fmtInt(slot.accessibleSamples),
        fmtAvailability(slot.evAvailability),
        fmtInt(slot.evSamples)
      ]),
      [1, 2, 3, 4]
    );
  }
}

function renderBq1(container, rows) {
  if (!rows.length) {
    empty(container, 'No map_loaded events yet.');
    return;
  }
  const byLevel = LEVELS.map(level => {
    const items = rows.filter(row => row.levelCode === level);
    const loads = sum(items.map(row => row.loads));
    const timed = items.filter(row => row.avgMs !== null);
    const timedLoads = sum(timed.map(row => row.loads));
    return {
      level,
      loads,
      avgMs: timedLoads ? sum(timed.map(row => row.avgMs * row.loads)) / timedLoads : null,
      failureRate: loads ? sum(items.map(row => row.failureRate * row.loads)) / loads : null
    };
  }).filter(row => row.loads > 0);
  const split = h('div', { class: 'split' });
  container.append(split);
  hbars(block(split, 'Average load time by level'), byLevel.map(row => ({ label: row.level, value: row.avgMs ?? 0, color: levelColor(row.level), note: `${fmtInt(row.loads)} loads` })), { format: fmtMs, valueLabel: 'average' });
  const maxRate = Math.max(...byLevel.map(row => row.failureRate ?? 0));
  hbars(block(split, 'Failed loads by level'), byLevel.map(row => ({ label: row.level, value: row.failureRate ?? 0, color: levelColor(row.level), note: `${fmtInt(row.loads)} loads` })), { format: value => fmtPct(value), max: Math.min(1, niceMax(maxRate || 0.1)), valueLabel: 'failed' });
  const top = [...rows].sort((a, b) => b.loads - a.loads).slice(0, 8);
  const devices = block(container, rows.length > 8 ? `By device, OS and level (top 8 of ${rows.length})` : 'By device, OS and level');
  table(devices, ['Device', 'OS', 'Level', 'Loads', 'Average', 'P90', 'Failed'],
    top.map(row => [row.deviceModel, row.osVersion, row.levelCode, fmtInt(row.loads), fmtMs(row.avgMs), fmtMs(row.p90Ms), fmtPct(row.failureRate)]), [3, 4, 5, 6]);
}

function renderBq2(container, data) {
  if (!data.views) {
    empty(container, 'No walking_time_viewed events yet.');
    return;
  }
  stats(container, [
    { label: 'Times a walking time was viewed', value: fmtInt(data.views) },
    { label: 'Average walk', value: fmtMin(data.averageMinutes), note: 'from the spot to the destination' }
  ]);
  const levels = Object.entries(data.byLevel).sort(([a], [b]) => a.localeCompare(b));
  hbars(block(container, 'Average walking minutes by level'), levels.map(([level, row]) => ({ label: level, value: row.averageMinutes, color: levelColor(level), note: `${fmtInt(row.views)} views` })), { format: fmtMin, valueLabel: 'average walk' });
}

function renderBq3(container, data) {
  if (!data.activeUsers) {
    empty(container, `No active users in ${data.month} yet. app_opened must be sent with the session token.`);
    return;
  }
  const filters = Object.entries(data.filters);
  const mostUsed = [...filters].sort((a, b) => b[1].uses - a[1].uses)[0];
  stats(container, [
    { label: `Active users in ${data.month}`, value: fmtInt(data.activeUsers) },
    { label: 'Most used filter', value: mostUsed[1].uses ? mostUsed[0] : '–', note: mostUsed[1].uses ? `${fmtInt(mostUsed[1].uses)} uses` : 'No filter used yet' }
  ]);
  hbars(block(container, 'Share of active users who never used each filter'),
    filters.map(([name, row]) => ({ label: name, value: (row.percentNeverUsed ?? 0) / 100, note: `${fmtInt(row.uses)} uses` })),
    { format: value => fmtPct(value), max: 1, valueLabel: 'never used it' });
  tableView(container, ['Filter', 'Uses', 'Uses per active user', 'Never used'],
    filters.map(([name, row]) => [name, fmtInt(row.uses), row.usesPerActiveUser ?? '–', row.percentNeverUsed === null ? '–' : `${row.percentNeverUsed}%`]), [1, 2, 3]);
}

function renderBq6(container, data) {
  if (!data.usersWithAdvice) {
    empty(container, `No user has ${data.minReservations} finished reservations yet (${fmtInt(data.usersWithoutEnoughTrips)} users are on their way).`);
    return;
  }
  stats(container, [
    { label: 'Users with personal advice', value: fmtInt(data.usersWithAdvice), note: `${fmtInt(data.usersWithoutEnoughTrips)} still need more trips` },
    { label: 'Median trip (80th percentile)', value: fmtMin(data.medianP80TravelMinutes), note: `hold lasts ${data.holdMinutes} min` },
    { label: 'Reservations that expired', value: fmtPct(data.expiredShare) }
  ]);
  hbars(block(container, 'When users are told to reserve'), data.buckets.map(bucket => ({ label: bucket.label, value: bucket.users })), { valueLabel: 'users' });
}

function renderBq4(container, data) {
  if (!data.total) {
    empty(container, 'No unmet demand recorded. It appears when every level is full and a user asks for availability.');
    return;
  }
  const order = [1, 2, 3, 4, 5, 6, 0];
  const hours = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
  const matrix = order.map(() => hours.map(() => 0));
  const zones = new Map();
  for (const row of data.rows) {
    const hour = Number(row.slot.slice(0, 2));
    matrix[order.indexOf(row.weekday)][hour] += row.count;
    zones.set(row.zone, (zones.get(row.zone) ?? 0) + row.count);
  }
  let peak = { row: 0, col: 0, value: -1 };
  matrix.forEach((cols, row) => cols.forEach((value, col) => { if (value > peak.value) peak = { row, col, value }; }));
  stats(container, [
    { label: 'Queries without a free spot', value: fmtInt(data.total) },
    { label: 'Peak hour', value: `${SHORT_DAYS[order[peak.row]]} ${hours[peak.col]}:00`, note: `${fmtInt(peak.value)} queries` },
    { label: 'Origin zones', value: fmtInt(zones.size), note: 'rounded to about 1 km' }
  ]);
  const split = h('div', { class: 'split' });
  container.append(split);
  heatmap(block(split, 'Queries by weekday and hour (Bogotá time)'), order.map(day => SHORT_DAYS[day]), hours, matrix,
    { rowTitle: label => WEEKDAYS[SHORT_DAYS.indexOf(label)], colTitle: hour => `${hour}:00` });
  const zoneBlock = block(split, 'Top origin zones');
  table(zoneBlock, ['Zone', 'Queries'], [...zones.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([zone, count]) => [zone, fmtInt(count)]), [1]);
}

function renderBq5(container, data) {
  const rows = data.rows.filter(row => row.total.created > 0);
  if (!rows.length) {
    empty(container, 'No reservations in the last 28 days.');
    return;
  }
  const created = sum(rows.map(row => row.total.created));
  const expired = sum(rows.map(row => row.total.expired));
  stats(container, [
    { label: 'Reservations analysed', value: fmtInt(created), note: `last ${data.windowDays} days, users and simulation` },
    { label: 'No-show rate', value: fmtPct(created ? expired / created : null, 1), note: 'reservations that expired' },
    { label: 'Current hold', value: fmtMin(data.holdMinutes) }
  ]);
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  const series = LEVELS.map(level => ({
    name: level,
    color: levelColor(level),
    values: hours.map(hour => {
      const items = rows.filter(row => row.levelCode === level && Number(row.slot.slice(0, 2)) === hour);
      const total = sum(items.map(row => row.total.created));
      return total ? sum(items.map(row => row.total.expired)) / total : null;
    })
  })).filter(item => item.values.some(value => value !== null));
  const trend = block(container, 'No-show rate by hour of day');
  legend(trend, series.map(item => ({ label: item.name, color: item.color })), 'line');
  lines(trend, hours.map(hour => `${String(hour).padStart(2, '0')}:00`), series, { format: value => fmtPct(value), yMax: Math.min(1, niceMax(Math.max(0.05, ...series.flatMap(item => item.values.filter(v => v !== null))))) });
  const top = [...rows].sort((a, b) => b.total.created - a.total.created).slice(0, 8);
  const policy = block(container, 'Busiest slots and their recommended policy');
  table(policy, ['Level', 'Slot', 'Reservations', 'No-show', 'P90 check-in', 'Window', 'Spots to hold'],
    top.map(row => [row.levelCode, row.slot, fmtInt(row.total.created), fmtPct(row.total.noShowRate), fmtMin(row.total.p90CheckInMinutes), fmtMin(row.total.recommendedWindowMinutes), fmtInt(row.total.heldSpots)]), [2, 3, 4, 5, 6]);
}

// ---------------------------------------------------------------- render, load, session

const SECTIONS = [
  ['bq7', summary => summary.conversionFunnel, renderBq7],
  ['bq8', summary => summary.predictionUsage, renderBq8],
  ['bq9', summary => summary.redirectValue, renderBq9],
  ['bq10', summary => summary.predictionAccuracy, renderBq10],
  ['bq12', summary => summary.specialAvailability, renderBq12],
  ['bq1', summary => summary.mapLoad, renderBq1],
  ['bq2', summary => summary.walkingTime, renderBq2],
  ['bq3', summary => summary.filterUsage, renderBq3],
  ['bq6', summary => summary.leadTime, renderBq6],
  ['bq4', summary => summary.unmetDemand, renderBq4],
  ['bq5', summary => summary.reservationPolicy, renderBq5]
];

function render(summary) {
  resizer.disconnect();
  hideTip();
  try { renderKpis(summary); } catch (error) { console.error(error); }
  for (const [id, pick, draw] of SECTIONS) {
    const container = $(id);
    container.replaceChildren();
    const data = pick(summary);
    if (data === undefined) {
      empty(container, 'This section is not in the analytics summary of the deployed backend yet.');
      continue;
    }
    try { draw(container, data); } catch (error) {
      console.error(error);
      container.replaceChildren();
      empty(container, 'This question could not be drawn. The rest of the dashboard is up to date.');
    }
  }
  const time = new Date(summary.generatedAt);
  $('updated').textContent = `Updated ${time.toLocaleTimeString('en-GB')}`;
}

async function load() {
  if (!token) return showLogin();
  const board = $('board');
  board.classList.add('loading');
  try {
    const response = await fetch(`${API}/analytics/summary`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (response.status === 401) {
      signOut('Your session expired. Sign in again.');
      return;
    }
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    lastSummary = await response.json();
    render(lastSummary);
    $('board-error').hidden = true;
  } catch (error) {
    const reason = error instanceof TypeError ? 'the server could not be reached' : error.message;
    $('board-error').textContent = lastSummary
      ? `Could not refresh: ${reason}. Showing the data from ${new Date(lastSummary.generatedAt).toLocaleTimeString('en-GB')}.`
      : `Could not load the dashboard: ${reason}. A free Render instance can take up to a minute to wake up, press Refresh in a moment.`;
    $('board-error').hidden = false;
  } finally {
    board.classList.remove('loading');
  }
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if ($('auto').checked && token) timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
}

function showLogin(message = '') {
  clearInterval(timer);
  $('board').hidden = true;
  $('controls').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = message;
  $('email').focus();
}

function showBoard() {
  $('login').hidden = true;
  $('board').hidden = false;
  $('controls').hidden = false;
  schedule();
}

function signOut(message = '') {
  token = null;
  lastSummary = null;
  storage.clear();
  showLogin(message);
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('login-submit');
  submit.disabled = true;
  $('login-error').textContent = '';
  try {
    const response = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const messages = { 400: 'Write a valid email and the password.', 401: 'Wrong email or password.', 429: 'Too many attempts. Wait a minute and try again.' };
      throw new Error(messages[response.status] ?? `The server answered ${response.status}.`);
    }
    token = body.token;
    storage.set(token);
    $('password').value = '';
    showBoard();
    await load();
  } catch (error) {
    $('login-error').textContent = error instanceof TypeError ? 'Could not reach the server. Check the connection and try again.' : error.message;
  } finally {
    submit.disabled = false;
  }
});

$('refresh').addEventListener('click', load);
$('auto').addEventListener('change', schedule);
$('signout').addEventListener('click', () => signOut());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && token && $('auto').checked) load(); });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (lastSummary) render(lastSummary); });

if (token) {
  showBoard();
  load();
} else {
  showLogin();
}
