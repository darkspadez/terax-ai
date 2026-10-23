//! What each window's MCP client reports about its servers, so Settings (its
//! own webview, with no client) can show starting, running, crashed or
//! stopped. Each app window runs its own clients; Settings combines them.

use std::collections::HashMap;

use super::names::valid_server_id;

const MAX_TEXT: usize = 2048;
const MAX_SERVERS_PER_WINDOW: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerState {
    Starting,
    Running,
    /// Closed unexpectedly; restarts after `retryAtMs` unless it gave up.
    Crashed,
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub server_id: String,
    pub state: ServerState,
    /// The last error, for a crashed server (or one that failed to start).
    pub error: Option<String>,
    /// The server's name and version, as it announced them.
    pub server_info: Option<String>,
    pub tool_count: Option<u32>,
    /// When the next automatic restart is due; none once it gave up.
    pub retry_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStatus {
    pub window: String,
    #[serde(flatten)]
    pub report: StatusReport,
}

fn clip(text: Option<String>) -> Option<String> {
    let text = text?;
    if text.len() <= MAX_TEXT {
        return Some(text);
    }
    let mut end = MAX_TEXT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(format!("{}…", &text[..end]))
}

#[derive(Default)]
pub struct StatusRegistry {
    reports: HashMap<(String, String), StatusReport>,
}

impl StatusRegistry {
    /// Records a window's report; a `Stopped` report removes the entry, so a
    /// window that stopped a server no longer counts for it.
    pub fn report(&mut self, window: &str, mut report: StatusReport) -> Result<(), String> {
        if !valid_server_id(&report.server_id) {
            return Err("mcp: invalid server id".into());
        }
        report.error = clip(report.error);
        report.server_info = clip(report.server_info);
        let key = (window.to_owned(), report.server_id.clone());
        if report.state == ServerState::Stopped {
            self.reports.remove(&key);
            return Ok(());
        }
        let known = self.reports.contains_key(&key);
        let count = self.reports.keys().filter(|(w, _)| w == window).count();
        if !known && count >= MAX_SERVERS_PER_WINDOW {
            return Err("mcp: too many servers".into());
        }
        self.reports.insert(key, report);
        Ok(())
    }

    /// Forgets a window (reloaded or closed); returns the servers it held.
    pub fn drop_window(&mut self, window: &str) -> Vec<String> {
        let mut dropped = Vec::new();
        self.reports.retain(|(w, server), _| {
            let keep = w != window;
            if !keep {
                dropped.push(server.clone());
            }
            keep
        });
        dropped
    }

    pub fn list(&self) -> Vec<WindowStatus> {
        let mut out: Vec<WindowStatus> = self
            .reports
            .iter()
            .map(|((window, _), report)| WindowStatus {
                window: window.clone(),
                report: report.clone(),
            })
            .collect();
        out.sort_by(|a, b| (&a.report.server_id, &a.window).cmp(&(&b.report.server_id, &b.window)));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(server: &str, state: ServerState) -> StatusReport {
        StatusReport {
            server_id: server.into(),
            state,
            error: None,
            server_info: None,
            tool_count: None,
            retry_at_ms: None,
        }
    }

    #[test]
    fn keeps_one_report_per_window_and_server() {
        let mut r = StatusRegistry::default();
        r.report("main", report("a", ServerState::Starting))
            .unwrap();
        r.report("main", report("a", ServerState::Running)).unwrap();
        r.report("w-1", report("a", ServerState::Crashed)).unwrap();
        let list = r.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].window, "main");
        assert_eq!(list[0].report.state, ServerState::Running);
        assert_eq!(list[1].report.state, ServerState::Crashed);
    }

    #[test]
    fn stopping_removes_the_report() {
        let mut r = StatusRegistry::default();
        r.report("main", report("a", ServerState::Running)).unwrap();
        r.report("main", report("a", ServerState::Stopped)).unwrap();
        assert!(r.list().is_empty());
    }

    #[test]
    fn dropping_a_window_forgets_its_servers_only() {
        let mut r = StatusRegistry::default();
        r.report("main", report("a", ServerState::Running)).unwrap();
        r.report("w-1", report("a", ServerState::Running)).unwrap();
        r.report("w-1", report("b", ServerState::Running)).unwrap();
        let mut dropped = r.drop_window("w-1");
        dropped.sort();
        assert_eq!(dropped, ["a", "b"]);
        assert_eq!(r.list().len(), 1);
    }

    #[test]
    fn refuses_bad_ids_and_clips_long_text() {
        let mut r = StatusRegistry::default();
        assert!(r
            .report("main", report("../x", ServerState::Running))
            .is_err());
        let mut long = report("a", ServerState::Crashed);
        long.error = Some("é".repeat(MAX_TEXT));
        r.report("main", long).unwrap();
        let error = r.list()[0].report.error.clone().unwrap();
        assert!(error.len() <= MAX_TEXT + '…'.len_utf8());
        assert!(error.ends_with('…'));
    }

    #[test]
    fn bounds_the_servers_of_one_window() {
        let mut r = StatusRegistry::default();
        for i in 0..MAX_SERVERS_PER_WINDOW {
            r.report("main", report(&format!("s{i}"), ServerState::Running))
                .unwrap();
        }
        assert!(r
            .report("main", report("extra", ServerState::Running))
            .is_err());
        assert!(r.report("main", report("s0", ServerState::Crashed)).is_ok());
        assert!(r
            .report("w-1", report("extra", ServerState::Running))
            .is_ok());
    }
}
