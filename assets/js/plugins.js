/**
 * The plugin loader: repositories of runtime plugins, and the API they are given.
 *
 * A repository is a manifest, and a plugin is a module. Nothing here decides what a
 * plugin may be called or what its manifest means: that is the app's business, in Rust,
 * because a manifest is user input. This file fetches text, imports modules, and hands
 * each plugin the host API.
 *
 * `run()` is called with `arguments` renamed to `args`, since `arguments` cannot be a
 * parameter name in a module.
 *
 * A plugin is code running in this page, with the same reach as the page itself. That is
 * what makes it useful, and it is why installing a repository is trusting it.
 */
(() => {
  /** Imported modules, by absolute URL: a repository that is used twice is loaded once. */
  const modules = new Map();

  const absolute = (url) => new URL(url, document.baseURI).href;

  /** Fetch a manifest, and say why if it cannot be had. */
  async function fetchManifest(url) {
    const target = absolute(url);
    try {
      const response = await fetch(target, { cache: 'no-cache' });
      if (!response.ok) {
        return { error: `${target} answered ${response.status}` };
      }
      return { text: await response.text() };
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      return { error: `could not fetch ${target}: ${reason}` };
    }
  }

  /**
   * The part of the host API that has to be the browser's: a window, and the plugin's
   * own name.
   *
   * The window is opened by the call itself, before the plugin awaits anything, because
   * a pop-up opened after an await is blocked. That is why this returns a handle to fill
   * in later rather than taking content now.
   */
  function decorate(host, name) {
    host.name = name;
    host.window = (title) => {
      const popup = window.open('', '_blank');
      if (!popup) {
        return null;
      }
      popup.document.title = title || name;
      let url = null;
      return {
        write(html) {
          // A blob document rather than document.write: the window gets a real document
          // with its own URL, which is what a browser renders predictably, keeps the
          // page's own styles out of it, and leaves the window's history sane.
          if (url) {
            URL.revokeObjectURL(url);
          }
          url = URL.createObjectURL(new Blob([String(html)], { type: 'text/html' }));
          popup.location.replace(url);
        },
        close() {
          if (url) {
            URL.revokeObjectURL(url);
          }
          popup.close();
        },
      };
    };
    return host;
  }

  /** Import a plugin's module, once per URL. */
  async function moduleFor(manifestUrl, modulePath) {
    const url = absolute(new URL(modulePath, absolute(manifestUrl)).href);
    if (!modules.has(url)) {
      modules.set(url, import(/* webpackIgnore: true */ url));
    }
    return modules.get(url);
  }

  /** Run one plugin command. Errors come back as text, never as a thrown value. */
  async function run(manifestUrl, modulePath, name, args, host) {
    try {
      const module = await moduleFor(manifestUrl, modulePath);
      const plugin = module && module.default ? module.default : module;
      if (!plugin || typeof plugin.run !== 'function') {
        return { error: `${name} has no run() to call` };
      }
      await plugin.run(String(args == null ? '' : args), decorate(host, name));
      return {};
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      return { error: `${name} failed: ${reason}` };
    }
  }

  /** Forget imported modules, so a reloaded repository is read again. */
  function reset() {
    modules.clear();
  }

  window.hledgerPlugins = { fetchManifest, run, reset };
})();
