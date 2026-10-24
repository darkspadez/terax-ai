//! Newline-delimited JSON-RPC framing for MCP over stdio: one message per
//! line, no embedded newlines (the MCP stdio transport). Pure and tested.

/// The largest message a server may send. A line past it stops the server:
/// a partial message cannot be recovered, and the request waiting on it
/// fails at once instead of timing out.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// What one line of server output is.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    /// A JSON-RPC message (or batch) for the client.
    Message(Vec<u8>),
    /// Anything else a server printed to stdout (a banner, a stray log line),
    /// kept for its log instead of failing the protocol.
    Noise(Vec<u8>),
}

#[derive(Debug, PartialEq, Eq)]
pub struct Oversize {
    pub limit: usize,
}

impl std::fmt::Display for Oversize {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "sent a message over the {} MiB limit",
            self.limit / (1024 * 1024)
        )
    }
}

pub struct LineDecoder {
    buf: Vec<u8>,
    limit: usize,
}

impl Default for LineDecoder {
    fn default() -> Self {
        Self::with_limit(MAX_MESSAGE_BYTES)
    }
}

impl LineDecoder {
    pub fn with_limit(limit: usize) -> Self {
        Self {
            buf: Vec::new(),
            limit,
        }
    }

    /// Splits `chunk` into complete lines; a partial last line waits for the
    /// next chunk. Empty and whitespace-only lines are dropped.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Line>, Oversize> {
        let mut out = Vec::new();
        let mut rest = chunk;
        while let Some(at) = memchr::memchr(b'\n', rest) {
            let (line, tail) = rest.split_at(at);
            if self.buf.len() + line.len() > self.limit {
                return Err(Oversize { limit: self.limit });
            }
            let whole = if self.buf.is_empty() {
                line.to_vec()
            } else {
                let mut joined = std::mem::take(&mut self.buf);
                joined.extend_from_slice(line);
                joined
            };
            if let Some(line) = classify(whole) {
                out.push(line);
            }
            rest = &tail[1..];
        }
        if self.buf.len() + rest.len() > self.limit {
            return Err(Oversize { limit: self.limit });
        }
        self.buf.extend_from_slice(rest);
        Ok(out)
    }

    /// The unterminated line left when the stream ended, if any.
    pub fn finish(&mut self) -> Option<Line> {
        classify(std::mem::take(&mut self.buf))
    }
}

fn classify(mut line: Vec<u8>) -> Option<Line> {
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    let first = line.iter().position(|b| !b.is_ascii_whitespace())?;
    Some(match line[first] {
        b'{' | b'[' => Line::Message(line),
        _ => Line::Noise(line),
    })
}

/// A message the client sends, framed as one line. JSON never needs a raw
/// line break, so one in `message` would let it smuggle a second message.
pub fn encode(message: &str) -> Result<Vec<u8>, String> {
    if message.len() > MAX_MESSAGE_BYTES {
        return Err("mcp: message over the size limit".into());
    }
    if message.bytes().any(|b| matches!(b, b'\n' | b'\r' | 0)) {
        return Err("mcp: a message may not contain line breaks".into());
    }
    let mut framed = Vec::with_capacity(message.len() + 1);
    framed.extend_from_slice(message.as_bytes());
    framed.push(b'\n');
    Ok(framed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(s: &str) -> Line {
        Line::Message(s.as_bytes().to_vec())
    }

    #[test]
    fn splits_messages_on_newlines() {
        let mut d = LineDecoder::default();
        assert_eq!(
            d.push(b"{\"id\":1}\n{\"id\":2}\n").unwrap(),
            vec![message("{\"id\":1}"), message("{\"id\":2}")]
        );
    }

    #[test]
    fn joins_a_message_split_across_reads() {
        let mut d = LineDecoder::default();
        assert!(d.push(b"{\"jsonrpc\":").unwrap().is_empty());
        assert!(d.push(b"\"2.0\",").unwrap().is_empty());
        assert_eq!(
            d.push(b"\"id\":1}\n{").unwrap(),
            vec![message("{\"jsonrpc\":\"2.0\",\"id\":1}")]
        );
        assert_eq!(d.push(b"}\n").unwrap(), vec![message("{}")]);
    }

    #[test]
    fn strips_carriage_returns_and_skips_blank_lines() {
        let mut d = LineDecoder::default();
        assert_eq!(
            d.push(b"\r\n  \n{\"a\":1}\r\n\n").unwrap(),
            vec![message("{\"a\":1}")]
        );
    }

    #[test]
    fn keeps_text_that_is_not_json_rpc_apart_as_noise() {
        let mut d = LineDecoder::default();
        assert_eq!(
            d.push(b"Server listening on stdio\n[{\"id\":1}]\n")
                .unwrap(),
            vec![
                Line::Noise(b"Server listening on stdio".to_vec()),
                message("[{\"id\":1}]"),
            ]
        );
    }

    #[test]
    fn refuses_a_line_over_the_limit_even_before_its_newline() {
        let mut d = LineDecoder::with_limit(8);
        assert_eq!(d.push(b"{\"a\":1}\n").unwrap(), vec![message("{\"a\":1}")]);
        assert!(d.push(b"{\"ab\":").is_ok());
        assert_eq!(d.push(b"12}"), Err(Oversize { limit: 8 }));

        let mut d = LineDecoder::with_limit(8);
        assert_eq!(d.push(b"{\"abcdefg\":1}\n"), Err(Oversize { limit: 8 }));
    }

    #[test]
    fn exactly_the_limit_is_accepted() {
        let mut d = LineDecoder::with_limit(7);
        assert_eq!(d.push(b"{\"a\":1}\n").unwrap(), vec![message("{\"a\":1}")]);
    }

    #[test]
    fn finish_returns_an_unterminated_last_line() {
        let mut d = LineDecoder::default();
        assert!(d.push(b"{\"id\":9}").unwrap().is_empty());
        assert_eq!(d.finish(), Some(message("{\"id\":9}")));
        assert_eq!(d.finish(), None);
    }

    #[test]
    fn encode_appends_one_newline_and_refuses_embedded_breaks() {
        assert_eq!(encode("{\"id\":1}").unwrap(), b"{\"id\":1}\n");
        assert!(encode("{\"a\":1}\n{\"b\":2}").is_err());
        assert!(encode("{\"a\":\r1}").is_err());
        assert!(encode("{\"a\":\u{0}}").is_err());
    }
}
