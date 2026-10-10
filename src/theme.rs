// Natively this module exists for its tests: the app that uses it is wasm-gated, so its
// items look unused to a plain build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

//! Colour themes: the built-in one, and the ones plugins offer.
//!
//! A theme is a handful of colours by role, and every role has a fallback, so a plugin
//! that sets two of them gets a usable theme rather than a broken one. A colour that
//! cannot be read as a colour is an error with a reason: a plugin that wrote `"#ggg"`
//! deserves to be told, and the user deserves to know why their theme did not apply.
//!
//! Roles: `background`, `foreground`, `cursor`, `accent` (the prompt marker, the
//! selected item in a listing) and `dim` (the app's asides). A role the app does not
//! know is ignored rather than refused, so a theme written for a later version still
//! applies what this one understands.

use std::collections::BTreeMap;

/// A colour, as the browser wants it and as a terminal escape needs it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    /// Read `#rgb` or `#rrggbb`.
    ///
    /// Only hex, because that is what a manifest is written in and what the browser and
    /// the terminal can both take without a colour parser between them.
    pub fn from_css(text: &str) -> Result<Rgb, String> {
        let text = text.trim();
        let Some(hex) = text.strip_prefix('#') else {
            return Err(format!("{text} is not a colour like #1a2b3c"));
        };
        let digits: Option<Vec<u8>> = hex
            .chars()
            .map(|character| character.to_digit(16).map(|digit| digit as u8))
            .collect();
        let Some(digits) = digits else {
            return Err(format!("{text} is not a colour like #1a2b3c"));
        };
        match digits.len() {
            // Three digits are shorthand: each one is doubled, so `#abc` is `#aabbcc`.
            3 => Ok(Rgb {
                r: digits[0] * 17,
                g: digits[1] * 17,
                b: digits[2] * 17,
            }),
            6 => Ok(Rgb {
                r: digits[0] * 16 + digits[1],
                g: digits[2] * 16 + digits[3],
                b: digits[4] * 16 + digits[5],
            }),
            _ => Err(format!("{text} is not a colour like #1a2b3c")),
        }
    }

    /// The colour as CSS, and as xterm.js wants it.
    pub fn css(&self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }

    /// The escape that sets this as the foreground colour.
    pub fn ansi(&self) -> String {
        format!("\u{1b}[38;2;{};{};{}m", self.r, self.g, self.b)
    }

    /// Whether this colour is light, by its own brightness.
    ///
    /// Used for the colours a theme does not name. A selection highlight and the red a
    /// failure is printed in have to go the right way on cream as well as on black, and
    /// asking the background is the only way to know which way that is.
    pub fn is_light(&self) -> bool {
        // Rec. 601 luma: close enough to choose between two palettes.
        (299 * self.r as u32 + 587 * self.g as u32 + 114 * self.b as u32) / 1000 >= 128
    }

    /// This colour with `other` mixed in, `percent` of the way.
    pub fn mix(&self, other: Rgb, percent: u32) -> Rgb {
        let percent = percent.min(100);
        let blend = |mine: u8, theirs: u8| -> u8 {
            ((mine as u32 * (100 - percent) + theirs as u32 * percent) / 100) as u8
        };
        Rgb {
            r: blend(self.r, other.r),
            g: blend(self.g, other.g),
            b: blend(self.b, other.b),
        }
    }
}

/// A theme: what the terminal is painted in, and what the app writes its own text in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Theme {
    pub name: String,
    pub background: Rgb,
    pub foreground: Rgb,
    pub cursor: Rgb,
    pub accent: Rgb,
    pub dim: Rgb,
}

impl Default for Theme {
    /// The theme the app ships with: black, amber and grey.
    fn default() -> Self {
        Theme {
            name: "default".to_string(),
            background: Rgb {
                r: 0x00,
                g: 0x00,
                b: 0x00,
            },
            foreground: Rgb {
                r: 0xd8,
                g: 0xd8,
                b: 0xd8,
            },
            cursor: Rgb {
                r: 0xff,
                g: 0x9f,
                b: 0x1c,
            },
            accent: Rgb {
                r: 0xff,
                g: 0x9f,
                b: 0x1c,
            },
            dim: Rgb {
                r: 0x8a,
                g: 0x8a,
                b: 0x8a,
            },
        }
    }
}

impl Theme {
    /// The colour a selection is drawn in.
    ///
    /// The foreground mixed into the background, so it is visible whichever way round the
    /// theme is, rather than the dark amber that only worked on black.
    pub fn selection(&self) -> String {
        self.background.mix(self.foreground, 25).css()
    }

    /// The red a failure is printed in, and its brighter twin.
    ///
    /// Chosen from the background rather than named by the theme: a failure has to be
    /// legible, and the coral that reads well on black disappears on cream.
    pub fn red(&self) -> &'static str {
        if self.background.is_light() {
            "#9d0006"
        } else {
            "#ff6b5e"
        }
    }

    /// The brighter of the two reds.
    pub fn red_bright(&self) -> &'static str {
        if self.background.is_light() {
            "#cc241d"
        } else {
            "#ff8a80"
        }
    }

    /// The theme the app ships with, by name.
    pub fn built_in() -> Theme {
        Theme::default()
    }

    /// A theme from a plugin, over the built-in colours.
    ///
    /// Roles the app does not know are ignored, and every role that is set has to be a
    /// colour: the first one that is not is reported, with the role's name, because that
    /// is the only way the author finds out which line to fix.
    pub fn from_plugin(name: &str, colors: &BTreeMap<String, String>) -> Result<Theme, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a theme with no name cannot be selected".to_string());
        }
        let mut theme = Theme {
            name: name.to_string(),
            ..Theme::default()
        };
        for (role, value) in colors {
            let colour = Rgb::from_css(value)
                .map_err(|error| format!("theme {name}: {role} {error}"))?;
            match role.as_str() {
                "background" => theme.background = colour,
                "foreground" => theme.foreground = colour,
                "cursor" => theme.cursor = colour,
                "accent" => theme.accent = colour,
                "dim" => theme.dim = colour,
                // A role from a later version, or a typo: ignored, and the theme still
                // applies what this version understands.
                _ => {}
            }
        }
        Ok(theme)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn colors(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(role, value)| ((*role).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn a_colour_is_read_in_both_hex_lengths() {
        assert_eq!(
            Rgb::from_css("#1a2b3c"),
            Ok(Rgb {
                r: 0x1a,
                g: 0x2b,
                b: 0x3c
            })
        );
        // Shorthand doubles each digit: #abc is #aabbcc.
        assert_eq!(
            Rgb::from_css("#abc"),
            Ok(Rgb {
                r: 0xaa,
                g: 0xbb,
                b: 0xcc
            })
        );
        assert_eq!(Rgb::from_css("  #000000  "), Ok(Rgb { r: 0, g: 0, b: 0 }));
        // Upper case is a colour too.
        assert_eq!(
            Rgb::from_css("#FF9F1C").map(|colour| colour.css()),
            Ok("#ff9f1c".to_string())
        );
    }

    #[test]
    fn what_is_not_a_colour_is_refused_with_a_reason() {
        for text in ["red", "#", "#12", "#12345", "#gggggg", "rgb(1,2,3)", ""] {
            let error = Rgb::from_css(text).expect_err(text);
            assert!(error.contains("not a colour"), "{text}: {error}");
        }
    }

    #[test]
    fn a_colour_becomes_css_and_a_terminal_escape() {
        let colour = Rgb::from_css("#7aa2f7").expect("a colour");
        assert_eq!(colour.css(), "#7aa2f7");
        assert_eq!(colour.ansi(), "\u{1b}[38;2;122;162;247m");
    }

    #[test]
    fn a_colour_knows_whether_it_is_light() {
        let light = Rgb::from_css("#fbf1c7").expect("a colour");
        let dark = Rgb::from_css("#282828").expect("a colour");
        assert!(light.is_light());
        assert!(!dark.is_light());
        // Mid grey, either way, is not a reason to crash.
        let _ = Rgb::from_css("#808080").expect("a colour").is_light();
    }

    #[test]
    fn what_a_theme_does_not_name_follows_its_background() {
        let light = Theme::from_plugin(
            "gruvbox-light",
            &colors(&[("background", "#fbf1c7"), ("foreground", "#3c3836")]),
        )
        .expect("a usable theme");
        let dark = Theme::built_in();

        // A selection is between the two, so it shows on either.
        let selection = Rgb::from_css(&light.selection()).expect("a colour");
        assert!(selection.r < 0xfb && selection.r > 0x3c, "{}", light.selection());
        assert!(selection.is_light());

        // And the red a failure uses is legible on both.
        assert_eq!(light.red(), "#9d0006");
        assert_eq!(dark.red(), "#ff6b5e");
        assert_ne!(light.red(), dark.red());
    }

    #[test]
    fn a_theme_from_a_plugin_keeps_the_built_in_roles_it_does_not_set() {
        let theme = Theme::from_plugin("midnight", &colors(&[("accent", "#7aa2f7")]))
            .expect("a usable theme");
        assert_eq!(theme.name, "midnight");
        assert_eq!(theme.accent.css(), "#7aa2f7");
        // Everything else is the built-in theme, so a plugin setting one colour gets a
        // theme rather than a half-painted terminal.
        assert_eq!(theme.background, Theme::default().background);
        assert_eq!(theme.dim, Theme::default().dim);
    }

    #[test]
    fn every_role_can_be_set_and_an_unknown_one_is_ignored() {
        let theme = Theme::from_plugin(
            "everything",
            &colors(&[
                ("background", "#0b1021"),
                ("foreground", "#c9d1d9"),
                ("cursor", "#f7768e"),
                ("accent", "#7aa2f7"),
                ("dim", "#6b7280"),
                ("hyperdrive", "#ff00ff"),
            ]),
        )
        .expect("a usable theme");
        assert_eq!(theme.background.css(), "#0b1021");
        assert_eq!(theme.foreground.css(), "#c9d1d9");
        assert_eq!(theme.cursor.css(), "#f7768e");
        assert_eq!(theme.accent.css(), "#7aa2f7");
        assert_eq!(theme.dim.css(), "#6b7280");
    }

    #[test]
    fn a_theme_with_a_colour_that_is_not_one_says_which_role() {
        let error = Theme::from_plugin("broken", &colors(&[("accent", "blue")]))
            .expect_err("not a colour");
        assert!(error.contains("broken"), "{error}");
        assert!(error.contains("accent"), "{error}");
    }

    #[test]
    fn a_theme_needs_a_name() {
        assert!(Theme::from_plugin("", &colors(&[])).is_err());
        assert!(Theme::from_plugin("   ", &colors(&[])).is_err());
    }

    #[test]
    fn the_built_in_theme_is_the_one_the_app_ships_with() {
        let theme = Theme::built_in();
        assert_eq!(theme.name, "default");
        assert_eq!(theme.background.css(), "#000000");
        assert_eq!(theme.accent.css(), "#ff9f1c");
    }
}
