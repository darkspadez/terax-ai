use std::time::{Duration, Instant};

use memchr::{memchr, memchr2};

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const OSC_INTRO: u8 = b']';
const ST_FINAL: u8 = b'\\';

const OSC_MAX: usize = 2048;

/// Generic attention (OSC 9, or an OSC 777 that is not ours) repeats while an
/// agent waits: once the status is already `Waiting`, further requests inside
/// this window are the same moment of attention and are not re-emitted.
const ATTENTION_REPEAT: Duration = Duration::from_secs(3);

/// Commands that arm the detector from `OSC 133;C`, and the agent each runs.
const DEFAULT_AGENTS: &[(&str, &str)] = &[
    ("claude", "claude"),
    ("codex", "codex"),
    ("gemini", "gemini"),
    ("pi", "pi"),
    ("opencode", "opencode"),
    ("grok", "grok"),
    ("agy", "antigravity"),
    ("gjc", "gjc"),
];

// OSC 777 marker our agent hooks emit. Legacy 3-field `notify;Oarlock;<event>`
// (Claude) or 4-field `notify;Oarlock;<agent>;<event>` (Codex, Gemini, Pi,
// Antigravity, and any other agent that emits it).
const OARLOCK_MARKER: &[u8] = b"notify;Oarlock;";

/// Longest agent name a marker may carry, in characters; the rest is cut.
const AGENT_NAME_MAX: usize = 32;

/// The agent name of a 4-field marker as display text, or `None` when nothing
/// visible is left. PTY output is untrusted, so any name is accepted but only
/// as a label: control and bidi characters are dropped and the length capped.
fn sanitize_agent_name(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    let name: String = text
        .chars()
        .filter(|&c| !is_hidden_name_char(c))
        .take(AGENT_NAME_MAX)
        .collect();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// C0/C1 controls, line and paragraph separators, and bidi controls, which
/// could reorder or hide the text around the name.
fn is_hidden_name_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
        )
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Ground,
    Esc,
    Osc,
    OscEsc,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Status {
    Working,
    Waiting,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Transition {
    Started { agent: String },
    Working,
    Attention,
    Finished,
    Exited,
}

#[derive(Clone, serde::Serialize)]
pub struct AgentSignal {
    pub id: u32,
    pub kind: &'static str,
    pub agent: Option<String>,
}

impl Transition {
    pub fn into_signal(self, id: u32) -> AgentSignal {
        match self {
            Transition::Started { agent } => {
                AgentSignal { id, kind: "started", agent: Some(agent) }
            }
            Transition::Working => AgentSignal { id, kind: "working", agent: None },
            Transition::Attention => AgentSignal { id, kind: "attention", agent: None },
            Transition::Finished => AgentSignal { id, kind: "finished", agent: None },
            Transition::Exited => AgentSignal { id, kind: "exited", agent: None },
        }
    }
}

pub struct AgentDetector {
    agents: &'static [(&'static str, &'static str)],
    state: State,
    osc: Vec<u8>,
    armed: bool,
    status: Status,
    /// When generic attention was last emitted; consulted only while armed.
    last_attention: Option<Instant>,
    clock: fn() -> Instant,
}

impl AgentDetector {
    pub fn new() -> Self {
        Self::with_clock(DEFAULT_AGENTS, Instant::now)
    }

    fn with_clock(agents: &'static [(&'static str, &'static str)], clock: fn() -> Instant) -> Self {
        Self {
            agents,
            state: State::Ground,
            osc: Vec::new(),
            armed: false,
            status: Status::Working,
            last_attention: None,
            clock,
        }
    }

    /// Feed a chunk of raw PTY output. Transitions come only from OSC sequences
    /// (`133` prompt boundaries, our `777` hook marker), never from raw output,
    /// so a TUI agent that repaints continuously never flaps working/waiting.
    pub fn process<F: FnMut(Transition)>(&mut self, input: &[u8], mut emit: F) {
        let mut i = 0;
        while i < input.len() {
            match self.state {
                State::Ground => {
                    // Output without an escape is never interesting.
                    let Some(esc) = memchr(ESC, &input[i..]) else {
                        return;
                    };
                    self.state = State::Esc;
                    i += esc + 1;
                }
                State::Esc => {
                    let b = input[i];
                    i += 1;
                    match b {
                        OSC_INTRO => {
                            self.state = State::Osc;
                            self.osc.clear();
                        }
                        ESC => {}
                        _ => self.state = State::Ground,
                    }
                }
                State::Osc => {
                    // The body runs to BEL or ESC; copy it as one run.
                    let rest = &input[i..];
                    let end = memchr2(BEL, ESC, rest).unwrap_or(rest.len());
                    let room = OSC_MAX - self.osc.len();
                    if end > room {
                        // Oversized: drop it and resume plain scanning after
                        // the byte that overflowed.
                        self.osc.clear();
                        self.state = State::Ground;
                        i += room + 1;
                        continue;
                    }
                    self.osc.extend_from_slice(&rest[..end]);
                    i += end;
                    match rest.get(end) {
                        Some(&BEL) => {
                            i += 1;
                            self.finish_osc(&mut emit);
                            self.state = State::Ground;
                        }
                        Some(_) => {
                            i += 1;
                            self.state = State::OscEsc;
                        }
                        None => {}
                    }
                }
                State::OscEsc => {
                    let b = input[i];
                    i += 1;
                    match b {
                        ST_FINAL => {
                            self.finish_osc(&mut emit);
                            self.state = State::Ground;
                        }
                        ESC => {}
                        _ => {
                            self.osc.clear();
                            self.state = State::Ground;
                        }
                    }
                }
            }
        }
    }

    /// Called when the underlying PTY closes. Reports the agent as exited so the
    /// UI doesn't leave a stale entry if the shell died mid-command.
    pub fn finish<F: FnMut(Transition)>(&mut self, mut emit: F) {
        if self.armed {
            self.disarm();
            emit(Transition::Exited);
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
        self.status = Status::Working;
        self.last_attention = None;
    }

    fn note_attention(&mut self) {
        self.last_attention = Some((self.clock)());
    }

    fn finish_osc<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        let body = std::mem::take(&mut self.osc);
        let (ps, pt) = match body.iter().position(|&c| c == b';') {
            Some(i) => (&body[..i], &body[i + 1..]),
            None => (&body[..], &body[0..0]),
        };
        match ps {
            b"133" => self.handle_osc133(pt, emit),
            // OSC 9;4 is taskbar progress, not a notification.
            b"9" if !pt.starts_with(b"4;") && pt != b"4" => self.generic_attention(emit),
            b"777" => self.handle_osc777(pt, emit),
            _ => {}
        }
    }

    fn handle_osc777<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        if let Some(tail) = pt.strip_prefix(OARLOCK_MARKER) {
            // Any agent that emits the marker is reported, known or not; its
            // name is sanitized here and stays a label everywhere after.
            let (agent, event) = match tail.iter().position(|&c| c == b';') {
                Some(i) => {
                    let Some(name) = sanitize_agent_name(&tail[..i]) else {
                        return;
                    };
                    (name, &tail[i + 1..])
                }
                None => ("claude".to_string(), tail),
            };
            let agent = agent.as_str();
            // Self-arms when no shell preexec fired (bash, Windows, tmux).
            match event {
                b"working" => {
                    self.ensure_armed(agent, emit);
                    self.set_working(emit);
                }
                b"attention" => {
                    self.ensure_armed(agent, emit);
                    self.status = Status::Waiting;
                    self.note_attention();
                    emit(Transition::Attention);
                }
                b"finished" => {
                    self.ensure_armed(agent, emit);
                    self.status = Status::Waiting;
                    self.note_attention();
                    emit(Transition::Finished);
                }
                _ => {}
            }
            return;
        }
        self.generic_attention(emit);
    }

    fn handle_osc133<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        match pt.first() {
            Some(b'C') => {
                if self.armed {
                    return;
                }
                let cmd = pt.strip_prefix(b"C;").unwrap_or(b"");
                if let Some(agent) = self.match_agent(cmd) {
                    self.armed = true;
                    self.status = Status::Working;
                    emit(Transition::Started { agent });
                }
            }
            Some(b'D') if self.armed => {
                self.disarm();
                emit(Transition::Exited);
            }
            _ => {}
        }
    }

    fn ensure_armed<F: FnMut(Transition)>(&mut self, agent: &str, emit: &mut F) {
        if !self.armed {
            self.armed = true;
            self.status = Status::Working;
            emit(Transition::Started { agent: agent.to_string() });
        }
    }

    fn set_working<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if self.status != Status::Working {
            self.status = Status::Working;
            emit(Transition::Working);
        }
    }

    /// Emits on the transition into `Waiting`. While already waiting, a repeat
    /// is the same moment of attention unless enough time has passed for it to
    /// plausibly be the next turn (agents without hooks never report
    /// `working`, so the status alone cannot tell the two apart).
    fn generic_attention<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if !self.armed {
            return;
        }
        let now = (self.clock)();
        let repeat = self.status == Status::Waiting
            && self
                .last_attention
                .is_some_and(|last| now.saturating_duration_since(last) < ATTENTION_REPEAT);
        if repeat {
            return;
        }
        self.status = Status::Waiting;
        self.last_attention = Some(now);
        emit(Transition::Attention);
    }

    fn match_agent(&self, cmd: &[u8]) -> Option<String> {
        let cmd = std::str::from_utf8(cmd).ok()?;
        for token in cmd.split_whitespace() {
            if token.starts_with('-') {
                continue;
            }
            let base = token.rsplit(['/', '\\']).next().unwrap_or(token);
            if let Some((_, agent)) = self.agents.iter().find(|(command, _)| {
                base.strip_prefix(command)
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
            }) {
                return Some((*agent).to_string());
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(d: &mut AgentDetector, input: &[u8]) -> Vec<Transition> {
        let mut out = Vec::new();
        d.process(input, |t| out.push(t));
        out
    }

    fn osc(body: &str) -> Vec<u8> {
        let mut v = vec![ESC, OSC_INTRO];
        v.extend_from_slice(body.as_bytes());
        v.extend_from_slice(&[ESC, ST_FINAL]);
        v
    }

    fn started(agent: &str) -> Transition {
        Transition::Started { agent: agent.into() }
    }

    #[test]
    fn arms_on_agent_command() {
        let mut d = AgentDetector::new();
        assert_eq!(run(&mut d, &osc("133;C;claude -p hello")), vec![started("claude")]);
    }

    #[test]
    fn arms_on_pi_command() {
        let mut d = AgentDetector::new();
        assert_eq!(run(&mut d, &osc("133;C;pi")), vec![started("pi")]);
    }

    #[test]
    fn arms_on_opencode_and_grok_commands() {
        for agent in ["opencode", "grok"] {
            let mut d = AgentDetector::new();
            assert_eq!(
                run(&mut d, &osc(&format!("133;C;{agent}"))),
                vec![started(agent)]
            );
        }
    }

    #[test]
    fn arms_on_pathed_and_wrapped_command() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;/usr/local/bin/codex exec")),
            vec![started("codex")]
        );
        let mut d2 = AgentDetector::new();
        assert_eq!(run(&mut d2, &osc("133;C;npx claude")), vec![started("claude")]);
    }

    #[test]
    fn arms_on_dash_suffixed_alias() {
        let mut d = AgentDetector::new();
        assert_eq!(run(&mut d, &osc("133;C;claude-enigma")), vec![started("claude")]);
    }

    #[test]
    fn does_not_arm_on_other_commands() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("133;C;vim src/main.rs")).is_empty());
        assert!(run(&mut d, &osc("133;C;cat claude.txt")).is_empty());
        assert!(run(&mut d, &osc("133;C;claudexyz")).is_empty());
    }

    #[test]
    fn ignores_bell_and_plain_output() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert!(run(&mut d, &[BEL]).is_empty());
        assert!(run(&mut d, b"thinking...\x07more").is_empty());
    }

    #[test]
    fn oarlock_marker_drives_status() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(run(&mut d, &osc("777;notify;Oarlock;attention")), vec![Transition::Attention]);
        assert_eq!(run(&mut d, &osc("777;notify;Oarlock;working")), vec![Transition::Working]);
        assert!(run(&mut d, &osc("777;notify;Oarlock;working")).is_empty());
        assert_eq!(run(&mut d, &osc("777;notify;Oarlock;finished")), vec![Transition::Finished]);
    }

    #[test]
    fn oarlock_marker_auto_arms_without_preexec() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("777;notify;Oarlock;attention")),
            vec![started("claude"), Transition::Attention]
        );
    }

    #[test]
    fn four_field_marker_self_arms_named_agent() {
        // Fresh arm already implies Working, so `working` emits only Started.
        let mut d = AgentDetector::new();
        assert_eq!(run(&mut d, &osc("777;notify;Oarlock;codex;working")), vec![started("codex")]);
        let mut g = AgentDetector::new();
        assert_eq!(
            run(&mut g, &osc("777;notify;Oarlock;gemini;finished")),
            vec![started("gemini"), Transition::Finished]
        );
    }

    #[test]
    fn pi_marker_self_arms_and_drives_status() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("777;notify;Oarlock;pi;working")),
            vec![started("pi")]
        );
        assert_eq!(
            run(&mut d, &osc("777;notify;Oarlock;pi;finished")),
            vec![Transition::Finished]
        );
    }

    #[test]
    fn four_field_marker_reports_agents_oarlock_does_not_know() {
        for name in [
            "my-agent-9",
            "Some Agent",
            "\u{30A8}\u{30FC}\u{30B8}\u{30A7}\u{30F3}\u{30C8}",
        ] {
            let mut d = AgentDetector::new();
            assert_eq!(
                run(&mut d, &osc(&format!("777;notify;Oarlock;{name};attention"))),
                vec![started(name), Transition::Attention],
                "{name:?}"
            );
        }
    }

    #[test]
    fn marker_agent_names_are_sanitized_display_text() {
        let cases = [
            // Controls (C0, DEL, C1) are dropped.
            ("ev\u{1}il\r\n\t\u{7f}\u{85}\u{9b}", "evil"),
            // Bidi controls that could reorder the label go too.
            ("a\u{202E}b\u{2066}c\u{2069}\u{200F}\u{061C}d", "abcd"),
            ("x\u{2028}y\u{2029}", "xy"),
            ("  padded  ", "padded"),
            // Invalid UTF-8 is shown, not rejected.
            ("\u{FFFD}", "\u{FFFD}"),
        ];
        for (raw, shown) in cases {
            assert_eq!(
                sanitize_agent_name(raw.as_bytes()).as_deref(),
                Some(shown),
                "{raw:?}"
            );
        }
        assert_eq!(
            sanitize_agent_name(b"\xffgent").as_deref(),
            Some("\u{FFFD}gent")
        );
        let long = "x".repeat(AGENT_NAME_MAX + 10);
        assert_eq!(
            sanitize_agent_name(long.as_bytes())
                .unwrap()
                .chars()
                .count(),
            AGENT_NAME_MAX
        );
        let wide = "\u{1F600}".repeat(AGENT_NAME_MAX + 1);
        assert_eq!(
            sanitize_agent_name(wide.as_bytes())
                .unwrap()
                .chars()
                .count(),
            AGENT_NAME_MAX
        );
        for hidden in ["", "   ", "\u{1}\u{202E}\u{2066}"] {
            assert_eq!(sanitize_agent_name(hidden.as_bytes()), None, "{hidden:?}");
        }
    }

    #[test]
    fn a_marker_with_nothing_visible_to_name_does_not_arm() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("777;notify;Oarlock;\u{202E} ;attention")).is_empty());
        assert!(run(&mut d, &osc("777;notify;Oarlock;;working")).is_empty());
        assert_eq!(
            run(&mut d, &osc("777;notify;Oarlock;codex;attention")),
            vec![started("codex"), Transition::Attention]
        );
    }

    #[test]
    fn the_first_name_sticks_until_the_agent_exits() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("777;notify;Oarlock;first;working")),
            vec![started("first")]
        );
        assert_eq!(
            run(&mut d, &osc("777;notify;Oarlock;second;attention")),
            vec![Transition::Attention]
        );
    }

    #[test]
    fn antigravity_and_gjc_arm_on_their_commands_and_markers() {
        let mut d = AgentDetector::new();
        assert_eq!(run(&mut d, &osc("133;C;agy")), vec![started("antigravity")]);
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;gjc --continue")),
            vec![started("gjc")]
        );
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("777;notify;Oarlock;antigravity;finished")),
            vec![started("antigravity"), Transition::Finished]
        );
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("777;notify;Oarlock;gjc;working")),
            vec![started("gjc")]
        );
        assert_eq!(
            run(&mut d, &osc("777;notify;Oarlock;gjc;finished")),
            vec![Transition::Finished]
        );
    }

    #[test]
    fn unknown_names_never_arm_from_a_command_line() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("133;C;my-agent-9")).is_empty());
        assert!(run(&mut d, &osc("133;C;antigravity")).is_empty());
    }
    #[test]
    fn four_field_marker_drives_status_after_preexec() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;gemini"));
        assert_eq!(run(&mut d, &osc("777;notify;Oarlock;gemini;attention")), vec![Transition::Attention]);
        assert_eq!(run(&mut d, &osc("777;notify;Oarlock;gemini;working")), vec![Transition::Working]);
        assert_eq!(run(&mut d, &osc("777;notify;Oarlock;gemini;finished")), vec![Transition::Finished]);
    }

    thread_local! {
        static NOW: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
    }

    fn fake_now() -> Instant {
        NOW.with(|now| {
            let value = now.get().unwrap_or_else(Instant::now);
            now.set(Some(value));
            value
        })
    }

    fn advance(by: Duration) {
        NOW.with(|now| now.set(Some(fake_now() + by)));
    }

    fn timed() -> AgentDetector {
        AgentDetector::with_clock(DEFAULT_AGENTS, fake_now)
    }

    #[test]
    fn generic_osc777_and_osc9_attention_only_when_armed() {
        let mut d = timed();
        assert!(run(&mut d, &osc("777;notify;Other;ready")).is_empty());
        assert!(run(&mut d, &osc("9;needs you")).is_empty());
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(run(&mut d, &osc("777;notify;Codex;ready")), vec![Transition::Attention]);
        advance(ATTENTION_REPEAT);
        assert_eq!(run(&mut d, &osc("9;needs you")), vec![Transition::Attention]);
        assert!(run(&mut d, &osc("9;4;1;50")).is_empty());
    }

    #[test]
    fn repeated_generic_attention_is_one_transition_until_the_window_passes() {
        let mut d = timed();
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(run(&mut d, &osc("9;turn complete")), vec![Transition::Attention]);
        // A TUI that rings OSC 9 on every redraw must not flood the frontend.
        for _ in 0..500 {
            advance(Duration::from_millis(5));
            assert!(run(&mut d, &osc("9;still waiting")).is_empty());
        }
        // The next turn of an agent without hooks arrives much later.
        advance(ATTENTION_REPEAT);
        assert_eq!(run(&mut d, &osc("9;turn complete")), vec![Transition::Attention]);
    }

    #[test]
    fn a_new_turn_after_working_is_a_fresh_transition() {
        let mut d = timed();
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(run(&mut d, &osc("9;done")), vec![Transition::Attention]);
        assert_eq!(run(&mut d, &osc("777;notify;Oarlock;working")), vec![Transition::Working]);
        assert_eq!(run(&mut d, &osc("9;done again")), vec![Transition::Attention]);
    }

    #[test]
    fn a_hook_marker_and_its_generic_twin_are_one_attention() {
        let mut d = timed();
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(run(&mut d, &osc("777;notify;Oarlock;codex;finished")), vec![Transition::Finished]);
        assert!(run(&mut d, &osc("9;Agent turn complete")).is_empty());
        advance(ATTENTION_REPEAT);
        assert_eq!(run(&mut d, &osc("9;Agent turn complete")), vec![Transition::Attention]);
    }

    #[test]
    fn disarming_forgets_the_attention_window() {
        let mut d = timed();
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(run(&mut d, &osc("9;x")), vec![Transition::Attention]);
        run(&mut d, &osc("133;D;0"));
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(run(&mut d, &osc("9;x")), vec![Transition::Attention]);
    }

    #[test]
    fn plain_output_is_skipped_without_scanning_state_and_escapes_still_split_anywhere() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let big = vec![b'a'; 1024 * 1024];
        assert!(run(&mut d, &big).is_empty());
        let marker = osc("777;notify;Oarlock;attention");
        // Every split point of the marker, embedded in plain text.
        for split in 1..marker.len() {
            let mut d = AgentDetector::new();
            run(&mut d, &osc("133;C;claude"));
            let mut out = run(&mut d, &[&big[..100], &marker[..split]].concat());
            out.extend(run(&mut d, &[&marker[split..], &big[..100]].concat()));
            assert_eq!(out, vec![Transition::Attention], "split at {split}");
        }
    }

    #[test]
    fn a_body_that_ends_exactly_at_the_limit_still_terminates() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let body = format!("9;{}", "x".repeat(OSC_MAX - 2));
        assert_eq!(body.len(), OSC_MAX);
        assert_eq!(run(&mut d, &osc(&body)), vec![Transition::Attention]);
        let too_long = format!("9;{}", "x".repeat(OSC_MAX - 1));
        assert!(run(&mut d, &osc(&too_long)).is_empty());
        // The decoder resynchronises on the next sequence.
        assert_eq!(run(&mut d, &osc("777;notify;Oarlock;attention")), vec![Transition::Attention]);
    }

    #[test]
    fn exits_on_133d() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(run(&mut d, &osc("133;D;0")), vec![Transition::Exited]);
        assert!(run(&mut d, &osc("133;D;0")).is_empty());
    }

    #[test]
    fn bel_terminator_inside_osc_is_not_attention() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut seq = vec![ESC, OSC_INTRO];
        seq.extend_from_slice(b"0;set title");
        seq.push(BEL);
        assert!(run(&mut d, &seq).is_empty());
    }

    #[test]
    fn started_split_across_chunks() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &[ESC, OSC_INTRO]).is_empty());
        assert!(run(&mut d, b"133;C;cla").is_empty());
        let mut out = run(&mut d, b"ude");
        out.extend(run(&mut d, &[ESC, ST_FINAL]));
        assert_eq!(out, vec![started("claude")]);
    }

    #[test]
    fn finish_reports_exited_when_armed() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut out = Vec::new();
        d.finish(|t| out.push(t));
        assert_eq!(out, vec![Transition::Exited]);
        let mut out2 = Vec::new();
        d.finish(|t| out2.push(t));
        assert!(out2.is_empty());
    }

    #[test]
    fn oversized_osc_does_not_panic() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut seq = vec![ESC, OSC_INTRO];
        seq.extend(std::iter::repeat_n(b'x', OSC_MAX + 100));
        seq.extend_from_slice(&[ESC, ST_FINAL]);
        assert!(run(&mut d, &seq).is_empty());
        assert_eq!(run(&mut d, &osc("777;notify;Oarlock;attention")), vec![Transition::Attention]);
    }
}
