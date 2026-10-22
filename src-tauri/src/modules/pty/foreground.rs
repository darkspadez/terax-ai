//! "Does the shell have child processes?" without forking `pgrep`.
//!
//! The close-tab guard asks this on the main thread, so it must be a cheap
//! kernel query: `proc_listchildpids` on macOS, `/proc/<pid>/task/*/children`
//! on Linux (with a `/proc/*/stat` parent scan for kernels built without
//! `CONFIG_PROC_CHILDREN`), and the existing ToolHelp snapshot on Windows.

#[cfg(target_os = "macos")]
pub(super) fn shell_has_children(shell_pid: u32) -> bool {
    // One slot is enough: only existence matters, and the kernel fills what
    // fits and reports the count it wrote.
    let mut child: libc::pid_t = 0;
    let listed = unsafe {
        libc::proc_listchildpids(
            shell_pid as libc::pid_t,
            (&mut child as *mut libc::pid_t).cast(),
            std::mem::size_of::<libc::pid_t>() as libc::c_int,
        )
    };
    listed > 0
}

#[cfg(target_os = "linux")]
pub(super) fn shell_has_children(shell_pid: u32) -> bool {
    use std::fs;
    let tasks = format!("/proc/{shell_pid}/task");
    let mut readable = false;
    if let Ok(entries) = fs::read_dir(&tasks) {
        for task in entries.flatten() {
            match fs::read_to_string(task.path().join("children")) {
                Ok(children) => {
                    readable = true;
                    if children_listed(&children) {
                        return true;
                    }
                }
                Err(_) => continue,
            }
        }
    }
    if readable {
        return false;
    }
    // No `children` files (CONFIG_PROC_CHILDREN is off): scan parents.
    fs::read_dir("/proc").is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            entry.file_name().to_str().is_some_and(|name| {
                name.bytes().all(|b| b.is_ascii_digit())
                    && fs::read_to_string(entry.path().join("stat"))
                        .ok()
                        .and_then(|stat| stat_parent(&stat))
                        == Some(shell_pid)
            })
        })
    })
}

/// A `children` file lists space-separated pids; empty means none.
#[cfg(any(target_os = "linux", test))]
fn children_listed(contents: &str) -> bool {
    contents.split_whitespace().next().is_some()
}

/// Parent pid from `/proc/<pid>/stat`: `pid (comm) state ppid ...` where
/// `comm` may itself contain spaces and parentheses, so anchor on the last `)`.
#[cfg(any(target_os = "linux", test))]
fn stat_parent(stat: &str) -> Option<u32> {
    let after = &stat[stat.rfind(')')? + 1..];
    after.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
pub(super) fn shell_has_children(shell_pid: u32) -> bool {
    // pgrep -P exits 0 when shell_pid has at least one child, 1 when none.
    std::process::Command::new("pgrep")
        .args(["-P", &shell_pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
pub(super) fn shell_has_children(shell_pid: u32) -> bool {
    any_child(shell_pid, |_| true)
}

/// Whether the shell has a child that can be reading its console: one built
/// for the console subsystem. A GUI app started from the shell (notepad, an
/// editor) is its child too but never reads the console, so the shell is
/// still at its prompt. A child whose image cannot be read counts.
#[cfg(windows)]
pub(super) fn shell_has_console_children(shell_pid: u32) -> bool {
    any_child(shell_pid, |pid| {
        image_subsystem(pid) != Some(IMAGE_SUBSYSTEM_WINDOWS_GUI)
    })
}

/// Whether any child of `parent` passes `wanted`, from a ToolHelp snapshot.
#[cfg(windows)]
fn any_child(parent: u32, mut wanted: impl FnMut(u32) -> bool) -> bool {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32 = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32>() as u32;
        let mut found = false;
        if Process32First(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ParentProcessID == parent && wanted(entry.th32ProcessID) {
                    found = true;
                    break;
                }
                if Process32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        found
    }
}

#[cfg(any(windows, test))]
const IMAGE_SUBSYSTEM_WINDOWS_GUI: u16 = 2;

/// The subsystem of a running process's executable, from its PE header.
#[cfg(windows)]
fn image_subsystem(pid: u32) -> Option<u16> {
    use std::io::Read;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let path = unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok =
            QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(process);
        if ok == 0 {
            return None;
        }
        std::ffi::OsString::from_wide(&buf[..len as usize])
    };
    let mut head = Vec::with_capacity(PE_HEAD_BYTES);
    std::fs::File::open(path)
        .ok()?
        .take(PE_HEAD_BYTES as u64)
        .read_to_end(&mut head)
        .ok()?;
    pe_subsystem(&head)
}

/// Enough of an executable to reach its optional header: linkers put the
/// PE header within the first few hundred bytes.
#[cfg(windows)]
const PE_HEAD_BYTES: usize = 4096;

/// The `Subsystem` field of a PE image (2 GUI, 3 console). It sits 68 bytes
/// into the optional header, after the 20-byte COFF header, in PE32 and
/// PE32+ alike.
#[cfg(any(windows, test))]
fn pe_subsystem(image: &[u8]) -> Option<u16> {
    if image.get(..2)? != b"MZ" {
        return None;
    }
    let pe = u32::from_le_bytes(image.get(0x3c..0x40)?.try_into().ok()?) as usize;
    if image.get(pe..pe.checked_add(4)?)? != b"PE\0\0" {
        return None;
    }
    let at = pe.checked_add(4 + 20 + 68)?;
    Some(u16::from_le_bytes(image.get(at..at + 2)?.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn children_files_list_pids_or_nothing() {
        assert!(!children_listed(""));
        assert!(!children_listed("  \n"));
        assert!(children_listed("1234 "));
        assert!(children_listed("1 2 3\n"));
    }

    #[test]
    fn stat_parent_survives_awkward_command_names() {
        assert_eq!(stat_parent("42 (zsh) S 7 42 42 0 -1"), Some(7));
        assert_eq!(stat_parent("42 (a b) c) S 9 42"), Some(9));
        assert_eq!(stat_parent("42 (x) S"), None);
        assert_eq!(stat_parent("garbage"), None);
    }

    /// A minimal PE image: DOS header, `PE\0\0` at `pe`, COFF header and an
    /// optional header whose `Subsystem` is `subsystem`.
    fn pe_image(pe: usize, magic: u16, subsystem: u16) -> Vec<u8> {
        let mut image = vec![0u8; pe + 4 + 20 + 96];
        image[..2].copy_from_slice(b"MZ");
        image[0x3c..0x40].copy_from_slice(&(pe as u32).to_le_bytes());
        image[pe..pe + 4].copy_from_slice(b"PE\0\0");
        let optional = pe + 4 + 20;
        image[optional..optional + 2].copy_from_slice(&magic.to_le_bytes());
        image[optional + 68..optional + 70].copy_from_slice(&subsystem.to_le_bytes());
        image
    }

    #[test]
    fn reads_the_subsystem_of_pe32_and_pe32_plus_images() {
        assert_eq!(
            pe_subsystem(&pe_image(0x80, 0x10b, IMAGE_SUBSYSTEM_WINDOWS_GUI)),
            Some(IMAGE_SUBSYSTEM_WINDOWS_GUI)
        );
        assert_eq!(pe_subsystem(&pe_image(0xf8, 0x20b, 3)), Some(3));
    }

    #[test]
    fn rejects_what_is_not_a_whole_pe_header() {
        let image = pe_image(0x80, 0x20b, 3);
        assert_eq!(pe_subsystem(b""), None);
        assert_eq!(pe_subsystem(b"#!/bin/sh\n"), None);
        assert_eq!(
            pe_subsystem(&image[..0x80 + 4 + 20 + 69]),
            None,
            "cut short"
        );
        let mut no_signature = image.clone();
        no_signature[0x80] = b'X';
        assert_eq!(pe_subsystem(&no_signature), None);
        let mut far = image;
        far[0x3c..0x40].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(pe_subsystem(&far), None, "header offset past the end");
    }

    #[cfg(unix)]
    #[test]
    fn detects_real_children_without_forking_a_helper() {
        let me = std::process::id();
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        assert!(shell_has_children(me), "the sleeping child is visible");
        let _ = child.kill();
        let _ = child.wait();
        // A leaf process (the child itself) has none.
        let leaf = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn leaf");
        assert!(!shell_has_children(leaf.id()));
        let mut leaf = leaf;
        let _ = leaf.kill();
        let _ = leaf.wait();
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_process_has_no_children() {
        // PID 0x7fff_fff0 is far above any real pid on supported systems.
        assert!(!shell_has_children(0x7fff_fff0));
    }
}
