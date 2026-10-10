/**
 * hledger-anywhere — WASI worker.
 *
 * Owns the hledger WebAssembly runtime and runs it off the main thread.
 *
 * Why a worker at all: `_start()` is a synchronous call that runs a whole
 * accounting report to completion. On the main thread it would freeze the tab
 * for every panel refresh, and a frozen tab cannot even repaint a spinner.
 *
 * Why this file exists instead of the published bridge: the `hledger-wasm`
 * package's own JavaScript bridge re-fetches and re-instantiates the ~18 MB
 * module on *every* call, and captures output with a line-buffered writer that
 * drops a trailing partial line — which would corrupt JSON that does not end in
 * a newline. Here the module is compiled once, and stdout/stderr are captured as
 * raw bytes.
 *
 * Protocol (see also hledger-wasi.js on the main thread):
 *   in : { id, type: 'configure', wasmPath?, ledgerFile?, columns?, lines? }
 *        { id, type: 'init' }
 *        { id, type: 'run', argv: string[], files: [path, contents][] }
 *   out: { id, type: 'configured' | 'ready' | 'result' | 'error', ... }
 */

import {
  WASI,
  WASIProcExit,
  File,
  Directory,
  OpenFile,
  PreopenDirectory,
  ConsoleStdout,
} from './vendor/index.js';

const DEFAULT_WASM_PATH = '/wasm/hledger.wasm';

/**
 * A minimal, deterministic environment. hledger looks for a config file under
 * $HOME and takes a pager path only on a terminal; both are disabled here so a
 * report cannot depend on ambient state that does not exist under WASI.
 *
 * PATH is present, and empty apart from the root, because the real hledger CLI
 * *looks up* PATH rather than defaulting when it is missing — it scans for
 * add-on `hledger-*` executables — and the WASI shim turns a missing variable
 * into a hard failure ("env var \"PATH\" not found"). Pointing it at `/`, which
 * holds only the mounted journal files, means the lookup succeeds and finds no
 * add-ons, which is exactly right in a browser. The interim bridge never read
 * the environment at all, so this only surfaced once the real CLI was in use.
 */
const DEFAULT_ENV = [
  'HOME=/',
  'TMPDIR=/tmp',
  'LC_ALL=C.UTF-8',
  'TERM=dumb',
  'PATH=/',
  'PWD=/',
];

/**
 * The environment for one run.
 *
 * Two things are set beyond the fixed defaults, and both are the terminal telling
 * the engine about the world it is in:
 *
 *   LEDGER_FILE  which journal to read when no `-f` is given, so the user types
 *                exactly what they would type in a shell.
 *   COLUMNS,     how big the terminal is. hledger normally asks the operating
 *   LINES        system, which WASI cannot answer, so the engine's terminal-size
 *                stub reads these instead (see hledger-wasm/terminal-size-stub).
 *                Without them hledger formats every report to 80 columns
 *                regardless of the window.
 *
 * Both names are built here rather than by the caller, so the environment has
 * exactly one home.
 */
function environmentFor(ledgerFile, columns, lines) {
  const environment = DEFAULT_ENV.slice();
  if (typeof ledgerFile === 'string' && ledgerFile !== '') {
    environment.push(`LEDGER_FILE=${ledgerFile}`);
  }
  if (Number.isInteger(columns) && columns > 0) {
    environment.push(`COLUMNS=${columns}`);
  }
  if (Number.isInteger(lines) && lines > 0) {
    environment.push(`LINES=${lines}`);
  }
  return environment;
}

const encoder = new TextEncoder();

let wasmPath = DEFAULT_WASM_PATH;
let environment = DEFAULT_ENV.slice();

/** The LEDGER_FILE in an environment list, or undefined. */
function ledgerFileIn(env) {
  const prefix = 'LEDGER_FILE=';
  const found = env.find((entry) => entry.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

/** Compiled once and shared by every run: WebAssembly.compile is the expensive part. */
let compiled = null;

function post(message) {
  self.postMessage(message);
}

function ensureCompiled() {
  if (compiled === null) {
    compiled = (async () => {
      let response;
      try {
        response = await fetch(wasmPath);
      } catch (cause) {
        throw Object.assign(
          new Error(`could not load ${wasmPath}: ${cause && cause.message ? cause.message : cause}`),
          { code: 'missing-wasm' },
        );
      }
      if (!response.ok) {
        throw Object.assign(
          new Error(`could not load ${wasmPath}: HTTP ${response.status} ${response.statusText}`),
          { code: 'missing-wasm' },
        );
      }
      const bytes = await response.arrayBuffer();
      return WebAssembly.compile(bytes);
    })();
    // A failed attempt must not be cached, or a transient error would be
    // permanent for the lifetime of the page.
    compiled.catch(() => {
      compiled = null;
    });
  }
  return compiled;
}

/**
 * Build the WASI filesystem for one run: the user's files, at their relative
 * paths, under a single `data` directory.
 *
 * Mounting the whole loaded directory — rather than writing one journal to a
 * fixed name — is what makes `include` directives, `.rules` files and CSV
 * imports resolve, because hledger can then open the referenced paths itself.
 *
 * The preopen is `/` and the files live under `data/`, which is the layout
 * browser_wasi_shim resolves reliably: WASI passes paths to a preopen relative
 * to it, and `Path.from` rejects absolute paths outright.
 */
function buildRoot(files) {
  const data = new Directory(new Map());

  for (const entry of files) {
    const parts = String(entry.path)
      .split('/')
      .filter((part) => part !== '' && part !== '.');
    if (parts.length === 0) {
      continue;
    }

    let directory = data;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index];
      const existing = directory.contents.get(name);
      if (existing instanceof Directory) {
        directory = existing;
      } else {
        const created = new Directory(new Map());
        directory.contents.set(name, created);
        directory = created;
      }
    }
    directory.contents.set(
      parts[parts.length - 1],
      new File(encoder.encode(entry.contents)),
    );
  }

  return new Map([['data', data]]);
}

/**
 * The files hledger created or changed during a run.
 *
 * `-o FILE` is how a report is written instead of printed, and the mount is
 * in-memory, so without this the file would vanish with the run. Walking the tree
 * and comparing against what was mounted is the only honest way to tell: hledger
 * can also rewrite a journal in place, and that should be offered back too.
 */
function writtenFiles(root, mounted) {
  const written = [];

  const record = (path, file) => {
    const contents = new TextDecoder('utf-8').decode(file.data ?? new Uint8Array(0));
    // Files under data/ are the uploaded ones: only worth reporting if the run
    // changed them. Anything else the run created is news by definition —
    // including a file at the mount root, which is where a relative `-o` lands.
    const uploaded = path.startsWith('data/') ? path.slice('data/'.length) : null;
    if (uploaded === null || mounted.get(uploaded) !== contents) {
      written.push([uploaded ?? path, contents]);
    }
  };

  const walk = (entries, prefix) => {
    for (const [name, entry] of entries) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (entry instanceof Directory) {
        walk(entry.contents, path);
      } else if (entry instanceof File) {
        record(path, entry);
      }
    }
  };

  // The whole mount, not just data/, and entries may be files as well as
  // directories: `-o out.csv` resolves against the engine's working directory,
  // which is the mount root.
  walk(root, '');
  return written;
}

function normaliseFiles(files) {
  if (!Array.isArray(files)) {
    return [];
  }
  return files.map((entry) => {
    // The Rust side sends compact [path, contents] pairs; accept objects too so
    // the same bridge can be driven by hand from the console.
    if (Array.isArray(entry)) {
      return { path: String(entry[0]), contents: String(entry[1] ?? '') };
    }
    return {
      path: String(entry.path ?? ''),
      contents: String(entry.contents ?? ''),
    };
  });
}

async function run(request) {
  const module = await ensureCompiled();
  const started = performance.now();

  let stdout = '';
  let stderr = '';
  const outDecoder = new TextDecoder('utf-8');
  const errDecoder = new TextDecoder('utf-8');

  const mounted = normaliseFiles(request.files);
  // What was mounted, so a file the run changed can be told from one it left
  // alone. Built before the filesystem, which it is compared against afterwards.
  const before = new Map(mounted.map((file) => [file.path, file.contents]));
  const root = buildRoot(mounted);

  const fds = [
    // stdin: empty. Reports never read it, and WASI needs the slot filled.
    new OpenFile(new File(new Uint8Array(0))),
    new ConsoleStdout((buffer) => {
      stdout += outDecoder.decode(buffer, { stream: true });
    }),
    new ConsoleStdout((buffer) => {
      stderr += errDecoder.decode(buffer, { stream: true });
    }),
    new PreopenDirectory('/', root),
  ];

  const argv = Array.isArray(request.argv) ? request.argv.map(String) : [];
  const wasi = new WASI(argv, environment, fds, { debug: false });

  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });

  let exitCode = 0;
  try {
    // `start` calls `_start` and turns a proc_exit into a return value, so the
    // real exit code is available — unlike a bare `_start()` call, which throws
    // and would make a failed report look like a successful one.
    exitCode = wasi.start(instance);
  } catch (error) {
    if (error instanceof WASIProcExit) {
      exitCode = error.code;
    } else {
      // A trap (Rust/Haskell abort, or an out-of-bounds access) is reported as a
      // failed run rather than crashing the worker: the Console panel should be
      // able to show what went wrong.
      exitCode = -1;
      stderr += `${stderr ? '\n' : ''}engine trap: ${
        error && error.message ? error.message : String(error)
      }`;
    }
  }

  // Flush any partial multi-byte sequence still held by the streaming decoders.
  stdout += outDecoder.decode();
  stderr += errDecoder.decode();

  // Anything the run wrote, so the terminal can offer it for download before the
  // in-memory mount is thrown away.
  const written = writtenFiles(root, before);

  return {
    argv,
    stdout,
    stderr,
    exitCode,
    ms: performance.now() - started,
    written,
  };
}

self.onmessage = async (event) => {
  const request = event.data || {};
  const id = request.id;

  try {
    switch (request.type) {
      case 'configure': {
        if (typeof request.wasmPath === 'string' && request.wasmPath !== wasmPath) {
          wasmPath = request.wasmPath;
          compiled = null;
        }
        environment = environmentFor(request.ledgerFile, request.columns, request.lines);
        post({ id, type: 'configured', wasmPath, ledgerFile: ledgerFileIn(environment) });
        break;
      }
      case 'init': {
        await ensureCompiled();
        post({ id, type: 'ready', wasmPath });
        break;
      }
      case 'run': {
        post({ id, type: 'result', ...(await run(request)) });
        break;
      }
      default:
        throw new Error(`unknown request type: ${request.type}`);
    }
  } catch (error) {
    post({
      id,
      type: 'error',
      error: error && error.message ? error.message : String(error),
      code: error && error.code ? error.code : undefined,
    });
  }
};
