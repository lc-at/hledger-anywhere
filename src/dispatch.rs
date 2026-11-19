//! What a typed line asks the app to do, decided with no browser in the room.
//!
//! `submit` used to read a command's meaning and carry it out in the same breath,
//! so the decisions could only be tested by running the app in a page. This module
//! is the seam: [`decide`] reads a plain [`View`] of the state a command can see
//! and returns the effects in the order it decided them, and the app applies each
//! one. Nothing here writes anywhere, which is what lets `cargo test` cover every
//! command's decision on the host, where the app itself never compiles.

// Natively this module exists for its tests: the app that applies the effects is
// wasm-gated, so its items look unused to `cargo test`'s build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code, unused_imports))]

use crate::help;
use crate::hledger::JournalFile;
use crate::hledger_info;
use crate::plugins::{PluginInfo, Registry};
use crate::terminal::{self, Command};

/// What one decided command asks the app to do, in the order it was decided.
///
/// Each variant is one effect as the app performs it, named for what happens rather
/// than for the word that asked for it: a complaint is a print, a size is a size,
/// and the arguments a command hands to the app arrive on the variant that needs
/// them.
#[derive(Debug, PartialEq, Eq)]
pub enum Effect {
    /// Print the app's own words above the prompt, and put the prompt back.
    Print(String),
    /// Print a note that answers nothing, said before the line it belongs to runs.
    Say(String),
    /// Wipe the screen and redraw the prompt, for `clear`.
    Clear,
    /// Open the file picker and mount what it returns, for `upload`.
    Upload,
    /// Open a folder on disk, keeping its handles, for `open`.
    Open,
    /// Take back the folder an earlier `open` granted, for `reopen`.
    Reopen,
    /// Load the built-in sample journal, for `demo`.
    Demo,
    /// `alias name=command`: the definition, as it was written.
    SetAlias(String),
    /// `unalias name`: forget that alias.
    RemoveAlias(String),
    /// `history clear`: forget the commands run so far. The sentence that says so
    /// follows as its own print, in the order the two happen.
    ClearHistory,
    /// `theme [name]`: list the themes when there is no name, select it when there
    /// is. The listing and the wording of applying one belong to the app, which
    /// asks the settings and the registry for them.
    Theme(Option<String>),
    /// `settings [arguments]`: list what is remembered, or run that subcommand.
    Settings(Option<String>),
    /// `plugins [arguments]`: list the installed plugins, or run that subcommand.
    Plugins(Option<String>),
    /// `screenreader on|off`: the accessibility tree's new state.
    ScreenReader(bool),
    /// `font <size>`: the size to set, already clamped to the usable range.
    FontSize(u32),
    /// `find`, `/text`: the term to search the scrollback for, empty when the
    /// command carried none and the last search is meant.
    Search(String),
    /// `n` and `N`: repeat the last search forwards or backwards.
    SearchAgain(bool),
    /// `download <path>`: the file written by a command this session to save.
    Download(String),
    /// `journal <path>`: the loaded file to read as the journal.
    SetJournal(String),
    /// A line for hledger, verbatim, to run.
    RunHledger(String),
    /// A line whose first word a plugin answers to, with the plugin that claimed it.
    ///
    /// Boxed because a plugin is a manifest's worth of fields and every other
    /// variant is a sentence: an effect list would otherwise carry one fat enum
    /// for the sake of a run that happens once.
    RunPlugin {
        plugin: Box<PluginInfo>,
        line: String,
    },
}

/// The state a command's meaning is read from.
///
/// A plain borrow of exactly the fields a command looks at, for the length of one
/// decision: no cell to borrow, no screen to draw, nothing that can change
/// underneath while it is being read.
pub struct View<'a> {
    /// Aliases in the order they were defined: expanded for hledger's words, listed
    /// by `alias`, removed by `unalias`.
    pub aliases: &'a [(String, String)],
    /// The commands run this visit, for `history` and its filters.
    pub history: &'a [String],
    /// The terminal's width, which the help wraps to.
    pub columns: usize,
    /// Whether the loaded files came from an `open`ed directory and can be written,
    /// which changes what a writing command is told.
    pub writable: bool,
    /// The loaded files, as `journal` lists them.
    pub files: &'a [JournalFile],
    /// The uploaded path of the journal hledger reads, if one is chosen.
    pub main: Option<&'a str>,
    /// Files commands have written this session, as `download` lists them.
    pub written: &'a [JournalFile],
    /// The terminal font size, in pixels, as `font` reports it.
    pub font: u32,
    /// Whether the terminal's accessibility tree is on, as `screenreader` reports it.
    pub screen_reader: bool,
    /// The plugins installed this visit: who answers to a word, and what their help
    /// pages say.
    pub registry: &'a Registry,
}

/// What `line` means, read from `view`, as the effects to apply in order.
///
/// Aliases are expanded first, but only for commands that are hledger's: an alias
/// called `upload` would otherwise shadow the app's own command, and the words the
/// app owns are the one part of the vocabulary it must keep. Every mutation a
/// command performs, and every word it prints, is an effect here: the decision
/// reads state, it never changes any.
pub fn decide(view: &View<'_>, line: &str) -> Vec<Effect> {
    let mut effects = Vec::new();

    let line = match terminal::classify(line) {
        Command::Hledger(_) => {
            let (expanded, used) = terminal::expand_alias(line, view.aliases);
            if let Some((name, expansion)) = used {
                effects.push(Effect::Say(terminal::alias_note(&name, &expansion)));
            }
            expanded
        }
        _ => line.to_string(),
    };

    match terminal::classify(&line) {
        Command::Clear => effects.push(Effect::Clear),
        Command::Help(None) => {
            // The help entries borrow the registry, and the text is what is kept,
            // so the borrow ends before the line is printed.
            let text = format!(
                "{}\n{}\n",
                help::overview(&view.registry.help_entries(), view.columns),
                hledger_info::describe()
            );
            effects.push(Effect::Print(text));
        }
        Command::Help(Some(word)) => effects.extend(help_page(view, word)),
        Command::Upload => effects.push(Effect::Upload),
        Command::Open => effects.push(Effect::Open),
        Command::Reopen => effects.push(Effect::Reopen),
        Command::Demo => effects.push(Effect::Demo),
        Command::Alias(None) => effects.push(Effect::Print(terminal::alias_list(view.aliases))),
        Command::Alias(Some(text)) => effects.push(Effect::SetAlias(text.to_string())),
        Command::History(Some("clear" | "-c")) => {
            effects.push(Effect::ClearHistory);
            effects.push(Effect::Print(
                "The history is cleared: nothing is left for ↑ or Ctrl+R to recall.".to_string(),
            ));
        }
        Command::History(filter) => {
            effects.push(Effect::Print(terminal::history_listing(view.history, filter)));
        }
        Command::Unalias(Some(name)) => {
            if let Some(name) = one(&mut effects, name) {
                effects.push(Effect::RemoveAlias(name));
            }
        }
        Command::Unalias(None) => effects.push(Effect::Print(format!(
            "Which one? {}, or {} to list them.",
            terminal::bold("unalias <name>"),
            terminal::bold("alias")
        ))),
        Command::Font(None) => effects.push(Effect::Print(format!(
            "The font is {}px, between {} and {}. {} changes it, and so do \
             Ctrl+=, Ctrl+- and Ctrl+0.",
            view.font,
            terminal::MIN_FONT,
            terminal::MAX_FONT,
            terminal::bold("font 18")
        ))),
        Command::ScreenReader(None) => effects.push(Effect::Print(format!(
            "The accessibility tree is {}. {} turns it {}; the setting is \
             remembered between visits.",
            if view.screen_reader { "on" } else { "off" },
            terminal::bold("screenreader"),
            if view.screen_reader { "off" } else { "on" }
        ))),
        Command::Theme(None) => effects.push(Effect::Theme(None)),
        Command::Theme(Some(name)) => {
            if let Some(name) = one(&mut effects, name) {
                effects.push(Effect::Theme(Some(name)));
            }
        }
        Command::Settings(None) => effects.push(Effect::Settings(None)),
        Command::Settings(Some(arguments)) => {
            effects.push(Effect::Settings(Some(arguments.to_string())))
        }
        Command::Plugins(None) => effects.push(Effect::Plugins(None)),
        Command::Plugins(Some(arguments)) => {
            effects.push(Effect::Plugins(Some(arguments.to_string())))
        }
        Command::ScreenReader(Some(wanted)) => {
            if let Some(wanted) = one(&mut effects, wanted) {
                match terminal::parse_switch(&wanted) {
                    Ok(on) => effects.push(Effect::ScreenReader(on)),
                    Err(complaint) => effects.push(Effect::Print(complaint)),
                }
            }
        }
        Command::Font(Some(size)) => {
            if let Some(size) = one(&mut effects, size) {
                match terminal::font_size(&size) {
                    Ok(size) => {
                        effects.push(Effect::FontSize(size));
                        effects.push(Effect::Print(format!("The font is now {size}px.")));
                    }
                    Err(complaint) => effects.push(Effect::Print(complaint)),
                }
            }
        }
        Command::Search(term) => effects.push(Effect::Search(term.unwrap_or("").to_string())),
        Command::SearchAgain(backwards) => effects.push(Effect::SearchAgain(backwards)),
        Command::Download(Some(path)) => {
            if let Some(path) = one(&mut effects, path) {
                effects.push(Effect::Download(path));
            }
        }
        Command::Download(None) => {
            let names: Vec<String> = view
                .written
                .iter()
                .map(|file| file.path.clone())
                .collect();
            effects.push(Effect::Print(terminal::download_list(&names)));
        }
        Command::Journal(None) => {
            let paths: Vec<String> = view.files.iter().map(|file| file.path.clone()).collect();
            effects.push(Effect::Print(terminal::file_list(&paths, view.main)));
        }
        Command::Journal(Some(path)) => {
            if let Some(path) = one(&mut effects, path) {
                effects.push(Effect::SetJournal(path));
            }
        }
        Command::Hledger(command) => {
            // hledger's own writers are refused before anything runs: this session
            // is read-only, and a command that changed a journal would change what
            // every report after it reads.
            if let Some(refusal) = terminal::read_only_refusal(command, view.writable) {
                effects.push(Effect::Print(refusal));
                return effects;
            }

            // A plugin gets first refusal on the word. The core does not know
            // their names, which is what makes them plugins.
            match view.registry.owner(command).cloned() {
                Some(plugin) => effects.push(Effect::RunPlugin {
                    plugin: Box::new(plugin),
                    line: command.to_string(),
                }),
                None => effects.push(Effect::RunHledger(command.to_string())),
            }
        }
    }

    effects
}

/// `word?`: one command's help, as the effects that print it.
///
/// The app answers for its own commands and for the plugins' words, since it is the
/// manifest that described them. Anything else is handed to hledger with `--help`,
/// which knows its own commands far better than a copy of its manual would; a word
/// neither knows is answered with the closest names rather than a bare refusal.
fn help_page(view: &View<'_>, word: &str) -> Vec<Effect> {
    if let Some(entry) = help::find(word) {
        return vec![Effect::Print(help::page(entry, view.columns))];
    }

    let plugin = view.registry.find(word).cloned();
    if let Some(plugin) = plugin {
        return vec![Effect::Print(help::plugin_page(&plugin, view.columns))];
    }

    if terminal::HLEDGER_COMMANDS.contains(&word) {
        return vec![Effect::RunHledger(format!("{word} --help"))];
    }

    let closest = terminal::fuzzy_matches(word, &terminal::starting_words(), 4);
    vec![Effect::Print(help::unknown(word, &closest))]
}

/// One argument with its quoting removed, or the complaint about why not.
///
/// The app's own commands take a single path, address or number. A path can have a
/// space in it, an uploaded file is named whatever it was named, so `journal "my
/// file.journal"` has to mean that file, and `journal a b` has to say so rather
/// than quietly reading `a`. No argument at all is not a complaint: the command
/// that asked decides for itself what an absent argument means.
fn one(effects: &mut Vec<Effect>, rest: &str) -> Option<String> {
    match terminal::single_argument(rest) {
        Ok(argument) => argument,
        Err(complaint) => {
            effects.push(Effect::Print(complaint));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A manifest whose plugin answers to `chart`, a word neither the app nor
    /// hledger claims.
    const MANIFEST: &str = r#"{"name":"Charts","plugins":[{"name":"chart","summary":"open a balance chart"}]}"#;

    /// The state a command sees when nothing is loaded and nothing is set.
    struct TestView {
        aliases: Vec<(String, String)>,
        history: Vec<String>,
        columns: usize,
        writable: bool,
        files: Vec<JournalFile>,
        main: Option<String>,
        written: Vec<JournalFile>,
        font: u32,
        screen_reader: bool,
        registry: Registry,
    }

    impl TestView {
        fn new() -> TestView {
            TestView {
                aliases: Vec::new(),
                history: Vec::new(),
                columns: 80,
                writable: false,
                files: Vec::new(),
                main: None,
                written: Vec::new(),
                font: 14,
                screen_reader: false,
                registry: Registry::default(),
            }
        }

        fn with_plugin(mut self) -> TestView {
            self.registry
                .install(MANIFEST, "/plugins/charts.json")
                .expect("a manifest the rules accept");
            self
        }

        fn view(&self) -> View<'_> {
            View {
                aliases: &self.aliases,
                history: &self.history,
                columns: self.columns,
                writable: self.writable,
                files: &self.files,
                main: self.main.as_deref(),
                written: &self.written,
                font: self.font,
                screen_reader: self.screen_reader,
                registry: &self.registry,
            }
        }

        fn decide(&self, line: &str) -> Vec<Effect> {
            super::decide(&self.view(), line)
        }
    }

    fn decide(line: &str) -> Vec<Effect> {
        TestView::new().decide(line)
    }

    fn file(path: &str) -> JournalFile {
        JournalFile::new(path, "")
    }

    #[test]
    fn a_bare_question_mark_is_the_overview() {
        let effects = decide("?");
        let text = match effects.as_slice() {
            [Effect::Print(text)] => text.clone(),
            other => panic!("not one print: {other:?}"),
        };
        let expected = format!(
            "{}\n{}\n",
            help::overview(&Registry::default().help_entries(), 80),
            hledger_info::describe()
        );
        assert_eq!(text, expected);
        assert!(text.contains("hledger-anywhere"), "{text}");
    }

    #[test]
    fn a_word_followed_by_a_question_mark_is_its_help_page() {
        let effects = decide("open?");
        let entry = help::find("open").expect("open has a page");
        assert_eq!(effects, [Effect::Print(help::page(entry, 80))]);
    }

    #[test]
    fn a_plugin_word_with_a_question_mark_is_the_plugins_page() {
        let view = TestView::new().with_plugin();
        let effects = view.decide("chart?");
        let plugin = view.registry.find("chart").expect("the manifest was installed");
        assert_eq!(effects, [Effect::Print(help::plugin_page(plugin, 80))]);
    }

    #[test]
    fn a_hledger_word_with_a_question_mark_runs_its_help() {
        assert_eq!(decide("balance?"), [Effect::RunHledger("balance --help".to_string())]);
    }

    #[test]
    fn a_word_nobody_knows_is_answered_with_the_closest_names() {
        let effects = decide("blance?");
        let [Effect::Print(text)] = effects.as_slice() else {
            panic!("not one print: {effects:?}");
        };
        assert!(text.contains("no help for"), "{text}");
        assert!(text.contains("Closest: balance"), "{text}");
    }

    #[test]
    fn clear_asks_for_the_screen_to_be_wiped() {
        assert_eq!(decide("clear"), [Effect::Clear]);
    }

    #[test]
    fn upload_asks_for_the_file_picker() {
        assert_eq!(decide("upload"), [Effect::Upload]);
    }

    #[test]
    fn open_asks_for_a_folder_on_disk() {
        assert_eq!(decide("open"), [Effect::Open]);
    }

    #[test]
    fn reopen_takes_back_the_folder_from_last_time() {
        assert_eq!(decide("reopen"), [Effect::Reopen]);
    }

    #[test]
    fn demo_loads_the_sample_journal() {
        assert_eq!(decide("demo"), [Effect::Demo]);
    }

    #[test]
    fn alias_without_a_name_lists_what_is_defined() {
        assert_eq!(
            decide("alias"),
            [Effect::Print(terminal::alias_list(&[]))]
        );

        let mut view = TestView::new();
        view.aliases.push(("bal".to_string(), "balance".to_string()));
        let effects = view.decide("alias");
        let [Effect::Print(text)] = effects.as_slice() else {
            panic!("not one print: {effects:?}");
        };
        assert!(text.contains("bal = balance"), "{text}");
    }

    #[test]
    fn alias_with_a_definition_defines_it() {
        assert_eq!(
            decide("alias bal=balance --tree"),
            [Effect::SetAlias("bal=balance --tree".to_string())]
        );
    }

    #[test]
    fn history_clear_forgets_everything_and_says_so() {
        assert_eq!(
            decide("history clear"),
            [
                Effect::ClearHistory,
                Effect::Print(
                    "The history is cleared: nothing is left for ↑ or Ctrl+R to recall."
                        .to_string()
                ),
            ]
        );
        assert_eq!(decide("history -c"), decide("history clear"));
    }

    #[test]
    fn history_lists_what_was_run() {
        let mut view = TestView::new();
        view.history.push("balance".to_string());
        view.history.push("print".to_string());
        let expected = terminal::history_listing(&view.history, None);
        let effects = view.decide("history");
        let [Effect::Print(text)] = effects.as_slice() else {
            panic!("not one print: {effects:?}");
        };
        assert_eq!(text, &expected);
        assert!(text.contains("balance"), "{text}");
    }

    #[test]
    fn history_with_words_lists_only_the_matches() {
        let mut view = TestView::new();
        view.history.push("balance --tree".to_string());
        view.history.push("print x.journal".to_string());
        let effects = view.decide("history balance");
        assert_eq!(
            effects,
            [Effect::Print(terminal::history_listing(&view.history, Some("balance")))]
        );
    }

    #[test]
    fn unalias_without_a_name_says_which_one() {
        assert_eq!(
            decide("unalias"),
            [Effect::Print(format!(
                "Which one? {}, or {} to list them.",
                terminal::bold("unalias <name>"),
                terminal::bold("alias")
            ))]
        );
    }

    #[test]
    fn unalias_removes_the_named_alias() {
        assert_eq!(decide("unalias bal"), [Effect::RemoveAlias("bal".to_string())]);
    }

    #[test]
    fn unalias_with_two_arguments_is_refused() {
        let effects = decide("unalias a b");
        let [Effect::Print(text)] = effects.as_slice() else {
            panic!("not one print: {effects:?}");
        };
        assert!(text.contains("more than one argument"), "{text}");
    }

    #[test]
    fn font_without_a_size_reports_the_size() {
        assert_eq!(
            decide("font"),
            [Effect::Print(format!(
                "The font is {}px, between {} and {}. {} changes it, and so do \
                 Ctrl+=, Ctrl+- and Ctrl+0.",
                14,
                terminal::MIN_FONT,
                terminal::MAX_FONT,
                terminal::bold("font 18")
            ))]
        );

        let mut view = TestView::new();
        view.font = 20;
        let effects = view.decide("font");
        assert!(
            matches!(&effects[..], [Effect::Print(text)] if text.starts_with("The font is 20px, ")),
            "{effects:?}"
        );
    }

    #[test]
    fn screenreader_without_a_word_reports_whether_it_is_on() {
        let off = decide("screenreader");
        let [Effect::Print(text)] = off.as_slice() else {
            panic!("not one print: {off:?}");
        };
        assert!(text.starts_with("The accessibility tree is off."), "{text}");
        assert!(text.contains("turns it on"), "{text}");

        let mut view = TestView::new();
        view.screen_reader = true;
        let on = view.decide("screenreader");
        assert!(
            matches!(&on[..], [Effect::Print(text)] if text.starts_with("The accessibility tree is on.")
                && text.contains("turns it off")),
            "{on:?}"
        );
    }

    #[test]
    fn theme_without_a_name_lists_the_themes() {
        assert_eq!(decide("theme"), [Effect::Theme(None)]);
    }

    #[test]
    fn theme_with_a_name_selects_that_theme() {
        assert_eq!(decide("theme solarized"), [Effect::Theme(Some("solarized".to_string()))]);
    }

    #[test]
    fn theme_with_two_arguments_is_refused() {
        let effects = decide("theme a b");
        let [Effect::Print(text)] = effects.as_slice() else {
            panic!("not one print: {effects:?}");
        };
        assert!(text.contains("more than one argument"), "{text}");
    }

    #[test]
    fn settings_without_arguments_lists_what_is_remembered() {
        assert_eq!(decide("settings"), [Effect::Settings(None)]);
    }

    #[test]
    fn settings_with_an_argument_runs_that_subcommand() {
        assert_eq!(
            decide("settings export"),
            [Effect::Settings(Some("export".to_string()))]
        );
    }

    #[test]
    fn plugins_without_arguments_lists_them() {
        assert_eq!(decide("plugins"), [Effect::Plugins(None)]);
    }

    #[test]
    fn plugins_with_an_argument_runs_that_subcommand() {
        assert_eq!(
            decide("plugins add /plugins/charts.json"),
            [Effect::Plugins(Some("add /plugins/charts.json".to_string()))]
        );
    }

    #[test]
    fn screenreader_on_turns_the_accessibility_tree_on() {
        assert_eq!(decide("screenreader on"), [Effect::ScreenReader(true)]);
        assert_eq!(decide("screenreader off"), [Effect::ScreenReader(false)]);
    }

    #[test]
    fn screenreader_with_a_word_that_is_not_on_or_off_is_refused() {
        let effects = decide("screenreader maybe");
        let [Effect::Print(text)] = effects.as_slice() else {
            panic!("not one print: {effects:?}");
        };
        assert!(text.contains("is not on or off"), "{text}");
    }

    #[test]
    fn font_size_sets_the_size_and_says_so() {
        assert_eq!(
            decide("font 18"),
            [
                Effect::FontSize(18),
                Effect::Print("The font is now 18px.".to_string()),
            ]
        );
    }

    #[test]
    fn a_font_size_bigger_than_the_largest_is_clamped() {
        assert_eq!(
            decide("font 100"),
            [
                Effect::FontSize(terminal::MAX_FONT),
                Effect::Print(format!("The font is now {}px.", terminal::MAX_FONT)),
            ]
        );
    }

    #[test]
    fn a_font_size_that_is_not_a_number_is_refused() {
        let effects = decide("font big");
        let [Effect::Print(text)] = effects.as_slice() else {
            panic!("not one print: {effects:?}");
        };
        assert!(text.contains("is not a number"), "{text}");
    }

    #[test]
    fn a_search_takes_the_term() {
        assert_eq!(decide("/assets"), [Effect::Search("assets".to_string())]);
        assert_eq!(decide("find cash"), [Effect::Search("cash".to_string())]);
        assert_eq!(decide("find"), [Effect::Search(String::new())]);
        assert_eq!(decide("/"), [Effect::Search(String::new())]);
    }

    #[test]
    fn n_repeats_the_last_search_forwards_and_n_backwards() {
        assert_eq!(decide("n"), [Effect::SearchAgain(false)]);
        assert_eq!(decide("N"), [Effect::SearchAgain(true)]);
    }

    #[test]
    fn download_with_a_path_saves_that_file() {
        assert_eq!(decide("download report.csv"), [Effect::Download("report.csv".to_string())]);
    }

    #[test]
    fn download_without_a_path_lists_what_was_written() {
        let mut view = TestView::new();
        view.written.push(file("report.csv"));
        let effects = view.decide("download");
        assert_eq!(
            effects,
            [Effect::Print(terminal::download_list(&["report.csv".to_string()]))]
        );
    }

    #[test]
    fn journal_without_a_path_lists_what_is_loaded() {
        let mut view = TestView::new();
        view.files.push(file("main.journal"));
        view.files.push(file("prices.journal"));
        view.main = Some("main.journal".to_string());
        let effects = view.decide("journal");
        assert_eq!(
            effects,
            [Effect::Print(terminal::file_list(
                &["main.journal".to_string(), "prices.journal".to_string()],
                Some("main.journal"),
            ))]
        );
    }

    #[test]
    fn journal_with_a_path_reads_that_file() {
        assert_eq!(
            decide("journal \"my file.journal\""),
            [Effect::SetJournal("my file.journal".to_string())]
        );
    }

    #[test]
    fn a_writing_command_is_refused_while_the_session_is_read_only() {
        let effects = decide("import new.journal");
        assert_eq!(
            effects,
            [Effect::Print(
                terminal::read_only_refusal("import new.journal", false)
                    .expect("import is a writer")
            )]
        );
        let [Effect::Print(text)] = effects.as_slice() else {
            panic!("not one print: {effects:?}");
        };
        assert!(text.contains("read-only"), "{text}");
    }

    #[test]
    fn a_writing_command_says_to_edit_in_a_window_when_the_session_can_write() {
        let mut view = TestView::new();
        view.writable = true;
        let effects = view.decide("import new.journal");
        assert_eq!(
            effects,
            [Effect::Print(
                terminal::read_only_refusal("import new.journal", true)
                    .expect("import is a writer")
            )]
        );
        let [Effect::Print(text)] = effects.as_slice() else {
            panic!("not one print: {effects:?}");
        };
        assert!(text.contains("not enabled yet"), "{text}");
    }

    #[test]
    fn add_is_refused_whether_or_not_the_session_can_write() {
        for writable in [false, true] {
            let mut view = TestView::new();
            view.writable = writable;
            let effects = view.decide("add");
            let [Effect::Print(text)] = effects.as_slice() else {
                panic!("not one print: {effects:?}");
            };
            assert!(text.contains("asks questions as it goes"), "{text}");
        }
    }

    #[test]
    fn a_report_runs_through_the_engine() {
        assert_eq!(decide("balance --tree"), [Effect::RunHledger("balance --tree".to_string())]);
    }

    #[test]
    fn a_plugin_word_runs_the_plugin() {
        let view = TestView::new().with_plugin();
        let effects = view.decide("chart --daily");
        let [Effect::RunPlugin { plugin, line }] = effects.as_slice() else {
            panic!("not one plugin run: {effects:?}");
        };
        assert_eq!(plugin.name, "chart");
        assert_eq!(line, "chart --daily");
    }

    #[test]
    fn an_alias_expands_before_the_command_runs() {
        let mut view = TestView::new();
        view.aliases.push(("bal".to_string(), "balance".to_string()));
        let effects = view.decide("bal --tree");
        assert_eq!(
            effects,
            [
                Effect::Say(terminal::alias_note("bal", "balance")),
                Effect::RunHledger("balance --tree".to_string()),
            ]
        );
    }

    #[test]
    fn an_app_command_is_not_shadowed_by_an_alias() {
        let mut view = TestView::new();
        view.aliases.push(("upload".to_string(), "balance".to_string()));
        assert_eq!(view.decide("upload"), [Effect::Upload]);
    }

    #[test]
    fn an_alias_whose_first_word_is_a_plugin_goes_to_the_plugin() {
        let mut view = TestView::new().with_plugin();
        view.aliases.push(("c".to_string(), "chart".to_string()));
        let effects = view.decide("c");
        assert_eq!(
            effects,
            [
                Effect::Say(terminal::alias_note("c", "chart")),
                Effect::RunPlugin {
                    plugin: Box::new(view.registry.find("chart").expect("installed").clone()),
                    line: "chart".to_string(),
                },
            ]
        );
    }
}
