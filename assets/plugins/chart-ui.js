/**
 * What every chart window does besides drawing: a tooltip, a legend, saving the picture, and
 * the keys that do what a pointer does.
 *
 * The charts in chart-d3.js draw marks and report what the pointer or the keyboard landed on;
 * this module is where that becomes something on screen. It is shared so the eleven charts
 * behave as one: the same tooltip, the same legend, the same keys.
 *
 * Only `tooltip`, `legend`, `save` and `svgMarkup` touch the DOM. `keyFor` is pure and is how
 * the window decides what a key means, which the plugin check reads without a browser.
 */

/**
 * The keys, and what each one does. Escape is listed first because it is the one that undoes
 * everything else; the window says these in its footer.
 */
export const KEYS = [
  ['Esc', 'back'],
  ['← →', 'step through periods'],
  ['+ − 0', 'zoom in, out, reset'],
  ['Tab, Enter', 'reach and open a mark'],
  ['s', 'save SVG'],
  ['p', 'save PNG'],
];

/** What a key press asks for, or null when the window should leave it to the browser. */
export function keyFor(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case 'Escape': return 'back';
    case 'ArrowLeft': return 'previous';
    case 'ArrowRight': return 'next';
    case '+': case '=': return 'zoom-in';
    case '-': case '_': return 'zoom-out';
    case '0': return 'reset';
    case 's': case 'S': return 'save-svg';
    case 'p': case 'P': return 'save-png';
    default: return null;
  }
}

/**
 * The tooltip: one element, moved to whatever is being pointed at or focused.
 *
 * Content is a title and rows of (colour, label, value), always built with textContent, so an
 * account name can never become markup. It is positioned inside the chart's frame and flipped
 * to the other side of the pointer near an edge, so it is never cut off by the window.
 */
export function tooltip(frame, colors) {
  const element = frame.ownerDocument.createElement('div');
  element.className = 'tip';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.hidden = true;
  Object.assign(element.style, {
    position: 'absolute',
    pointerEvents: 'none',
    background: colors.foreground,
    color: colors.background,
    padding: '6px 9px',
    borderRadius: '4px',
    font: '12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif',
    whiteSpace: 'nowrap',
    zIndex: '2',
    maxWidth: '420px',
  });
  frame.appendChild(element);

  return {
    show({ title, rows = [] }, x, y) {
      element.replaceChildren();
      if (title) {
        const heading = frame.ownerDocument.createElement('div');
        heading.textContent = title;
        heading.style.fontWeight = '600';
        element.appendChild(heading);
      }
      for (const row of rows) {
        const line = frame.ownerDocument.createElement('div');
        line.style.display = 'flex';
        line.style.gap = '10px';
        line.style.justifyContent = 'space-between';
        const name = frame.ownerDocument.createElement('span');
        if (row.colour) {
          const swatch = frame.ownerDocument.createElement('span');
          Object.assign(swatch.style, {
            display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
            background: row.colour, marginRight: '6px', verticalAlign: 'baseline',
            boxShadow: `0 0 0 1px ${colors.background}`,
          });
          name.appendChild(swatch);
        }
        name.appendChild(frame.ownerDocument.createTextNode(row.label));
        line.appendChild(name);
        if (row.value !== undefined) {
          const value = frame.ownerDocument.createElement('span');
          value.textContent = row.value;
          value.style.fontVariantNumeric = 'tabular-nums';
          line.appendChild(value);
        }
        element.appendChild(line);
      }
      element.hidden = false;
      const box = frame.getBoundingClientRect();
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const left = x + 14 + width > box.width ? x - 14 - width : x + 14;
      const top = Math.min(Math.max(0, y - height / 2), Math.max(0, box.height - height));
      element.style.left = `${Math.max(0, left)}px`;
      element.style.top = `${top}px`;
    },
    hide() {
      element.hidden = true;
    },
  };
}

/**
 * The legend: one entry per series, each one a switch.
 *
 * Clicking an entry, or Enter or Space on it, hides that series and redraws; the chart rescales
 * to what is left, which is the reason to hide one. An entry is a list item with a switch role
 * rather than a button: it is part of the chart, and the window has no controls of its own.
 */
export function legend(container, items, hidden, onToggle, colors) {
  container.replaceChildren();
  if (!items || items.length <= 1) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const list = container.ownerDocument.createElement('ul');
  list.className = 'legend';
  for (const item of items) {
    const entry = container.ownerDocument.createElement('li');
    const off = hidden.has(item.label);
    entry.setAttribute('role', 'switch');
    entry.setAttribute('aria-checked', off ? 'false' : 'true');
    entry.tabIndex = 0;
    entry.title = off ? `show ${item.label}` : `hide ${item.label}`;
    const swatch = container.ownerDocument.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = off ? 'transparent' : item.colour;
    swatch.style.boxShadow = `inset 0 0 0 1.5px ${item.colour}`;
    entry.appendChild(swatch);
    entry.appendChild(container.ownerDocument.createTextNode(item.label));
    if (off) {
      entry.style.color = colors.dim;
      entry.style.textDecoration = 'line-through';
    }
    const toggle = () => onToggle(item.label);
    entry.addEventListener('click', toggle);
    entry.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
    list.appendChild(entry);
  }
  container.appendChild(list);
}

/**
 * Where a saved picture's header puts the title, the subtitle and the legend.
 *
 * A chart saved on its own has lost the page around it, so the header carries what the page
 * said: what this is, over what, and which colour is which. Entries flow left to right and wrap,
 * measured at the 11px the charts use. Pure, so the check can see what a picture will say.
 */
export function header({ width, title, subtitle = '', items = [], pad = 20 }) {
  const lines = [{ text: title, x: pad, y: pad + 16, size: 17, weight: 600, role: 'title' }];
  let y = pad + 16;
  if (subtitle) {
    y += 20;
    lines.push({ text: subtitle, x: pad, y, size: 12, weight: 400, role: 'subtitle' });
  }
  const entries = [];
  if (items.length > 1) {
    y += 24;
    let x = pad;
    for (const item of items) {
      const span = 18 + item.label.length * 6.4 + 16;
      if (x > pad && x + span > width - pad) {
        x = pad;
        y += 18;
      }
      entries.push({ label: item.label, colour: item.colour, x, y });
      x += span;
    }
  }
  return { lines, entries, height: y + 16 };
}

/**
 * The chart as a standalone SVG document: a header, then the chart as it is on screen.
 *
 * Everything the picture needs is on the elements already (the charts set attributes, not CSS),
 * so the additions are the header, a background, a font, and the namespace a file needs to open.
 * Hidden series are left out of the legend, as they are out of the chart.
 */
export function svgMarkup(svg, colors, title, { subtitle = '', items = [] } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const document = svg.ownerDocument;
  const width = Number(svg.getAttribute('width')) || svg.clientWidth;
  const height = Number(svg.getAttribute('height')) || svg.clientHeight;
  const pad = 20;
  const top = header({ width: width + 2 * pad, title, subtitle, items, pad });

  const outer = document.createElementNS(ns, 'svg');
  const total = { width: width + 2 * pad, height: top.height + height + pad };
  outer.setAttribute('xmlns', ns);
  outer.setAttribute('width', String(total.width));
  outer.setAttribute('height', String(total.height));
  outer.setAttribute('viewBox', `0 0 ${total.width} ${total.height}`);
  outer.setAttribute('font-family', 'system-ui, -apple-system, "Segoe UI", sans-serif');
  const make = (name, attributes, text) => {
    const node = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    outer.appendChild(node);
    return node;
  };
  make('title', {}, title);
  make('rect', { width: '100%', height: '100%', fill: colors.background });
  for (const line of top.lines) {
    make('text', {
      x: line.x, y: line.y, 'font-size': line.size, 'font-weight': line.weight,
      fill: line.role === 'title' ? colors.foreground : colors.dim,
    }, line.text);
  }
  for (const entry of top.entries) {
    make('circle', { cx: entry.x + 5, cy: entry.y - 4, r: 5, fill: entry.colour });
    make('text', { x: entry.x + 16, y: entry.y, 'font-size': 11, fill: colors.foreground }, entry.label);
  }

  const chart = svg.cloneNode(true);
  chart.removeAttribute('class');
  chart.removeAttribute('style');
  chart.removeAttribute('id');
  chart.setAttribute('x', String(pad));
  chart.setAttribute('y', String(top.height));
  chart.setAttribute('width', String(width));
  chart.setAttribute('height', String(height));
  chart.setAttribute('overflow', 'visible');
  // Interaction-only layers have no meaning in a picture.
  for (const node of chart.querySelectorAll('[data-transient]')) node.remove();
  outer.appendChild(chart);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(outer)}`;
}

/** A file name from a chart title: "hledger-where-the-money-went.svg". */
export function fileName(title, extension) {
  const slug = String(title || 'chart')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'chart';
  return `hledger-${slug}.${extension}`;
}

/** Save the chart, as SVG or as a PNG at twice the size on screen. */
export async function save(svg, colors, title, format, extras = {}) {
  const markup = svgMarkup(svg, colors, title, extras);
  const document = svg.ownerDocument;
  const download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  if (format === 'svg') {
    download(new Blob([markup], { type: 'image/svg+xml' }), fileName(title, 'svg'));
    return;
  }
  // The picture's own size, header included, read back from what was written.
  const [, width, height] = markup.match(/<svg[^>]*?width="([\d.]+)"[^>]*?height="([\d.]+)"/).map(Number);
  const image = new Image();
  const source = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('the chart could not be drawn as an image'));
    image.src = source;
  });
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext('2d');
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, width, height);
  URL.revokeObjectURL(source);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the browser would not make a PNG of the chart');
  download(blob, fileName(title, 'png'));
}
