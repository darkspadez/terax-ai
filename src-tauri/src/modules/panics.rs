//! Release builds unwind (see Cargo.toml): a panic off the main thread ends the
//! thread or task it happens on instead of the app. With no crash report left
//! behind, every panic is written to the app log as well as stderr.

use std::panic::{self, AssertUnwindSafe};

pub fn install_log_hook() {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        log::error!("thread '{}' {info}", thread.name().unwrap_or("<unnamed>"));
        previous(info);
    }));
}

/// Runs one unit of work of a long-lived thread so that a panic drops the unit
/// instead of ending the thread. Only for work whose state ends with the call
/// or recovers from lock poisoning.
pub fn isolate<T>(what: &str, work: impl FnOnce() -> T) -> Option<T> {
    match panic::catch_unwind(AssertUnwindSafe(work)) {
        Ok(value) => Some(value),
        Err(_) => {
            log::error!("{what} panicked and was skipped");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolate_returns_the_value_of_work_that_completes() {
        assert_eq!(isolate("work", || 7), Some(7));
    }

    #[test]
    fn isolate_contains_a_panic_so_the_caller_keeps_going() {
        let mut completed = 0;
        for round in 0..3 {
            if isolate("work", || assert_ne!(round, 1, "round one fails")).is_some() {
                completed += 1;
            }
        }
        assert_eq!(completed, 2);
    }
}
