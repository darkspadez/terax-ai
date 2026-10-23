//! `SKILL.md`: YAML frontmatter, then Markdown instructions (the Agent Skills format).
//!
//! The frontmatter is read by a small YAML reader that covers what skill files use: top-level
//! `key: value` fields whose values are plain, quoted or block scalars, flow or block lists, or
//! maps. A field Terax uses must parse; any other field is skipped whatever it holds, so a field
//! another tool adds never breaks a skill. Validation follows the Agent Skills specification and
//! Claude Code where the specification is silent: a missing `name` is the folder's name and a
//! missing `description` the first line of the instructions, each with a warning.

pub const MAX_NAME_CHARS: usize = 64;
pub const MAX_DESCRIPTION_CHARS: usize = 1024;
pub const MAX_COMPATIBILITY_CHARS: usize = 500;
const MAX_ARGUMENT_HINT_CHARS: usize = 200;

/// A skill's metadata, validated, and where its instructions start in the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    pub when_to_use: Option<String>,
    pub argument_hint: Option<String>,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    /// False with `disable-model-invocation: true`: only the user calls it, with `/name`.
    pub model_invocable: bool,
    /// False with `user-invocable: false`: no `/name`, only the model loads it.
    pub user_invocable: bool,
    /// Byte offset of the Markdown body in the text that was parsed.
    pub body_start: usize,
    pub warnings: Vec<String>,
}

/// Reads and validates a `SKILL.md`. `dir_name` is the skill's folder name, the name of a skill
/// whose frontmatter has none. Errors are reasons the skill cannot be used.
pub fn parse_skill(text: &str, dir_name: &str) -> Result<SkillMeta, Vec<String>> {
    let mut warnings = Vec::new();
    let mut fallbacks_noted = false;
    let (entries, body_start) = match split_frontmatter(text) {
        Err(error) => return Err(vec![error]),
        Ok(None) => {
            warnings.push(
                "SKILL.md has no frontmatter (a `---` block with `name` and `description`); the folder name and the first line are used"
                    .to_owned(),
            );
            fallbacks_noted = true;
            (Vec::new(), bom_len(text))
        }
        Ok(Some((frontmatter, body_start))) => match read_mapping(frontmatter, &mut warnings) {
            Ok(entries) => (entries, body_start),
            Err(error) => return Err(vec![format!("frontmatter: {error}")]),
        },
    };
    let body = &text[body_start..];
    let mut errors = Vec::new();

    let name = match text_field(&entries, "name") {
        Ok(Some(name)) => {
            let name = name.trim().to_owned();
            if name != dir_name && validate_name(&name).is_ok() {
                warnings.push(format!(
                    "the name `{name}` differs from its folder `{dir_name}`"
                ));
            }
            name
        }
        Ok(None) => {
            if !fallbacks_noted {
                warnings.push(format!("no `name`; the folder name `{dir_name}` is used"));
            }
            dir_name.to_owned()
        }
        Err(error) => {
            errors.push(error);
            String::new()
        }
    };
    if errors.is_empty() {
        if let Err(error) = validate_name(&name) {
            errors.push(error);
        }
    }

    let description = match text_field(&entries, "description") {
        Ok(Some(description)) if !description.trim().is_empty() => {
            Some(clean_text(description.trim()))
        }
        Ok(_) => match first_line(body) {
            Some(line) => {
                if !fallbacks_noted {
                    warnings.push(
                        "no `description`; the first line of the instructions is used".to_owned(),
                    );
                }
                Some(clean_text(line))
            }
            None => {
                errors.push("`description` is missing".to_owned());
                None
            }
        },
        Err(error) => {
            errors.push(error);
            None
        }
    };
    if let Some(description) = &description {
        let length = description.chars().count();
        if length > MAX_DESCRIPTION_CHARS {
            errors.push(format!(
                "`description` has {length} characters; at most {MAX_DESCRIPTION_CHARS} are allowed"
            ));
        }
    }

    let compatibility = optional_text(&entries, "compatibility", &mut errors);
    if let Some(compatibility) = &compatibility {
        let length = compatibility.chars().count();
        if length > MAX_COMPATIBILITY_CHARS {
            errors.push(format!(
                "`compatibility` has {length} characters; at most {MAX_COMPATIBILITY_CHARS} are allowed"
            ));
        }
    }
    let when_to_use = optional_text(&entries, "when_to_use", &mut errors);
    let license = optional_text(&entries, "license", &mut errors);
    let argument_hint = optional_text(&entries, "argument-hint", &mut errors)
        .map(|hint| hint.chars().take(MAX_ARGUMENT_HINT_CHARS).collect());
    let disable_model = bool_field(&entries, "disable-model-invocation", false, &mut errors);
    let user_invocable = bool_field(&entries, "user-invocable", true, &mut errors);
    if entries.iter().any(|entry| entry.key == "allowed-tools") {
        warnings.push(
            "`allowed-tools` is not used: Terax asks before tools run as the conversation's approval mode says"
                .to_owned(),
        );
    }

    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(SkillMeta {
        name,
        description: description.unwrap_or_default(),
        when_to_use,
        argument_hint,
        license,
        compatibility,
        model_invocable: !disable_model,
        user_invocable,
        body_start,
        warnings,
    })
}

/// The Agent Skills name rule: 1 to 64 lowercase letters, digits and hyphens, no hyphen at
/// either end and never two in a row.
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("`name` is empty".to_owned());
    }
    let length = name.chars().count();
    if length > MAX_NAME_CHARS {
        return Err(format!(
            "`name` has {length} characters; at most {MAX_NAME_CHARS} are allowed"
        ));
    }
    if name.chars().any(|c| c.is_ascii_uppercase()) {
        return Err(format!("`name` `{name}` has uppercase letters"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!(
            "`name` `{}` may only hold lowercase letters, digits and hyphens",
            printable(name)
        ));
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err(format!("`name` `{name}` starts or ends with a hyphen"));
    }
    if name.contains("--") {
        return Err(format!("`name` `{name}` has two hyphens in a row"));
    }
    Ok(())
}

/// A name shown in a message: control and format characters dropped, at most 80 characters.
fn printable(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() && !is_format_char(*c))
        .take(80)
        .collect()
}

/// Text for display and for the model: control characters (other than line breaks and tabs)
/// and bidirectional or zero-width format characters removed.
pub fn clean_text(text: &str) -> String {
    text.chars()
        .filter(|&c| c == '\n' || c == '\t' || (!c.is_control() && !is_format_char(c)))
        .collect()
}

fn is_format_char(c: char) -> bool {
    matches!(c,
        '\u{200b}'..='\u{200f}'
        | '\u{202a}'..='\u{202e}'
        | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{2069}'
        | '\u{feff}'
        | '\u{061c}')
}

fn bom_len(text: &str) -> usize {
    if text.starts_with('\u{feff}') {
        '\u{feff}'.len_utf8()
    } else {
        0
    }
}

/// The frontmatter between a first line `---` and the next line `---` (or `...`), and where the
/// body starts. None when the file does not open with `---`.
pub fn split_frontmatter(text: &str) -> Result<Option<(&str, usize)>, String> {
    let start = bom_len(text);
    let mut lines = LineIter::new(text, start);
    let Some((_, first, _)) = lines.next() else {
        return Ok(None);
    };
    if first.trim_end() != "---" {
        return Ok(None);
    }
    let content_start = lines.position();
    for (line_start, line, next) in lines {
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            return Ok(Some((&text[content_start..line_start], next)));
        }
    }
    Err("the frontmatter is not closed with a `---` line".to_owned())
}

/// Lines with their start offset and the offset of the next line, `\r\n` or `\n` ended.
struct LineIter<'a> {
    text: &'a str,
    pos: usize,
}

impl<'a> LineIter<'a> {
    fn new(text: &'a str, pos: usize) -> Self {
        Self { text, pos }
    }

    fn position(&self) -> usize {
        self.pos
    }
}

impl<'a> Iterator for LineIter<'a> {
    type Item = (usize, &'a str, usize);

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.text.len() {
            return None;
        }
        let start = self.pos;
        let rest = &self.text[start..];
        let (line, advance) = match rest.find('\n') {
            Some(i) => (&rest[..i], i + 1),
            None => (rest, rest.len()),
        };
        self.pos = start + advance;
        Some((start, line.strip_suffix('\r').unwrap_or(line), self.pos))
    }
}

fn first_line(body: &str) -> Option<&str> {
    body.lines()
        .map(|line| line.trim().trim_start_matches('#').trim())
        .find(|line| !line.is_empty())
}

#[derive(Debug, Clone, PartialEq)]
enum Value {
    Null,
    Text(String),
    List(Vec<String>),
    Map,
    Unsupported(&'static str),
}

#[derive(Debug)]
struct Entry {
    key: String,
    value: Result<Value, String>,
}

fn text_field(entries: &[Entry], key: &str) -> Result<Option<String>, String> {
    let Some(entry) = entries.iter().find(|entry| entry.key == key) else {
        return Ok(None);
    };
    match &entry.value {
        Ok(Value::Null) => Ok(None),
        Ok(Value::Text(text)) => Ok(Some(text.clone())),
        Ok(Value::List(_)) | Ok(Value::Map) => Err(format!("`{key}` must be text")),
        Ok(Value::Unsupported(why)) => Err(format!("`{key}`: {why}")),
        Err(error) => Err(format!("`{key}`: {error}")),
    }
}

fn optional_text(entries: &[Entry], key: &str, errors: &mut Vec<String>) -> Option<String> {
    match text_field(entries, key) {
        Ok(text) => text
            .map(|text| clean_text(text.trim()))
            .filter(|text| !text.is_empty()),
        Err(error) => {
            errors.push(error);
            None
        }
    }
}

/// YAML's booleans plus the spellings Claude Code accepts.
fn bool_field(entries: &[Entry], key: &str, default: bool, errors: &mut Vec<String>) -> bool {
    match text_field(entries, key) {
        Ok(None) => default,
        Ok(Some(text)) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" | "1" => true,
            "false" | "no" | "off" | "0" => false,
            _ => {
                errors.push(format!("`{key}` must be true or false"));
                default
            }
        },
        Err(error) => {
            errors.push(error);
            default
        }
    }
}

/// The top-level fields of the frontmatter. A structural problem (a line that is no field,
/// a field given twice, tab indentation) fails the whole block; a value that does not parse
/// fails only its own field.
fn read_mapping(src: &str, warnings: &mut Vec<String>) -> Result<Vec<Entry>, String> {
    struct Pending<'a> {
        key: String,
        line: usize,
        rest: &'a str,
        block: Vec<(usize, &'a str)>,
    }
    let mut entries: Vec<Entry> = Vec::new();
    let mut current: Option<Pending> = None;
    let finish = |pending: Option<Pending>,
                  entries: &mut Vec<Entry>,
                  warnings: &mut Vec<String>|
     -> Result<(), String> {
        let Some(pending) = pending else {
            return Ok(());
        };
        if entries.iter().any(|entry| entry.key == pending.key) {
            return Err(format!(
                "line {}: `{}` appears twice",
                pending.line, pending.key
            ));
        }
        let mut notes = Vec::new();
        let value = parse_value(pending.rest, &pending.block, &mut notes);
        for note in notes {
            warnings.push(format!("`{}`: {note}", pending.key));
        }
        entries.push(Entry {
            key: pending.key,
            value,
        });
        Ok(())
    };

    for (index, line) in src.lines().enumerate() {
        let number = index + 1;
        if line.trim().is_empty() {
            if let Some(pending) = current.as_mut() {
                pending.block.push((number, ""));
            }
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            if line.trim_start_matches(' ').starts_with('\t') {
                return Err(format!("line {number}: tabs cannot indent YAML"));
            }
            match current.as_mut() {
                Some(pending) => pending.block.push((number, line)),
                None => return Err(format!("line {number}: indented line outside a field")),
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let (key, rest) =
            split_key(line).ok_or_else(|| format!("line {number}: expected `field: value`"))?;
        finish(current.take(), &mut entries, warnings)?;
        current = Some(Pending {
            key,
            line: number,
            rest,
            block: Vec::new(),
        });
    }
    finish(current.take(), &mut entries, warnings)?;
    Ok(entries)
}

/// `key: rest` at the start of a line: a plain or quoted key, then a colon that ends the line
/// or is followed by a space.
fn split_key(line: &str) -> Option<(String, &str)> {
    let first = line.chars().next()?;
    if first == '"' || first == '\'' {
        let close = line[1..].find(first)? + 1;
        let key = line[1..close].to_owned();
        let after = line[close + 1..].trim_start_matches(' ');
        let rest = after.strip_prefix(':')?;
        if !(rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t')) {
            return None;
        }
        return Some((key, rest));
    }
    if matches!(
        first,
        '-' | '?' | '[' | ']' | '{' | '}' | ',' | '&' | '*' | '!' | '|' | '>' | '%' | '@' | '`'
    ) {
        return None;
    }
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b':'
            && (i + 1 == bytes.len() || bytes[i + 1] == b' ' || bytes[i + 1] == b'\t')
        {
            let key = line[..i].trim_end();
            if key.is_empty() || key.contains(" #") {
                return None;
            }
            return Some((key.to_owned(), &line[i + 1..]));
        }
        i += 1;
    }
    None
}

fn parse_value(
    rest: &str,
    block: &[(usize, &str)],
    notes: &mut Vec<String>,
) -> Result<Value, String> {
    let inline = rest.trim();
    if inline.is_empty() || inline.starts_with('#') {
        return block_value(block, notes);
    }
    match inline.chars().next() {
        Some('|') | Some('>') => block_scalar(inline, block).map(Value::Text),
        Some('"') => double_quoted(&joined(inline, block)).map(Value::Text),
        Some('\'') => single_quoted(&joined(inline, block)).map(Value::Text),
        Some('[') => flow_list(&joined(inline, block)),
        Some('{') => Ok(Value::Map),
        Some('&') | Some('*') | Some('!') => Ok(Value::Unsupported(
            "anchors, aliases and tags are not supported",
        )),
        Some('@') | Some('`') => {
            Err("a plain value cannot start with `@` or a backtick; quote it".to_owned())
        }
        _ => plain_scalar(inline, block, notes),
    }
}

/// The value on the lines below a `key:` with nothing after the colon.
fn block_value(block: &[(usize, &str)], notes: &mut Vec<String>) -> Result<Value, String> {
    let content: Vec<(usize, &str)> = block
        .iter()
        .copied()
        .filter(|(_, line)| {
            let trimmed = line.trim();
            !trimmed.is_empty() && !trimmed.starts_with('#')
        })
        .collect();
    let Some(&(_, first)) = content.first() else {
        return Ok(Value::Null);
    };
    let first_trimmed = first.trim_start();
    if first_trimmed == "-" || first_trimmed.starts_with("- ") {
        return block_list(&content);
    }
    if split_key(first_trimmed).is_some() {
        return Ok(Value::Map);
    }
    plain_scalar("", block, notes)
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

fn block_list(content: &[(usize, &str)]) -> Result<Value, String> {
    let indent = indent_of(content[0].1);
    let mut items: Vec<String> = Vec::new();
    for &(number, line) in content {
        let item_indent = indent_of(line);
        let trimmed = line.trim();
        if item_indent == indent && (trimmed == "-" || trimmed.starts_with("- ")) {
            let item = trimmed[1..].trim();
            items.push(match item.chars().next() {
                None => String::new(),
                Some('"') => double_quoted(item)?,
                Some('\'') => single_quoted(item)?,
                Some('[') | Some('{') | Some('-') => {
                    return Ok(Value::Unsupported(
                        "nested lists and maps are not supported",
                    ))
                }
                _ => strip_comment(item).to_owned(),
            });
        } else if item_indent > indent {
            let Some(last) = items.last_mut() else {
                return Err(format!("line {number}: unexpected indentation"));
            };
            if trimmed.starts_with("- ") || split_key(trimmed).is_some() {
                return Ok(Value::Unsupported(
                    "nested lists and maps are not supported",
                ));
            }
            if !last.is_empty() {
                last.push(' ');
            }
            last.push_str(strip_comment(trimmed));
        } else {
            return Err(format!("line {number}: list items must line up"));
        }
    }
    Ok(Value::List(items))
}

/// The inline text and the lines below it, for a quoted scalar or flow list that may continue.
fn joined(inline: &str, block: &[(usize, &str)]) -> String {
    let mut text = inline.to_owned();
    for (_, line) in block {
        text.push('\n');
        text.push_str(line);
    }
    text
}

fn strip_comment(text: &str) -> &str {
    let bytes = text.as_bytes();
    for i in 1..bytes.len() {
        if bytes[i] == b'#' && (bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            return text[..i].trim_end();
        }
    }
    text
}

/// A plain scalar over its first line and the indented lines below: lines folded into one,
/// an empty line kept as a line break.
fn plain_scalar(
    inline: &str,
    block: &[(usize, &str)],
    notes: &mut Vec<String>,
) -> Result<Value, String> {
    let mut lines: Vec<&str> = Vec::new();
    let first = strip_comment(inline);
    let mut ended = first.len() != inline.len();
    if !first.is_empty() {
        lines.push(first);
    }
    for (_, line) in block {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            ended = true;
            continue;
        }
        if ended && !trimmed.is_empty() {
            return Err("text continues after a comment".to_owned());
        }
        let content = strip_comment(trimmed);
        if content.len() != trimmed.len() {
            ended = true;
        }
        lines.push(content);
    }
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let text = fold_lines(&lines);
    if text.is_empty() || matches!(text.as_str(), "~" | "null" | "Null" | "NULL") {
        return Ok(Value::Null);
    }
    if text.contains(": ") {
        notes.push(
            "holds `: `, which strict YAML readers refuse in an unquoted value; put it in quotes"
                .to_owned(),
        );
    }
    Ok(Value::Text(text))
}

/// Joins lines with a space; an empty line becomes a line break.
fn fold_lines(lines: &[&str]) -> String {
    let mut out = String::new();
    let mut breaks = 0usize;
    let mut started = false;
    for line in lines {
        if line.is_empty() {
            breaks += 1;
            continue;
        }
        if started {
            if breaks == 0 {
                out.push(' ');
            } else {
                out.push_str(&"\n".repeat(breaks));
            }
        }
        out.push_str(line);
        breaks = 0;
        started = true;
    }
    out
}

#[derive(Clone, Copy, PartialEq)]
enum Chomp {
    Clip,
    Strip,
    Keep,
}

/// A literal (`|`) or folded (`>`) block scalar.
fn block_scalar(header: &str, block: &[(usize, &str)]) -> Result<String, String> {
    let literal = header.starts_with('|');
    let mut chomp = Chomp::Clip;
    let mut explicit: Option<usize> = None;
    let indicators = strip_comment(&header[1..]).trim_end();
    for c in indicators.chars() {
        match c {
            '-' if chomp == Chomp::Clip => chomp = Chomp::Strip,
            '+' if chomp == Chomp::Clip => chomp = Chomp::Keep,
            '1'..='9' if explicit.is_none() => explicit = Some(c as usize - '0' as usize),
            _ => return Err(format!("invalid block scalar header `{header}`")),
        }
    }
    let indent = match explicit {
        Some(indent) => indent,
        None => block
            .iter()
            .find(|(_, line)| !line.trim().is_empty())
            .map_or(0, |(_, line)| indent_of(line)),
    };
    let mut lines: Vec<&str> = Vec::with_capacity(block.len());
    for &(number, line) in block {
        if line.trim().is_empty() {
            lines.push("");
        } else if indent_of(line) < indent || indent == 0 {
            return Err(format!("line {number}: less indented than its block"));
        } else {
            lines.push(&line[indent..]);
        }
    }
    let trailing = lines
        .iter()
        .rev()
        .take_while(|line| line.is_empty())
        .count();
    let content = &lines[..lines.len() - trailing];
    let mut text = if literal {
        content.join("\n")
    } else {
        fold_block(content)
    };
    if content.is_empty() {
        return Ok(match chomp {
            Chomp::Keep => "\n".repeat(trailing),
            _ => String::new(),
        });
    }
    match chomp {
        Chomp::Strip => {}
        Chomp::Clip => text.push('\n'),
        Chomp::Keep => text.push_str(&"\n".repeat(trailing + 1)),
    }
    Ok(text)
}

/// YAML's folding of a `>` block: a break between two lines of text becomes a space, empty
/// lines become breaks, and lines indented further keep their breaks.
fn fold_block(lines: &[&str]) -> String {
    let mut out = String::new();
    let mut breaks = 0usize;
    let mut last_more: Option<bool> = None;
    for line in lines {
        if line.is_empty() {
            breaks += 1;
            continue;
        }
        let more = line.starts_with(' ') || line.starts_with('\t');
        match last_more {
            None => out.push_str(&"\n".repeat(breaks)),
            Some(previous_more) => {
                if !previous_more && !more {
                    if breaks == 0 {
                        out.push(' ');
                    } else {
                        out.push_str(&"\n".repeat(breaks));
                    }
                } else {
                    out.push_str(&"\n".repeat(breaks + 1));
                }
            }
        }
        out.push_str(line);
        breaks = 0;
        last_more = Some(more);
    }
    out
}

/// Folds the line breaks of a quoted scalar: one break between text is a space, each empty
/// line a break, and whitespace around breaks is dropped. With `escapes` (double quotes) a
/// backslash before a break joins the lines with nothing between them.
fn fold_flow(raw: &str, escapes: bool) -> String {
    enum Sep {
        Space,
        Breaks(usize),
        Nothing,
    }
    let lines: Vec<&str> = raw.split('\n').collect();
    let last = lines.len() - 1;
    let mut out = String::with_capacity(raw.len());
    let mut pending: Option<Sep> = None;
    for (i, line) in lines.iter().enumerate() {
        let is_last = i == last;
        let mut part = if i > 0 {
            line.trim_start_matches([' ', '\t'])
        } else {
            line
        };
        let escaped = escapes && !is_last && ends_with_odd_backslashes(part);
        if escaped {
            part = &part[..part.len() - 1];
        } else if !is_last {
            part = part.trim_end_matches([' ', '\t']);
        }
        if i > 0 && !is_last && !escaped && part.is_empty() {
            pending = match pending {
                Some(Sep::Space) => Some(Sep::Breaks(1)),
                Some(Sep::Breaks(n)) => Some(Sep::Breaks(n + 1)),
                other => other,
            };
            continue;
        }
        match pending.take() {
            Some(Sep::Space) => out.push(' '),
            Some(Sep::Breaks(n)) => out.push_str(&"\n".repeat(n)),
            Some(Sep::Nothing) | None => {}
        }
        out.push_str(part);
        pending = if is_last {
            None
        } else if escaped {
            Some(Sep::Nothing)
        } else {
            Some(Sep::Space)
        };
    }
    out
}

fn ends_with_odd_backslashes(text: &str) -> bool {
    (text.len() - text.trim_end_matches('\\').len()) % 2 == 1
}

fn after_closing(rest: &str) -> Result<(), String> {
    let rest = rest.trim();
    if rest.is_empty() || rest.starts_with('#') {
        Ok(())
    } else {
        Err("text after the closing quote".to_owned())
    }
}

/// Where the double-quoted scalar at the start of `text` closes, honouring escapes.
fn double_quote_end(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Some(i),
            _ => i += 1,
        }
    }
    None
}

fn double_quoted(text: &str) -> Result<String, String> {
    let end = double_quote_end(text).ok_or("the double quote is not closed")?;
    after_closing(&text[end + 1..])?;
    unescape(&fold_flow(&text[1..end], true))
}

fn unescape(text: &str) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let Some(escape) = chars.next() else {
            return Err("a backslash ends the value".to_owned());
        };
        let hex = |chars: &mut std::str::Chars, digits: usize| -> Result<char, String> {
            let code: String = chars.take(digits).collect();
            if code.len() != digits {
                return Err("an escape is cut short".to_owned());
            }
            u32::from_str_radix(&code, 16)
                .ok()
                .and_then(char::from_u32)
                .ok_or_else(|| format!("invalid escape `\\{escape}{code}`"))
        };
        out.push(match escape {
            '0' => '\0',
            'a' => '\u{7}',
            'b' => '\u{8}',
            't' | '\t' => '\t',
            'n' => '\n',
            'v' => '\u{b}',
            'f' => '\u{c}',
            'r' => '\r',
            'e' => '\u{1b}',
            ' ' => ' ',
            '"' => '"',
            '/' => '/',
            '\\' => '\\',
            'N' => '\u{85}',
            '_' => '\u{a0}',
            'L' => '\u{2028}',
            'P' => '\u{2029}',
            'x' => hex(&mut chars, 2)?,
            'u' => hex(&mut chars, 4)?,
            'U' => hex(&mut chars, 8)?,
            other => return Err(format!("unknown escape `\\{other}`")),
        });
    }
    Ok(out)
}

fn single_quote_end(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = 1;
    while i < bytes.len() {
        if bytes[i] == b'\'' {
            if bytes.get(i + 1) == Some(&b'\'') {
                i += 2;
                continue;
            }
            return Some(i);
        }
        i += 1;
    }
    None
}

fn single_quoted(text: &str) -> Result<String, String> {
    let end = single_quote_end(text).ok_or("the single quote is not closed")?;
    after_closing(&text[end + 1..])?;
    Ok(fold_flow(&text[1..end], false).replace("''", "'"))
}

/// `[a, "b", c]`, items scalars only.
fn flow_list(text: &str) -> Result<Value, String> {
    let mut items = Vec::new();
    let mut rest = text[1..].trim_start();
    loop {
        if let Some(after) = rest.strip_prefix(']') {
            after_closing(after)?;
            return Ok(Value::List(items));
        }
        let (item, after) = match rest.chars().next() {
            None => return Err("the list is not closed with `]`".to_owned()),
            Some('[') | Some('{') => {
                return Ok(Value::Unsupported(
                    "nested lists and maps are not supported",
                ))
            }
            Some('"') => {
                let end = double_quote_end(rest).ok_or("the double quote is not closed")?;
                (unescape(&fold_flow(&rest[1..end], true))?, &rest[end + 1..])
            }
            Some('\'') => {
                let end = single_quote_end(rest).ok_or("the single quote is not closed")?;
                (
                    fold_flow(&rest[1..end], false).replace("''", "'"),
                    &rest[end + 1..],
                )
            }
            _ => {
                let end = rest
                    .find([',', ']'])
                    .ok_or("the list is not closed with `]`")?;
                let item = rest[..end].split_whitespace().collect::<Vec<_>>().join(" ");
                (item, &rest[end..])
            }
        };
        if !item.is_empty() {
            items.push(item);
        }
        rest = after.trim_start();
        if let Some(after) = rest.strip_prefix(',') {
            rest = after.trim_start();
        } else if !rest.starts_with(']') {
            return Err("list items must be separated by commas".to_owned());
        }
    }
}

/// A frontmatter value for `text`: plain when YAML reads it back unchanged, else double-quoted.
pub fn yaml_scalar(text: &str) -> String {
    let plain = !text.is_empty()
        && text.trim() == text
        && !text.contains(": ")
        && !text.contains(" #")
        && !text.ends_with(':')
        && !text.chars().any(|c| c.is_control())
        && !matches!(
            text.chars().next(),
            Some(
                '-' | '?'
                    | ':'
                    | ','
                    | '['
                    | ']'
                    | '{'
                    | '}'
                    | '#'
                    | '&'
                    | '*'
                    | '!'
                    | '|'
                    | '>'
                    | '\''
                    | '"'
                    | '%'
                    | '@'
                    | '`'
            )
        )
        && !matches!(
            text.to_ascii_lowercase().as_str(),
            "~" | "null" | "true" | "false" | "yes" | "no" | "on" | "off"
        );
    if plain {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(text: &str) -> Result<SkillMeta, Vec<String>> {
        parse_skill(text, "pdf-tools")
    }

    fn field(text: &str) -> Result<Value, String> {
        let mut warnings = Vec::new();
        let entries = read_mapping(text, &mut warnings)?;
        entries.into_iter().next().unwrap().value
    }

    fn text(value: &str) -> Result<Value, String> {
        Ok(Value::Text(value.to_owned()))
    }

    #[test]
    fn reads_a_minimal_skill() {
        let source = "---\nname: pdf-tools\ndescription: Extract text from PDFs. Use when handling PDFs.\n---\n# PDF tools\n\nSteps.\n";
        let meta = skill(source).unwrap();
        assert_eq!(meta.name, "pdf-tools");
        assert_eq!(
            meta.description,
            "Extract text from PDFs. Use when handling PDFs."
        );
        assert_eq!(&source[meta.body_start..], "# PDF tools\n\nSteps.\n");
        assert!(meta.model_invocable && meta.user_invocable);
        assert!(meta.warnings.is_empty());
    }

    #[test]
    fn handles_crlf_and_a_byte_order_mark() {
        let source = "\u{feff}---\r\nname: pdf-tools\r\ndescription: Does PDFs\r\n---\r\nBody\r\n";
        let meta = skill(source).unwrap();
        assert_eq!(meta.description, "Does PDFs");
        assert_eq!(&source[meta.body_start..], "Body\r\n");
    }

    #[test]
    fn an_unclosed_frontmatter_is_an_error() {
        assert_eq!(
            skill("---\nname: pdf-tools\ndescription: x\n").unwrap_err(),
            vec!["the frontmatter is not closed with a `---` line".to_owned()]
        );
    }

    #[test]
    fn a_skill_without_frontmatter_uses_its_folder_and_first_line() {
        let meta = skill("# Fill PDF forms\n\nMore.").unwrap();
        assert_eq!(meta.name, "pdf-tools");
        assert_eq!(meta.description, "Fill PDF forms");
        assert_eq!(meta.body_start, 0);
        assert_eq!(meta.warnings.len(), 1);
    }

    #[test]
    fn missing_fields_fall_back_with_warnings() {
        let meta = skill("---\nlicense: MIT\n---\n\nFirst line.\n").unwrap();
        assert_eq!(meta.name, "pdf-tools");
        assert_eq!(meta.description, "First line.");
        assert_eq!(meta.license.as_deref(), Some("MIT"));
        assert_eq!(meta.warnings.len(), 2);
    }

    #[test]
    fn a_skill_with_no_description_anywhere_is_invalid() {
        assert_eq!(
            skill("---\nname: pdf-tools\n---\n\n").unwrap_err(),
            vec!["`description` is missing".to_owned()]
        );
    }

    #[test]
    fn name_rules_follow_the_specification() {
        assert!(validate_name("pdf-processing").is_ok());
        assert!(validate_name("a").is_ok());
        assert!(validate_name("v2-tools").is_ok());
        assert!(validate_name(&"a".repeat(64)).is_ok());
        for bad in [
            "",
            "PDF-Processing",
            "-pdf",
            "pdf-",
            "pdf--processing",
            "pdf_processing",
            "pdf processing",
            "café",
            "../x",
            "a<b>",
        ] {
            assert!(validate_name(bad).is_err(), "{bad:?} passed");
        }
        assert!(validate_name(&"a".repeat(65)).is_err());
    }

    #[test]
    fn an_invalid_name_or_long_description_fails_with_every_reason() {
        let long = "x".repeat(MAX_DESCRIPTION_CHARS + 1);
        let errors = skill(&format!(
            "---\nname: Bad--Name\ndescription: {long}\ncompatibility: {}\n---\n",
            "c".repeat(501)
        ))
        .unwrap_err();
        assert_eq!(errors.len(), 3, "{errors:?}");
        assert!(errors[0].contains("uppercase"));
        assert!(errors[1].contains("1025 characters"));
        assert!(errors[2].contains("501 characters"));
    }

    #[test]
    fn a_description_at_the_limit_is_fine() {
        let exact = "y".repeat(MAX_DESCRIPTION_CHARS);
        assert!(skill(&format!(
            "---\ndescription: {exact}\nname: pdf-tools\n---\n"
        ))
        .is_ok());
    }

    #[test]
    fn a_name_that_differs_from_its_folder_is_a_warning() {
        let meta = skill("---\nname: other\ndescription: d\n---\n").unwrap();
        assert_eq!(meta.name, "other");
        assert!(meta.warnings[0].contains("differs from its folder"));
    }

    #[test]
    fn reads_claude_code_switches() {
        let meta = skill(
            "---\nname: pdf-tools\ndescription: d\ndisable-model-invocation: yes\nuser-invocable: \"false\"\nargument-hint: \"[file]\"\n---\n",
        )
        .unwrap();
        assert!(!meta.model_invocable);
        assert!(!meta.user_invocable);
        assert_eq!(meta.argument_hint.as_deref(), Some("[file]"));
        assert_eq!(
            skill("---\nname: pdf-tools\ndescription: d\nuser-invocable: maybe\n---\n")
                .unwrap_err(),
            vec!["`user-invocable` must be true or false".to_owned()]
        );
    }

    #[test]
    fn unknown_and_unusual_fields_never_break_a_skill() {
        let meta = skill(
            "---\nname: pdf-tools\ndescription: d\nmetadata:\n  author: me\n  version: \"1.0\"\nhooks:\n  PreToolUse:\n    - matcher: Bash\nallowed-tools: Bash(git:*) Read\nweird: &anchor x\nflow: {a: 1}\n---\n",
        )
        .unwrap();
        assert_eq!(meta.name, "pdf-tools");
        assert!(meta.warnings.iter().any(|w| w.contains("allowed-tools")));
    }

    #[test]
    fn a_used_field_that_is_not_text_is_an_error() {
        assert_eq!(
            skill("---\nname: [a, b]\ndescription: d\n---\n").unwrap_err(),
            vec!["`name` must be text".to_owned()]
        );
        assert_eq!(
            skill("---\nname: pdf-tools\ndescription: *alias\n---\n").unwrap_err(),
            vec!["`description`: anchors, aliases and tags are not supported".to_owned()]
        );
    }

    #[test]
    fn structural_errors_name_the_line() {
        assert_eq!(
            skill("---\nname: a\nname: b\ndescription: d\n---\n").unwrap_err(),
            vec!["frontmatter: line 2: `name` appears twice".to_owned()]
        );
        assert_eq!(
            skill("---\nname: a\njust text\n---\n").unwrap_err(),
            vec!["frontmatter: line 2: expected `field: value`".to_owned()]
        );
        assert_eq!(
            skill("---\nname: a\ndescription: |\n\tTabbed\n---\n").unwrap_err(),
            vec!["frontmatter: line 3: tabs cannot indent YAML".to_owned()]
        );
        assert_eq!(
            skill("---\n  name: a\n---\n").unwrap_err(),
            vec!["frontmatter: line 1: indented line outside a field".to_owned()]
        );
    }

    #[test]
    fn plain_scalars_fold_and_drop_comments() {
        assert_eq!(field("d: one # note"), text("one"));
        assert_eq!(field("d: a#b"), text("a#b"));
        assert_eq!(
            field("d: first\n  second\n\n  third"),
            text("first second\nthird")
        );
        assert_eq!(
            field("d:\n  on the next line\n  and on"),
            text("on the next line and on")
        );
        assert_eq!(field("d: ~"), Ok(Value::Null));
        assert_eq!(field("d:"), Ok(Value::Null));
        assert!(field("d: `cmd`").is_err());
    }

    #[test]
    fn a_colon_in_a_plain_value_warns() {
        let meta = skill("---\nname: pdf-tools\ndescription: Use when: PDFs\n---\n").unwrap();
        assert_eq!(meta.description, "Use when: PDFs");
        assert!(meta.warnings[0].contains("strict YAML"));
    }

    #[test]
    fn quoted_scalars() {
        assert_eq!(field(r#"d: "a \"b\" \u00e9\n""#), text("a \"b\" é\n"));
        assert_eq!(field("d: 'it''s # here' # comment"), text("it's # here"));
        assert_eq!(
            field("d: \"one\n  two\n\n  three\""),
            text("one two\nthree")
        );
        assert_eq!(field("d: \"joined\\\n  word\""), text("joinedword"));
        assert_eq!(field("d: 'multi\n  line'"), text("multi line"));
        assert!(field("d: \"open").is_err());
        assert!(field("d: \"a\" trailing").is_err());
        assert!(field(r#"d: "\q""#).is_err());
    }

    #[test]
    fn block_scalars_follow_yaml() {
        assert_eq!(
            field("d: |\n  line one\n  line two\n"),
            text("line one\nline two\n")
        );
        assert_eq!(
            field("d: |-\n  kept\n    indented\n"),
            text("kept\n  indented")
        );
        assert_eq!(field("d: |+\n  a\n\n"), text("a\n\n"));
        assert_eq!(
            field("d: >\n  folded\n  text\n\n  next\n    more\n  end\n"),
            text("folded text\nnext\n  more\nend\n")
        );
        assert_eq!(field("d: >-\n  x\n  y"), text("x y"));
        assert_eq!(field("d: |2\n   three\n"), text(" three\n"));
        assert_eq!(field("d: |\n"), text(""));
        assert!(field("d: |\n    deep\n  shallow\n").is_err());
        assert!(field("d: |x\n  a\n").is_err());
    }

    #[test]
    fn lists_and_maps() {
        assert_eq!(
            field("d: [Bash, \"Read\", 'Write' ]"),
            Ok(Value::List(vec![
                "Bash".into(),
                "Read".into(),
                "Write".into()
            ]))
        );
        assert_eq!(
            field("d:\n  - one\n  - \"two\"\n  - three # c\n"),
            Ok(Value::List(vec![
                "one".into(),
                "two".into(),
                "three".into()
            ]))
        );
        assert_eq!(field("d:\n  a: 1\n  b: 2"), Ok(Value::Map));
        assert_eq!(
            field("d: [a, [b]]"),
            Ok(Value::Unsupported(
                "nested lists and maps are not supported"
            ))
        );
        assert!(field("d: [a, b").is_err());
        assert!(field("d:\n  - a\n - b").is_err());
    }

    #[test]
    fn quoted_keys() {
        assert_eq!(field("\"d\": x"), text("x"));
        assert!(split_key("url: http://x").is_some());
        assert_eq!(split_key("a:b"), None);
        assert_eq!(split_key("- a: b"), None);
    }

    #[test]
    fn descriptions_lose_control_and_direction_characters() {
        let meta =
            skill("---\nname: pdf-tools\ndescription: \"safe\\u202Etext\\u0007 here\"\n---\n")
                .unwrap();
        assert_eq!(meta.description, "safetext here");
    }

    #[test]
    fn yaml_scalar_round_trips() {
        for value in [
            "Plain text, with commas.",
            "Use when: you need it",
            "- starts with a dash",
            "true",
            "ends with a colon:",
            "has \"quotes\" and \\ slashes",
            "line\nbreak",
            " padded ",
            "a # not a comment",
            "'quoted'",
            "Unicode é and emoji-free",
        ] {
            let source = format!("d: {}", yaml_scalar(value));
            assert_eq!(field(&source), text(value), "{source}");
        }
        assert_eq!(yaml_scalar("simple"), "simple");
    }
}
