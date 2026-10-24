//! JSON with comments and trailing commas (VS Code's `settings.json` and `mcp.json`), turned
//! into plain JSON for `serde_json`. Strings are copied untouched, so `//` inside a URL stays.
//! Pure.

/// The text without comments, trailing commas or a byte order mark.
pub fn to_json(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    without_trailing_commas(&without_comments(text))
}

fn without_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                out.push(c);
                copy_string(&mut chars, &mut out);
            }
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut last = '\0';
                for c in chars.by_ref() {
                    if last == '*' && c == '/' {
                        break;
                    }
                    last = c;
                }
                out.push(' ');
            }
            _ => out.push(c),
        }
    }
    out
}

/// Copies the rest of a string whose opening quote was copied.
fn copy_string(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, out: &mut String) {
    while let Some(c) = chars.next() {
        out.push(c);
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            }
            '"' => return,
            _ => {}
        }
    }
}

fn without_trailing_commas(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                out.push(c);
                copy_string(&mut chars, &mut out);
            }
            ',' => {
                let rest: String = chars.clone().take_while(|c| c.is_whitespace()).collect();
                let after = chars.clone().nth(rest.chars().count());
                if !matches!(after, Some('}' | ']')) {
                    out.push(c);
                }
            }
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> serde_json::Value {
        serde_json::from_str(&to_json(text)).unwrap()
    }

    #[test]
    fn comments_and_trailing_commas_go() {
        let value = parse(
            "\u{feff}{\n  // a comment\n  \"a\": 1, /* inline */ \"b\": [1, 2,],\n  \"c\": {\"d\": true,},\n}\n",
        );
        assert_eq!(
            value,
            serde_json::json!({"a": 1, "b": [1, 2], "c": {"d": true}})
        );
    }

    #[test]
    fn strings_are_left_alone() {
        let value = parse(
            r#"{"url": "https://example.com/mcp", "s": "a /* not */ b // c", "q": "x\",]", "t": ",}"}"#,
        );
        assert_eq!(value["url"], "https://example.com/mcp");
        assert_eq!(value["s"], "a /* not */ b // c");
        assert_eq!(value["q"], "x\",]");
        assert_eq!(value["t"], ",}");
    }

    #[test]
    fn unterminated_parts_end_the_text() {
        assert_eq!(to_json("{\"a\": 1} // end"), "{\"a\": 1} ");
        assert_eq!(to_json("{\"a\": 1 /* open"), "{\"a\": 1  ");
        assert!(serde_json::from_str::<serde_json::Value>(&to_json("{\"a\": \"open")).is_err());
    }
}
