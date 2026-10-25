/**
 * The chart command's grammar: `chart [chart options] <type> [hledger arguments]`.
 *
 *     chart --log bar -p 2026 coffee
 *           ^^^^^ ^^^ ^^^^^^^^^^^^^^
 *           how   what  which numbers: arguments to hledger, passed as written
 *
 * Chart options shape the picture and come before the type; everything after the type is the
 * query, handed to hledger's report as it was typed, so anything hledger's `balance` takes
 * works (`-p 2026`, `-M`, `--depth 2`, `-H`, account names). Each type adds only what its
 * picture cannot do without, and says so in the command shown under the chart: a monthly split
 * for a chart over time when none was asked for, `--tree` for a treemap, the register for a
 * calendar.
 *
 * Pure, so the plugin, which builds the command, and the window, which builds the next one
 * when a mark or a link is followed, read the same grammar.
 */

/**
 * The types, and what each one asks of hledger.
 *
 * `report` is the command a query is appended to. `split` means the picture is a series over
 * time and needs an interval, monthly unless the query names one. `options` are the chart
 * options that mean something to it; any other is refused rather than silently ignored.
 */
export const TYPES = {
  line: {
    report: 'balance', split: true, options: ['log', 'percent', 'cumulative', 'top', 'sort', 'invert'],
    says: 'one line per account, over time',
  },
  bar: {
    report: 'balance', split: false, options: ['log', 'percent', 'cumulative', 'top', 'sort', 'invert', 'animate'],
    says: 'accounts ranked; with an interval, columns per period; animated, a bar race',
  },
  stacked: {
    report: 'balance', split: true, options: ['percent', 'cumulative', 'top', 'sort', 'invert'],
    says: 'accounts stacked over time',
  },
  stream: {
    report: 'balance', split: true, options: ['cumulative', 'top', 'sort', 'invert'],
    says: 'a streamgraph: accounts flowing around a centre, over time',
  },
  pie: {
    report: 'balance', split: false, options: ['top', 'sort', 'invert', 'cumulative', 'animate'],
    says: 'each account as a share of the whole',
  },
  treemap: {
    report: 'balance --tree', split: false, options: ['cumulative', 'animate'],
    says: 'the account tree as cascaded cards, area by balance',
  },
  pack: {
    report: 'balance --tree', split: false, options: ['cumulative', 'animate'],
    says: 'the account tree as circles inside circles',
  },
  sunburst: {
    report: 'balance --tree', split: false, options: ['cumulative', 'animate'],
    says: 'the account tree in rings, angle by balance',
  },
  sankey: {
    report: 'balance', split: false, options: ['top', 'cumulative', 'animate'],
    says: 'income flowing into spending and savings',
  },
  cashflow: {
    report: 'balance', split: true, options: ['cumulative', 'top'], depth: 2,
    says: 'income up, spending down, and the net, period by period',
  },
  budget: {
    report: 'balance --budget', split: false, options: ['top', 'sort'], account: 'expenses',
    says: 'what was spent against the budget, account by account',
  },
  swarm: {
    report: 'register', split: false, options: ['top'], account: 'expenses',
    says: 'every transaction as a dot in time, sized by its amount',
  },
  histogram: {
    report: 'register', split: false, options: [], account: 'expenses',
    says: 'how many transactions there were of each size',
  },
  heatmap: {
    report: 'balance', split: true, options: ['log', 'percent', 'cumulative', 'top', 'sort', 'invert'],
    says: 'accounts by period, a square each, darker for more',
  },
  bump: {
    report: 'balance', split: true, options: ['cumulative', 'top', 'invert'],
    says: 'the rank of each account, period by period',
  },
  calendar: {
    report: 'register', split: false, options: [],
    says: 'a square per day, darker for more spending',
  },
  waterfall: {
    report: 'register', split: false, options: [],
    says: 'income, a step down per expense category, then net',
  },
  multiples: {
    report: 'balance', split: true, options: ['log', 'percent', 'cumulative', 'top', 'sort', 'invert'],
    says: 'a small line per account',
  },
};

/**
 * The types that draw one period and can be played through every period with --animate, and
 * which of their options only mean something then: a running total needs periods to run over.
 */
export const ANIMATED = ['bar', 'pie', 'treemap', 'sunburst', 'pack', 'sankey'];
const NEEDS_ANIMATE = { cumulative: ['pie', 'treemap', 'sunburst', 'pack', 'sankey'] };

/** Other names a type answers to. */
const ALIASES = {
  doughnut: 'pie', donut: 'pie', area: 'stacked', column: 'bar', columns: 'bar', sparklines: 'multiples', flows: 'sankey',
  streamgraph: 'stream', heat: 'heatmap', rank: 'bump', ranks: 'bump', rings: 'sunburst', race: 'bar',
  beeswarm: 'swarm', circles: 'pack', bubbles: 'pack', bullet: 'budget', distribution: 'histogram', 'cash-flow': 'cashflow',
};

/** The chart options, what each one does, and whether it takes a value. */
export const OPTIONS = {
  log: { takes: null, says: 'a logarithmic value axis, for amounts of very different sizes' },
  percent: { takes: null, says: 'each period as shares of its total' },
  cumulative: { takes: null, says: 'a running total across the periods' },
  top: { takes: 'N', says: 'the N largest accounts, and the rest as other' },
  sort: { takes: 'name|value', says: 'order by name, or by size, which is the default' },
  invert: { takes: null, says: 'flip the sign, so income and liabilities read as positive' },
  animate: { takes: null, says: 'play the chart period by period: Space plays and pauses, the arrows step' },
};

/** hledger's interval flags: a chart over time adds -M only when none of these is there. */
const INTERVAL_FLAGS = ['-D', '--daily', '-W', '--weekly', '-M', '--monthly', '-Q', '--quarterly', '-Y', '--yearly'];

/** hledger's flags that take the next word as their value. */
const VALUED_FLAGS = [
  '-p', '--period', '-b', '--begin', '-e', '--end', '--depth', '--pivot', '-O', '--output-format',
  '-X', '--exchange', '--value', '--format', '--alias',
];

/**
 * The words of a line, the way the app's terminal splits them, which is the way a shell does:
 * `-p "last year" food` is three words. Both quote styles are removed. Outside quotes a
 * backslash escapes the next character; inside double quotes it escapes `"` and `\` and is
 * otherwise kept; single quotes are literal. The two must agree, because a line the window
 * writes is split again by the app before hledger sees it.
 */
export function tokenize(text) {
  const words = [];
  let word = '';
  let quote = null;
  let started = false;
  const characters = [...String(text == null ? '' : text)];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      else word += character;
    } else if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\' && index + 1 < characters.length) {
        const next = characters[(index += 1)];
        word += next === '"' || next === '\\' ? next : `\\${next}`;
      } else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (character === '\\' && index + 1 < characters.length) {
      word += characters[(index += 1)];
      started = true;
    } else if (/\s/.test(character)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/**
 * A word as it must be written on a command line so that `tokenize`, and the app's terminal,
 * give it back unchanged: in double quotes, with `"` and `\` escaped, when it has a space, a
 * quote or a backslash in it. `payee:^tiket\.com$` written bare would lose its backslash.
 */
export function quote(word) {
  return /[\s"'\\]/.test(word) ? `"${word.replace(/[\\"]/g, '\\$&')}"` : word;
}

/** The type a word names, aliases included, or null. */
export function typeOf(word) {
  const lower = String(word || '').toLowerCase();
  if (TYPES[lower]) return lower;
  return ALIASES[lower] || null;
}

/**
 * Read a line into its options, its type and its query, or say what is wrong with it.
 *
 * Every refusal names the fix: a missing type lists the types, a misspelt one offers the
 * nearest, an unknown option lists the options, and a chart option written after the type,
 * where hledger would be handed it and fail, says to move it.
 */
export function parse(args) {
  const words = tokenize(args);
  const options = {};
  let index = 0;
  for (; index < words.length && words[index].startsWith('--'); index += 1) {
    const [flag, inline] = words[index].slice(2).split('=');
    const option = OPTIONS[flag];
    if (!option) {
      return { error: `--${flag} is not a chart option. Chart options are ${optionList()}; hledger's own flags go after the type.` };
    }
    if (!option.takes) {
      options[flag] = true;
      continue;
    }
    const value = inline !== undefined ? inline : words[(index += 1)];
    if (value === undefined) return { error: `--${flag} needs a value: --${flag} ${option.takes}.` };
    if (flag === 'top') {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1) return { error: `--top takes a number of accounts, such as --top 5, not ${value}.` };
      options.top = count;
    } else if (flag === 'sort') {
      if (!['name', 'value'].includes(value)) return { error: `--sort takes name or value, not ${value}.` };
      options.sort = value;
    }
  }

  const word = words[index];
  const type = typeOf(word);
  if (!type) {
    if (word === undefined) return { error: `which chart? Name a type: ${typeList()}. chart? shows how.` };
    const near = closestType(word);
    if (near) return { error: `${word} is not a chart type. Did you mean ${near}?` };
    return { error: `${word} is not a chart type; the type comes before the query, as in chart bar ${word}. The types are ${typeList()}.` };
  }

  const query = words.slice(index + 1);
  const late = query.find((part) => OPTIONS[part.replace(/^--/, '').split('=')[0]] && part.startsWith('--'));
  if (late) return { error: `${late} is a chart option, so it goes before the type: chart ${late} ${type} ...` };
  const unfit = Object.keys(options).filter((name) => !TYPES[type].options.includes(name));
  if (unfit.length) {
    const fits = TYPES[type].options.length ? `; it takes ${TYPES[type].options.map((name) => `--${name}`).join(', ')}` : '; it takes no chart options';
    const animatable = !ANIMATED.includes(type) && unfit.includes('animate')
      ? ` A ${type} already shows every period; --animate plays ${ANIMATED.join(', ')}.` : '';
    return { error: `${unfit.map((name) => `--${name}`).join(' and ')} ${unfit.length > 1 ? 'do' : 'does'} not apply to ${article(type)} ${type}${fits}.${animatable}` };
  }
  for (const [name, types] of Object.entries(NEEDS_ANIMATE)) {
    if (options[name] && !options.animate && types.includes(type)) {
      return { error: `--${name} on ${article(type)} ${type} needs periods to run over, so it goes with --animate: chart --animate --${name} ${type} ...` };
    }
  }
  return { options, type, query };
}

/**
 * The hledger command for a parsed line, and what the window is titled.
 *
 * The query is appended as written. A chart over time gets -M when the query has no interval of
 * its own; a Sankey gets `--depth 2` when the query sets no depth, so it draws categories rather
 * than every leaf; a calendar and a waterfall read the register.
 */
export function command({ type, query, options = {} }) {
  const spec = TYPES[type];
  const parts = [spec.report, ...query.map(quote)];
  // An animated chart plays period by period, so it is split like a chart over time.
  if ((spec.split || options.animate) && !query.some((word) => INTERVAL_FLAGS.includes(word))) parts.push('-M');
  const deep = query.some((word) => word === '--depth' || /^--depth=|^-\d+$/.test(word));
  if ((type === 'sankey' || spec.depth) && !deep) parts.push(`--depth ${spec.depth || 2}`);
  // A type about spending asks for it when the query names no account: a swarm of every posting
  // in a journal is every transfer and trade twice over.
  if (spec.account && partsOf(query).terms.length === 0) parts.splice(1, 0, spec.account);
  if (!query.includes('-O') && !query.includes('--output-format')) parts.push('-O csv');
  return parts.join(' ');
}

/** The query's account terms and its flags, apart: `-p 2026 coffee` is coffee, and -p 2026. */
function partsOf(query) {
  const terms = [];
  const flags = [];
  for (let index = 0; index < query.length; index += 1) {
    const word = query[index];
    if (!word.startsWith('-')) {
      terms.push(word);
      continue;
    }
    flags.push(word);
    if (VALUED_FLAGS.includes(word) && index + 1 < query.length) flags.push(quote(query[(index += 1)]));
  }
  return { terms, flags };
}

/**
 * The window's title: the type, what it is of, then the flags and the options that shape it.
 * `--log bar -p 2026 coffee` is "bar: coffee, -p 2026 (log scale)", which reads in the order a
 * person would say it.
 */
export function title({ type, query, options }) {
  const { terms, flags } = partsOf(query);
  const shaped = [
    options.log && 'log scale', options.percent && 'percent', options.cumulative && 'cumulative',
    options.top && `top ${options.top}`, options.sort === 'name' && 'by name', options.invert && 'inverted',
    options.animate && 'animated',
  ].filter(Boolean);
  // A type that charts spending by default says so, rather than "all accounts".
  const of = terms.length ? terms.join(' ') : TYPES[type].account || 'all accounts';
  return `${type}: ${of}${flags.length ? `, ${flags.join(' ')}` : ''}${shaped.length ? ` (${shaped.join(', ')})` : ''}`;
}

/** The line that would ask for this chart again, as a person would type it after `chart`. */
export function line({ type, query, options }) {
  return [...optionWords(options), type, ...query.map(quote)].join(' ');
}

/**
 * What a click on a mark asks for: that account over time, in the same period.
 *
 * The query's flags are kept and its account names replaced by the one clicked. Options that
 * still mean something for one account's line are kept; `--percent` of one account is 100%
 * everywhere and `--top` and `--sort` have nothing to choose between, so they go.
 */
export function drill(parsed, account) {
  const { terms, flags: written } = partsOf(parsed.query);
  const flags = tokenize(written.join(' '));
  const kept = {};
  for (const name of ['log', 'cumulative', 'invert']) if (parsed.options[name]) kept[name] = true;
  const plain = flags.filter((flag) => !['--tree', '-l', '--flat'].includes(flag));
  // With --pivot, a mark is a payee, a description or a tag's value, not an account: the click
  // asks for that field exactly and keeps the accounts the query named, so a payee's bar in a
  // chart of expenses opens that payee's expenses, month by month.
  const pivot = pivotOf(parsed.query);
  if (pivot) return line({ type: 'line', query: [...plain, ...terms, matchField(pivot, account)], options: kept });
  return line({ type: 'line', query: [...plain, account], options: kept });
}

/** The field a query pivots on, or null: `--pivot payee` is payee. */
export function pivotOf(query) {
  const at = query.findIndex((word) => word === '--pivot' || word.startsWith('--pivot='));
  if (at < 0) return null;
  return query[at].includes('=') ? query[at].split('=')[1] : query[at + 1] || null;
}

/**
 * The query term that matches one value of a pivoted field exactly. hledger's query terms are
 * regular expressions, so the value is anchored and its special characters escaped: a payee
 * named "Midtrans | Bayar kos" is not an alternation. Payee, description, code and note are
 * fields of their own; anything else is a tag.
 */
export function matchField(field, value) {
  const exact = `^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  const own = { payee: 'payee', desc: 'desc', description: 'desc', code: 'code', note: 'note' }[field];
  return own ? `${own}:${exact}` : `tag:${field}=${exact}`;
}

/**
 * Other charts of the same numbers, each written as the line that asks for it.
 *
 * The same query drawn by the other types of its family, carrying the options each of them
 * takes, so following one shows how to type it next time.
 */
export function related(parsed) {
  // Three families, each with one door into the next: the same numbers over time, as parts
  // of a whole, and as flows. Five links at most, nearest first.
  const families = [
    ['line', 'stacked', 'stream', 'heatmap', 'bump', 'multiples', 'bar'],
    ['bar', 'pie', 'treemap', 'sunburst', 'pack', 'line'],
    ['treemap', 'pack', 'sunburst', 'bar', 'pie'],
    ['sankey', 'cashflow', 'waterfall', 'budget', 'calendar'],
    ['cashflow', 'sankey', 'line', 'waterfall', 'budget'],
    ['budget', 'bar', 'cashflow', 'heatmap'],
    ['swarm', 'histogram', 'calendar', 'bar'],
    ['histogram', 'swarm', 'calendar', 'bar'],
  ];
  const family = families.find((types) => types[0] === parsed.type) || families.find((types) => types.includes(parsed.type)) || [];
  return family
    .filter((type) => type !== parsed.type)
    .slice(0, 5)
    .map((type) => {
      const options = Object.fromEntries(Object.entries(parsed.options).filter(([name]) => TYPES[type].options.includes(name)));
      // An option that needs --animate goes when --animate does.
      for (const [name, types] of Object.entries(NEEDS_ANIMATE)) {
        if (options[name] && !options.animate && types.includes(type)) delete options[name];
      }
      // What a type asked for by default is asked for by name, so the next chart is of the same
      // numbers: a swarm of expenses suggests a bar chart of expenses, not of everything.
      const fallback = TYPES[parsed.type].account;
      const query = fallback && partsOf(parsed.query).terms.length === 0 ? [fallback, ...parsed.query] : parsed.query;
      const args = line({ type, query, options });
      return { label: `chart ${args}`, args };
    });
}

/** The words for a set of options, in the order the help lists them. */
function optionWords(options) {
  const words = [];
  for (const name of Object.keys(OPTIONS)) {
    if (options[name] === undefined || options[name] === false) continue;
    words.push(OPTIONS[name].takes ? `--${name} ${options[name]}` : `--${name}`);
  }
  return words;
}

function optionList() {
  return Object.entries(OPTIONS).map(([name, option]) => (option.takes ? `--${name} ${option.takes}` : `--${name}`)).join(', ');
}

function typeList() {
  const names = Object.keys(TYPES);
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

function article(word) {
  return /^[aeiou]/.test(word) ? 'an' : 'a';
}

/** The type a mistyped word was probably meant to be: at most two letters off, one if short. */
export function closestType(word) {
  const text = String(word || '').toLowerCase();
  if (!text || /[\s:]/.test(text)) return null;
  let best = null;
  for (const name of [...Object.keys(TYPES), ...Object.keys(ALIASES)]) {
    const distance = editDistance(text, name);
    const allowed = name.length <= 4 ? 1 : 2;
    if (distance > 0 && distance <= allowed && (!best || distance < best.distance)) best = { name: typeOf(name), distance };
  }
  return best ? best.name : null;
}

/** Edits between two words, counting two neighbours swapped (`lien`, `line`) as one. */
function editDistance(left, right) {
  const rows = Array.from({ length: left.length + 1 }, (_, i) => Array.from({ length: right.length + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[left.length][right.length];
}
