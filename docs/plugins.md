# Writing a plugin

A plugin adds commands to hledger-anywhere without rebuilding it. It is a JavaScript
module, loaded from a **repository**, which is a manifest installed by URL or path.

A repository may be **any URL this page can fetch**, including one on another host that
lets it: you name it, so you trust it. A plugin is JavaScript running in the app's own page
with the page's own reach, which is what lets it fetch, draw and open windows, and is also
why installing a repository is trusting it. Nothing about a plugin is sandboxed, and the
app says so when you add one.

One repository is bundled and installed at every start, so it needs no installing at all:
[`assets/plugins`](../assets/plugins), whose `chart` plugin opens a balance line chart in
its own window and which carries the colour themes. Read it as the worked example of
everything below. Anything you add yourself works exactly the same way:

```
hledger.journal » plugins add https://example.invalid/plugins.json
Read 2 plugins from https://example.invalid/plugins.json: chart, forecast.
```

Being bundled means the app provides it, not that it is part of the core: `plugins` lists it
with everything else, and removing it works until the next visit, when the app installs it
again and says so.

## What a plugin is

A plugin is code running in the app's own page, with the same reach as the page itself.
That is what makes it able to draw, fetch and open windows, and it is why installing a
repository is trusting it. Install repositories you would run code from.

Plugins are read-only in the same sense the app is: the API below cannot change a
journal, and neither can anything built on it.

## The repository manifest

A manifest may also carry `themes` of its own, beside any a plugin declares:

```json
{
  "manifest": 1,
  "name": "my plugins",
  "themes": [
    { "name": "gruvbox", "colors": { "background": "#282828", "accent": "#fabd2f" } }
  ],
  "plugins": [
    {
      "name": "chart",
      "group": "Reports",
      "summary": "open a balance line chart in a window",
      "completes": ["balance", "expenses", "-M"],
      "module": "./chart.js",
      "themes": [
        { "name": "midnight", "colors": { "background": "#0b1021", "accent": "#7aa2f7" } }
      ]
    }
  ]
}
```

| field | what it is |
| --- | --- |
| `name` | The word that invokes it. One word, not one of the app's own commands, and not already taken. |
| `group` | The help section it appears in. Defaults to `Plugins`. |
| `summary` | One line for the help. Required: a command nobody can find is not a feature. |
| `completes` | Extra words it adds to Tab completion, such as the arguments it expects. |
| `module` | The module implementing it, relative to the manifest. Imported the first time one of its commands runs. |
| `themes` | Colour themes it offers, by role: `background`, `foreground`, `cursor`, `accent`, `dim`. |

The manifest is authoritative for everything the app knows before running anything. A
repository that is installed but never used therefore costs one fetch and runs no code.

A plugin that cannot be used is refused with a reason, and the rest of the manifest is
still installed. A manifest that cannot be read at all is an error, because you named it.

## The module

```js
export default {
  async run(args, host) {
    const csv = await host.hledger(`balance ${args} -M -O csv`);
    host.say(`${csv.trim().split('\n').length - 1} months`);
  },
};
```

`run(args, host)` is awaited. `args` is the text typed after the plugin's word, exactly
as typed, so a plugin that wants tokenised arguments does its own quoting or calls
hledger directly, which is what `host.hledger` is for. Throwing, or returning a rejected
promise, is reported as the plugin failing.

## The host API

| call | what it does |
| --- | --- |
| `host.name` | The plugin's own word. |
| `host.hledger(command)` | Runs hledger and resolves with its standard output. Rejects with the reason it could not run. |
| `host.say(text)` | Prints a line, the way the app prints its own. |
| `host.window(title)` | Opens a window and returns a handle with `write(html)` and `close()`, or `null` if the browser blocked it. |
| `host.setting(key)` | A setting this plugin remembered, or `null`. |
| `host.remember(key, value)` | Remembers it, in the app's settings. |

`host.hledger` accepts anything the command line accepts, and is bound by the same rules:
`add` and `import` are refused, and `-o` may not write over a loaded file. A command that
fails rejects rather than resolving with an empty string, so a plugin cannot mistake
failure for no data.

Two things worth knowing:

- **`-O csv` is usually what you want.** It is the only hledger output that keeps
  accounts, periods and amounts apart without parsing a laid-out table.
- **Open the window before you await anything.** A window opened after an `await` is
  blocked by the browser, which is why `host.window` returns a handle to fill in later.

## Colour themes

A repository or a plugin may offer themes in the manifest. Each is a name and some colours
by role:

```json
"themes": [
  { "name": "midnight", "colors": {
      "background": "#0b1021", "foreground": "#c9d1d9", "cursor": "#7aa2f7",
      "accent": "#7aa2f7", "dim": "#6b7280" } }
]
```

| role | what it paints |
| --- | --- |
| `background` | The terminal, and the page behind it. |
| `foreground` | The terminal's default text. |
| `cursor` | The cursor block. |
| `accent` | The prompt marker, and the selected line in a listing. |
| `dim` | The app's own asides: the explanations under a command. |

Colours are `#rrggbb` or `#rgb`. A role that is not set keeps the built-in colour, so a
theme that sets one colour is still a theme. Two of those built-in colours are chosen by
the background rather than fixed, because a dark theme and a light one need opposite
answers: the selection highlight is a blend of the foreground into the background, and the
red a failure is printed in is the dark `#9d0006` on a light background and the bright
`#ff6b5e` on a dark one. So a light theme needs nothing but its own background and
foreground to be readable; see `gruvbox-light` in [`assets/plugins`](../assets/plugins). A role the app does not know is ignored, so a
theme written for a later version applies what this one understands. A colour that cannot
be read is an error naming the role, reported when the theme is used rather than when the
repository is installed, because a broken theme does not make the plugin unusable.

The user selects one with `theme <name>`, and the choice is saved in the settings, so it
travels to another instance with `settings export`.

## Managing repositories

| command | what it does |
| --- | --- |
| `plugins` | Lists what is installed, and the repositories it came from. Bundled ones are marked. |
| `plugins add <url or path>` | Reads a manifest and registers its plugins and themes. |
| `plugins remove <url>` | Forgets them. |
| `plugins reload` | Reads every installed repository again, importing modules afresh. |

Repositories are remembered in the app's settings, so they are installed again on the
next visit. A path is served by the app's own server, so `./examples/plugins/plugins.json`
works from a local build; a URL may be anywhere that allows this page to fetch it.
