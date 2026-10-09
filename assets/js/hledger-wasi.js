/**
 * hledger-anywhere — main-thread WASI bridge.
 *
 * Publishes `window.hledgerWasi`, which is the entire surface `src/hledger/
 * bridge.rs` talks to:
 *
 *   init()                                  -> Promise<{ wasmPath }>
 *   configure({ wasmPath, ledgerFile })     -> Promise<{ wasmPath, ledgerFile }>
 *   run(argv, files)              -> Promise<{ argv, stdout, stderr, exitCode, ms }>
 *
 * where `argv` is a string array and `files` is an array of `[path, contents]`
 * pairs (objects with `path`/`contents` are accepted too).
 *
 * A `window` global rather than an ES module import on the Rust side is a
 * deliberate choice: it avoids coupling wasm-bindgen's generated module
 * specifiers to Trunk's output layout, and it keeps the boundary debuggable —
 * `window.hledgerWasi.run([...], [...])` works from the browser console.
 *
 * Requests are serialised through a queue. hledger runs synchronously inside the
 * worker, but `run` awaits the initial module compile, so without a queue a
 * second request could interleave with the first and both would appear to run at
 * once in the Console log.
 */

const WORKER_URL = '/js/hledger-worker.js';
const DEFAULT_WASM_PATH = '/wasm/hledger.wasm';

class HledgerWasi {
  constructor() {
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    /** Tail of the request chain; keeps runs strictly sequential. */
    this.queue = Promise.resolve();
    this.wasmPath = DEFAULT_WASM_PATH;
  }

  static isSupported() {
    return typeof Worker !== 'undefined';
  }

  _ensureWorker() {
    if (this.worker !== null) {
      return this.worker;
    }
    if (!HledgerWasi.isSupported()) {
      const error = new Error('this browser does not support Web Workers');
      error.code = 'unsupported';
      throw error;
    }

    let worker;
    try {
      worker = new Worker(WORKER_URL, { type: 'module' });
    } catch (cause) {
      // Module workers are unsupported in some browsers; make that explicit
      // rather than letting panels show a blank engine error.
      const error = new Error(
        `could not start the hledger worker (module workers may be unsupported): ${
          cause && cause.message ? cause.message : cause
        }`,
      );
      error.code = 'unsupported';
      throw error;
    }

    worker.onmessage = (event) => {
      const message = event.data || {};
      const entry = this.pending.get(message.id);
      if (entry === undefined) {
        return;
      }
      this.pending.delete(message.id);

      if (message.type === 'error') {
        const error = new Error(message.error || 'hledger worker reported an error');
        if (message.code) {
          error.code = message.code;
        }
        entry.reject(error);
      } else {
        entry.resolve(message);
      }
    };

    worker.onerror = (event) => {
      // The worker failed at the module level (bad import, syntax error). Every
      // in-flight request has to fail, and the worker must not be reused.
      const error = new Error(
        event && event.message
          ? `hledger worker failed: ${event.message}`
          : 'hledger worker failed to start',
      );
      error.code = 'worker-crashed';
      for (const entry of this.pending.values()) {
        entry.reject(error);
      }
      this.pending.clear();
      this.worker = null;
    };

    this.worker = worker;
    return worker;
  }

  _send(type, payload) {
    const worker = this._ensureWorker();
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...payload });
    });
  }

  /** Run `task` after every previously queued task has settled. */
  _enqueue(task) {
    const result = this.queue.then(task, task);
    // Keep the chain alive regardless of individual failures.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  init() {
    return this._enqueue(() => this._send('init', {}));
  }

  /**
   * Point the engine at a journal.
   *
   * `ledgerFile` becomes `$LEDGER_FILE` inside the engine, which is what makes a
   * bare `hledger balance` work. Pass `undefined` to clear it.
   */
  configure(options = {}) {
    if (typeof options.wasmPath === 'string') {
      this.wasmPath = options.wasmPath;
    }
    return this._enqueue(() =>
      this._send('configure', {
        wasmPath: this.wasmPath,
        ledgerFile: options.ledgerFile,
      }),
    );
  }

  /**
   * Run one hledger invocation.
   *
   * Resolves with `{ argv, stdout, stderr, exitCode, ms }`. A non-zero exit code
   * is *not* a rejection: a failed report is a normal outcome that the caller
   * needs to display, including its stderr. Rejection is reserved for transport
   * failures (missing wasm, worker crash).
   */
  run(argv, files) {
    const safeArgv = Array.isArray(argv) ? argv.map(String) : [];
    const safeFiles = Array.isArray(files) ? files : [];
    return this._enqueue(() => this._send('run', { argv: safeArgv, files: safeFiles }));
  }
}

const bridge = new HledgerWasi();

if (typeof window !== 'undefined') {
  window.hledgerWasi = {
    isSupported: () => HledgerWasi.isSupported(),
    init: () => bridge.init(),
    configure: (options) => bridge.configure(options),
    run: (argv, files) => bridge.run(argv, files),
  };
}

export default bridge;
