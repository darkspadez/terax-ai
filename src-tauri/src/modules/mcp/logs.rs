//! A bounded log per MCP server: what it wrote to stderr (and stray stdout),
//! and Terax's own notes on its lifecycle. Settings reads it. Kept per server
//! id, not per process, so a crashed server's last words stay readable after
//! it is gone and across restarts.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// Lines kept per server.
const MAX_LINES: usize = 2000;
/// Text kept per server, summed over its lines.
const MAX_BYTES: usize = 512 * 1024;
/// One line is cut here; a server can print a megabyte without a newline.
pub const MAX_LINE_BYTES: usize = 2048;
/// Servers whose logs are kept; the least recently written go first.
const MAX_SERVERS: usize = 64;
/// Lines returned by one read.
const MAX_READ_LINES: usize = 500;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stderr,
    Stdout,
    Terax,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub seq: u64,
    pub at_ms: u64,
    pub stream: Stream,
    pub text: String,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub lines: Vec<LogLine>,
    /// Pass back as `after` to read only what came since.
    pub next: u64,
    /// Lines between `after` and the first returned one were dropped.
    pub gap: bool,
}

#[derive(Default)]
struct Ring {
    lines: VecDeque<LogLine>,
    bytes: usize,
    touched: u64,
}

#[derive(Default)]
struct Inner {
    rings: HashMap<String, Ring>,
    seq: u64,
    clock: u64,
}

#[derive(Default)]
pub struct LogStore(Mutex<Inner>);

/// Lossy UTF-8, control characters other than tab removed (a line is shown as
/// text, never interpreted), cut to `MAX_LINE_BYTES` on a char boundary.
pub fn clean_line(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let mut out = String::with_capacity(text.len().min(MAX_LINE_BYTES));
    for ch in text.chars() {
        if ch.is_control() && ch != '\t' {
            continue;
        }
        if out.len() + ch.len_utf8() > MAX_LINE_BYTES {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl LogStore {
    pub fn push(&self, server: &str, stream: Stream, text: String) {
        self.push_at(server, stream, text, now_ms());
    }

    fn push_at(&self, server: &str, stream: Stream, text: String, at_ms: u64) {
        if text.is_empty() {
            return;
        }
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.seq += 1;
        inner.clock += 1;
        let (seq, clock) = (inner.seq, inner.clock);
        if !inner.rings.contains_key(server) && inner.rings.len() >= MAX_SERVERS {
            if let Some(oldest) = inner
                .rings
                .iter()
                .min_by_key(|(_, ring)| ring.touched)
                .map(|(id, _)| id.clone())
            {
                inner.rings.remove(&oldest);
            }
        }
        let ring = inner.rings.entry(server.to_owned()).or_default();
        ring.touched = clock;
        ring.bytes += text.len();
        ring.lines.push_back(LogLine {
            seq,
            at_ms,
            stream,
            text,
        });
        while ring.lines.len() > MAX_LINES || ring.bytes > MAX_BYTES {
            match ring.lines.pop_front() {
                Some(dropped) => ring.bytes -= dropped.text.len(),
                None => break,
            }
        }
    }

    /// Lines after `after` (all kept lines for 0), oldest first, at most
    /// `MAX_READ_LINES`; `next` continues from the last one returned.
    pub fn read(&self, server: &str, after: u64) -> LogPage {
        let inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(ring) = inner.rings.get(server) else {
            return LogPage {
                lines: Vec::new(),
                next: after,
                gap: false,
            };
        };
        let lines: Vec<LogLine> = ring
            .lines
            .iter()
            .filter(|line| line.seq > after)
            .take(MAX_READ_LINES)
            .cloned()
            .collect();
        let gap = after > 0 && lines.first().is_some_and(|line| line.seq > after + 1);
        let next = lines.last().map_or(after, |line| line.seq);
        LogPage { lines, next, gap }
    }

    pub fn clear(&self, server: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .rings
            .remove(server);
    }
}

/// Splits a byte stream into log lines, cutting each at `MAX_LINE_BYTES`
/// without buffering the rest of an endless line.
#[derive(Default)]
pub struct LineSplitter {
    line: Vec<u8>,
    overflow: bool,
}

impl LineSplitter {
    pub fn push(&mut self, chunk: &[u8], mut emit: impl FnMut(&[u8])) {
        for &b in chunk {
            if b == b'\n' {
                self.flush(&mut emit);
            } else if self.line.len() < MAX_LINE_BYTES {
                self.line.push(b);
            } else {
                self.overflow = true;
            }
        }
    }

    pub fn flush(&mut self, mut emit: impl FnMut(&[u8])) {
        if self.overflow {
            self.line.extend_from_slice("…".as_bytes());
        }
        if !self.line.is_empty() {
            emit(&self.line);
        }
        self.line.clear();
        self.overflow = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(page: &LogPage) -> Vec<&str> {
        page.lines.iter().map(|l| l.text.as_str()).collect()
    }

    #[test]
    fn reads_in_order_and_continues_from_next() {
        let logs = LogStore::default();
        logs.push("a", Stream::Stderr, "one".into());
        logs.push("a", Stream::Terax, "two".into());
        let page = logs.read("a", 0);
        assert_eq!(texts(&page), ["one", "two"]);
        assert!(!page.gap);
        logs.push("a", Stream::Stderr, "three".into());
        let more = logs.read("a", page.next);
        assert_eq!(texts(&more), ["three"]);
        assert_eq!(logs.read("a", more.next).lines, vec![]);
        assert_eq!(logs.read("a", more.next).next, more.next);
    }

    #[test]
    fn servers_have_separate_logs() {
        let logs = LogStore::default();
        logs.push("a", Stream::Stderr, "from a".into());
        logs.push("b", Stream::Stderr, "from b".into());
        assert_eq!(texts(&logs.read("a", 0)), ["from a"]);
        assert_eq!(texts(&logs.read("b", 0)), ["from b"]);
        assert!(logs.read("c", 0).lines.is_empty());
    }

    #[test]
    fn keeps_the_newest_lines_within_the_line_budget_and_reports_the_gap() {
        let logs = LogStore::default();
        for i in 0..MAX_LINES + 10 {
            logs.push("a", Stream::Stderr, format!("{i}"));
        }
        let page = logs.read("a", 0);
        assert_eq!(page.lines.len(), MAX_READ_LINES);
        assert_eq!(page.lines[0].text, "10");
        let later = logs.read("a", 3);
        assert!(later.gap, "lines 4 to 10 were dropped");
    }

    #[test]
    fn keeps_the_byte_budget() {
        let logs = LogStore::default();
        let line = "x".repeat(MAX_LINE_BYTES);
        for _ in 0..(MAX_BYTES / MAX_LINE_BYTES) + 5 {
            logs.push("a", Stream::Stderr, line.clone());
        }
        let inner = logs.0.lock().unwrap();
        let ring = &inner.rings["a"];
        assert!(ring.bytes <= MAX_BYTES);
        assert_eq!(ring.bytes, ring.lines.len() * MAX_LINE_BYTES);
    }

    #[test]
    fn forgets_the_least_recently_written_server_past_the_server_budget() {
        let logs = LogStore::default();
        for i in 0..MAX_SERVERS {
            logs.push(&format!("s{i}"), Stream::Terax, "x".into());
        }
        logs.push("s0", Stream::Terax, "again".into());
        logs.push("new", Stream::Terax, "x".into());
        assert!(!logs.read("s0", 0).lines.is_empty());
        assert!(logs.read("s1", 0).lines.is_empty(), "s1 was the oldest");
        assert!(!logs.read("new", 0).lines.is_empty());
    }

    #[test]
    fn clear_drops_a_server_log() {
        let logs = LogStore::default();
        logs.push("a", Stream::Stderr, "x".into());
        logs.clear("a");
        assert!(logs.read("a", 0).lines.is_empty());
    }

    #[test]
    fn clean_line_drops_control_characters_and_caps_length() {
        assert_eq!(
            clean_line(b"\x1b[31mred\x1b[0m\ttab\x07"),
            "[31mred[0m\ttab"
        );
        assert_eq!(clean_line(b"bad \xff byte"), "bad \u{fffd} byte");
        let long = clean_line(&vec![b'a'; MAX_LINE_BYTES + 10]);
        assert!(long.ends_with('…'));
        assert!(long.len() <= MAX_LINE_BYTES + '…'.len_utf8());
    }

    #[test]
    fn splitter_cuts_endless_lines_and_flushes_the_last() {
        let mut s = LineSplitter::default();
        let mut out: Vec<Vec<u8>> = Vec::new();
        s.push(b"one\ntw", |l| out.push(l.to_vec()));
        s.push(b"o\n\n", |l| out.push(l.to_vec()));
        s.push(&vec![b'z'; MAX_LINE_BYTES * 3], |l| out.push(l.to_vec()));
        s.flush(|l| out.push(l.to_vec()));
        assert_eq!(out[0], b"one");
        assert_eq!(out[1], b"two");
        assert_eq!(out.len(), 3);
        assert_eq!(out[2].len(), MAX_LINE_BYTES + "…".len());
    }
}
