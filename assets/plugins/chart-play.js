/**
 * A chart played period by period: `chart --animate treemap -p 2026 expenses`.
 *
 * hledger is asked once, for every period (`-M` unless the query names an interval). Each frame
 * is the report at one period, or part of the way between two: every account's amount is eased
 * from one period's value to the next, and the chart is drawn from those numbers by the same
 * renderer that draws it still. So any chart that draws one period can be played, and what is
 * on screen at a whole period is exactly what the static chart of that period would show.
 *
 * Kept steady from frame to frame, so the eye follows change rather than reshuffling: a
 * Sankey's nodes and a pie's slices keep one order, the largest over the whole range first; a
 * treemap's and a sunburst's colours belong to their branch; and the picture is drawn to one
 * scale, so a month with half the spending is half the area, not the same area again. A bar race
 * is the exception on purpose: its bars swap places as they overtake, gliding between ranks.
 *
 * `timeline` and everything it returns are pure and tested in node; `player` is the DOM half:
 * the clock, the timeline under the chart, and the keys.
 */

import { counted, format, palette, percent, seriesTotal, shape, trimmed } from './chart-data.js';
import { flows, foldFlows, headlineFor, leafTotal, tableFor, treeAt } from './chart-d3.js';

/** How long a step from one period to the next takes, and how long each period is held. */
export const MOVE = 900;
export const HOLD = 500;

/** The ease of a step: slow out of a period, slow into the next. */
export function ease(t) {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped < 0.5 ? 4 * clamped ** 3 : 1 - (-2 * clamped + 2) ** 3 / 2;
}

/**
 * Where the clock is after `elapsed` milliseconds of playing from period `from`: each period is
 * held, then eased into the next. With reduced motion there is no easing, only the hold.
 */
export function positionAt(elapsed, from, last, { reduced = false } = {}) {
  const step = HOLD + (reduced ? 0 : MOVE);
  const done = Math.floor(elapsed / step);
  const index = from + done;
  if (index >= last) return last;
  const into = elapsed - done * step;
  if (reduced || into <= HOLD) return index;
  return index + ease((into - HOLD) / MOVE);
}

/** A value part of the way from one period to the next. */
function valueAt(amounts, position) {
  const low = Math.max(0, Math.min(amounts.length - 1, Math.floor(position)));
  const high = Math.min(amounts.length - 1, low + 1);
  const t = Math.max(0, Math.min(1, position - low));
  const a = amounts[low] ? amounts[low].value : 0;
  const b = amounts[high] ? amounts[high].value : 0;
  return a + (b - a) * t;
}

/** A balance report reduced to one period, or a frame between two. */
export function periodOf(report, position) {
  const at = Math.round(position);
  return {
    periods: [report.periods[Math.max(0, Math.min(report.periods.length - 1, at))]],
    series: report.series.map((entry) => {
      const sample = entry.amounts[0] || {};
      return { label: entry.label, amounts: [{ value: valueAt(entry.amounts, position), prefix: sample.prefix || '', suffix: sample.suffix || '', raw: 'x' }] };
    }),
    unit: report.unit,
    others: report.others,
  };
}

/** A tree whose rows are each a running total, for --cumulative. */
function runningTree(series) {
  return {
    ...series,
    rows: series.rows.map((row) => {
      let running = 0;
      return { ...row, amounts: row.amounts.map((amount) => ({ ...amount, value: (running += amount.value) })) };
    }),
  };
}

/**
 * Everything an animated chart needs, for a kind and the report hledger returned:
 * `periods`, and `frame(position)`, which is the renderer to draw with and its data. Whole
 * numbers are periods; anything between is a frame on the way.
 */
/**
 * A tree without the empty periods at either end: `-p 2026` includes months still to come, and
 * an animation that plays on into nothing ends on an empty chart.
 */
export function trimmedTree(series) {
  const empty = (at) => series.rows.every((row) => !row.amounts[at] || row.amounts[at].value === 0);
  let first = 0;
  let last = series.periods.length - 1;
  while (first < last && empty(first)) first += 1;
  while (last > first && empty(last)) last -= 1;
  return {
    ...series,
    periods: series.periods.slice(first, last + 1),
    rows: series.rows.map((row) => ({ ...row, amounts: row.amounts.slice(first, last + 1) })),
  };
}

export function timeline(kind, given, options = {}, colors) {
  const report = given.rows ? trimmedTree(given) : trimmed(given);
  if (kind === 'treemap' || kind === 'sunburst') {
    const series = options.cumulative ? runningTree(report) : report;
    const totals = series.periods.map((_, at) => leafTotal(treeAt(series, at).rows));
    const largest = Math.max(...totals, 0) || 1;
    return {
      periods: series.periods,
      frame(position) {
        const data = treeAt(series, position);
        return { draw: kind, data: { ...data, fill: data.total / largest }, kind };
      },
      words(at) {
        const data = treeAt(series, at);
        // The table lists what this period held; an account empty in it is left off, as it is
        // from the picture, rather than a column of zeros.
        const held = { ...data, rows: data.rows.filter((row) => row.amount.value !== 0) };
        return { sub: headlineFor('treemap', data), table: tableFor('treemap', held.rows.length ? held : data) };
      },
    };
  }

  const shaped = shape(report, { cumulative: options.cumulative, invert: options.invert });

  if (kind === 'sankey') {
    // One order for every frame, from the whole range, and the same twelve categories kept.
    const whole = flows({ ...shaped, periods: ['all'], series: shaped.series.map((entry) => ({ label: entry.label, amounts: [{ value: seriesTotal(entry).value }] })) });
    const order = { sources: whole.sources.map((node) => node.account), sinks: whole.sinks.map((node) => node.account) };
    const top = options.top || 12;
    const at = (position) => foldFlows(flows(periodOf(shaped, position), order), top);
    const frames = shaped.periods.map((_, index) => at(index));
    const fixed = {
      total: Math.max(...frames.map((data) => data.total), 0) || 1,
      count: Math.max(...frames.map((data) => Math.max(data.sources.length, data.sinks.length)), 1),
    };
    return {
      periods: shaped.periods,
      others: whole.others,
      frame(position) {
        return { draw: 'sankey', data: { ...at(position), fixed }, kind };
      },
      words(index) {
        const data = frames[index];
        return { sub: headlineFor('sankey', data), table: tableFor('sankey', data) };
      },
      height: Math.min(900, Math.max(300, fixed.count * 46 + 40)),
    };
  }

  // A bar race and a pie: one row per account, the largest over the whole range first.
  const overall = [...shaped.series].sort((left, right) => Math.abs(seriesTotal(right).value) - Math.abs(seriesTotal(left).value));
  const colours = palette(colors, overall.length);
  const colourOf = new Map(overall.map((entry, index) => [entry.label, colours[index]]));
  const unit = shaped.unit;

  if (kind === 'pie') {
    const top = options.top || 8;
    const kept = overall.slice(0, top).map((entry) => entry.label);
    const ordered = options.sort === 'name' ? [...kept].sort() : kept;
    const rowsAt = (position) => {
      const single = periodOf(shaped, position);
      const value = (label) => Math.max(0, single.series.find((entry) => entry.label === label).amounts[0].value);
      const rows = ordered.map((label) => ({ label, value: value(label), colour: colourOf.get(label) }));
      const rest = single.series.filter((entry) => !kept.includes(entry.label));
      if (rest.length) rows.push({ label: `other (${rest.length})`, value: rest.reduce((sum, entry) => sum + Math.max(0, entry.amounts[0].value), 0), colour: colors.dim, other: true });
      const total = rows.reduce((sum, row) => sum + row.value, 0);
      return { type: 'doughnut', unit, drillable: true, total, rows: rows.map((row) => ({ ...row, share: total ? row.value / total : 0, shareText: percent(row.value, total) })) };
    };
    return {
      periods: shaped.periods,
      frame: (position) => ({ draw: 'doughnut', data: rowsAt(position), kind }),
      words(index) {
        const data = rowsAt(index);
        return { sub: `${counted(data.rows.length, 'slice')}, ${format({ value: data.total, ...unit })}`, table: rowTable(data.rows, unit) };
      },
    };
  }

  // The race: every account has a rank in each period, and between two periods it glides from
  // one rank to the other while its bar grows or shrinks.
  const slots = Math.min(options.top || 12, overall.length);
  const rankIn = shaped.periods.map((_, index) => {
    const single = periodOf(shaped, index);
    const order = [...single.series].sort((left, right) => right.amounts[0].value - left.amounts[0].value);
    return new Map(order.map((entry, rank) => [entry.label, rank]));
  });
  const rowsAt = (position) => {
    const low = Math.max(0, Math.floor(position));
    const high = Math.min(shaped.periods.length - 1, low + 1);
    const t = ease(position - low);
    const single = periodOf(shaped, position);
    const rows = single.series.map((entry) => ({
      label: entry.label,
      value: entry.amounts[0].value,
      colour: colourOf.get(entry.label),
      at: rankIn[low].get(entry.label) + (rankIn[high].get(entry.label) - rankIn[low].get(entry.label)) * t,
    }));
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    return {
      type: 'bar', unit, log: Boolean(options.log), drillable: true, total, race: { slots },
      rows: rows.sort((left, right) => left.at - right.at).map((row) => ({ ...row, shareText: percent(row.value, total) })),
    };
  };
  return {
    periods: shaped.periods,
    frame: (position) => ({ draw: 'bar', data: rowsAt(position), kind }),
    words(index) {
      const data = rowsAt(index);
      const leader = data.rows[0];
      return {
        sub: `${counted(slots, 'place')} of ${counted(overall.length, 'account')}; leading: ${leader.label}, ${format({ value: leader.value, ...unit })}`,
        table: rowTable(data.rows.slice(0, slots), unit),
      };
    },
    height: Math.min(900, Math.max(180, slots * 30 + 50)),
    corner: 'bottom',
  };
}

function rowTable(rows, unit) {
  const escape = (text) => String(text).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
  return `<table><thead><tr><th>Account</th><th class="n">Amount</th></tr></thead><tbody>${rows
    .map((row) => `<tr><td>${escape(row.label)}</td><td class="n">${escape(format({ value: row.value, ...unit }))}</td></tr>`)
    .join('')}</tbody></table>`;
}

// ---------------------------------------------------------------- the DOM half

/**
 * Play a timeline in the chart's frame.
 *
 * `paint(frame, still)` draws a frame; `still` is true at a whole period, when the chart is
 * paused or holding, and that is when its words and table are updated and its marks answer the
 * pointer. Starts playing at once unless the reader asked for reduced motion, in which case it
 * waits for Space. Returns the controls the window's keys call.
 */
export function player({ holder, line, play, paint, onPeriod, document = holder.ownerDocument, reduced = false }) {
  // The period is written large in a corner the chart leaves empty: a race's bars grow from
  // the left and are longest at the top, so its corner is the bottom right.
  const last = play.periods.length - 1;
  const badge = document.createElement('div');
  badge.className = play.corner === 'bottom' ? 'period bottom' : 'period';
  holder.appendChild(badge);
  const scrub = buildTimeline(line, play.periods);
  let position = 0;
  let playing = false;
  let started = 0;
  let from = 0;
  let request = null;
  let announced = -1;

  function show(next) {
    position = Math.max(0, Math.min(last, next));
    const still = Number.isInteger(position);
    paint(play.frame(position), still);
    const near = Math.round(position);
    badge.textContent = play.periods[near];
    scrub.mark(position, playing);
    // The words and the table follow the period nearest the clock, as the badge does.
    if (near !== announced) {
      announced = near;
      onPeriod(near, play.words(near));
    }
  }

  function tick(now) {
    if (!playing) return;
    show(positionAt(now - started, from, last, { reduced }));
    if (position >= last) {
      playing = false;
      scrub.mark(position, false);
      return;
    }
    request = window.requestAnimationFrame(tick);
  }

  const controls = {
    playing: () => playing,
    position: () => position,
    toggle() {
      if (playing) return controls.pause();
      // At the end, playing again starts from the beginning.
      from = position >= last ? 0 : Math.round(position);
      started = window.performance.now();
      playing = true;
      show(from);
      request = window.requestAnimationFrame(tick);
      return true;
    },
    pause() {
      playing = false;
      if (request) window.cancelAnimationFrame(request);
      request = null;
      show(Math.round(position));
      return false;
    },
    step(direction) {
      controls.pause();
      show(Math.round(position) + direction);
    },
    seek(index) {
      controls.pause();
      show(index);
    },
    reset() {
      controls.seek(0);
    },
    redraw() {
      show(position);
    },
    stop() {
      playing = false;
      if (request) window.cancelAnimationFrame(request);
      badge.remove();
      line.replaceChildren();
      line.hidden = true;
    },
  };
  scrub.onSeek((index) => controls.seek(index));
  show(0);
  if (!reduced && last > 0) controls.toggle();
  return controls;
}

/**
 * The timeline under the chart: one tick per period, the ones that fit labelled, and a marker
 * where the clock is. A click on it goes to that period. It is a slider to assistive technology.
 */
function buildTimeline(line, periods) {
  const document = line.ownerDocument;
  line.replaceChildren();
  line.hidden = false;
  line.setAttribute('role', 'slider');
  line.setAttribute('aria-label', 'period');
  line.setAttribute('aria-valuemin', '0');
  line.setAttribute('aria-valuemax', String(periods.length - 1));
  const track = document.createElement('div');
  track.className = 'track';
  const done = document.createElement('div');
  done.className = 'done';
  const knob = document.createElement('div');
  knob.className = 'knob';
  track.append(done, knob);
  const labels = document.createElement('div');
  labels.className = 'labels';
  const every = Math.max(1, Math.ceil(periods.length / 12));
  periods.forEach((period, index) => {
    if (index % every && index !== periods.length - 1) return;
    const label = document.createElement('span');
    label.textContent = period;
    label.style.left = `${periods.length > 1 ? (100 * index) / (periods.length - 1) : 0}%`;
    labels.appendChild(label);
  });
  line.append(track, labels);
  let seek = () => {};
  line.addEventListener('click', (event) => {
    const box = track.getBoundingClientRect();
    const share = Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width)));
    seek(Math.round(share * (periods.length - 1)));
  });
  return {
    onSeek(callback) {
      seek = callback;
    },
    mark(position, playing) {
      const share = periods.length > 1 ? position / (periods.length - 1) : 1;
      done.style.width = `${100 * share}%`;
      knob.style.left = `${100 * share}%`;
      line.setAttribute('aria-valuenow', String(Math.round(position)));
      line.setAttribute('aria-valuetext', `${periods[Math.round(position)]}${playing ? ', playing' : ''}`);
      line.dataset.playing = playing ? 'yes' : 'no';
    },
  };
}
