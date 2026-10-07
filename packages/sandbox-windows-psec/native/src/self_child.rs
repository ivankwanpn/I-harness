//! Explicit executable fixture mode. Never dispatched by a control command.
use std::{
    io::{Read, Write},
    thread,
    time::Duration,
};
use windows_sys::Win32::{Foundation::*, Security::*, System::Threading::*};
pub fn run(args: &[String]) {
    match args.first().map(String::as_str).unwrap_or("basic") {
        "console" => {
            let window = unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() };
            let visible = !window.is_null()
                && unsafe { windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible(window) }
                    != 0;
            println!(
                "{}",
                serde_json::json!({"consolePresent":!window.is_null(),"consoleVisible":visible})
            );
        }
        "basic" => {
            let mut token = std::ptr::null_mut();
            let mut value = 0u32;
            let mut len = 0;
            let mut observation = None;
            unsafe {
                if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0 {
                    if GetTokenInformation(
                        token,
                        TokenIsAppContainer,
                        (&mut value as *mut u32).cast(),
                        4,
                        &mut len,
                    ) != 0
                    {
                        observation = Some(value != 0);
                    }
                    CloseHandle(token);
                }
            }
            println!(
                "{}",
                serde_json::json!({"stdout":"self-child","marker":std::env::var("SANDBOX_MARKER").ok(),"tokenIsAppContainer":observation})
            );
            eprintln!("self-child-stderr");
            std::process::exit(17);
        }
        "descendant" => {
            let delay = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(500);
            thread::sleep(Duration::from_millis(delay));
            if let Some(path) = args.get(2) {
                std::fs::write(path, b"descendant-finished").unwrap();
            }
            println!("descendant-finished");
        }
        "console-descendant" => {
            let delay = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(500);
            thread::sleep(Duration::from_millis(delay));
            let window = unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() };
            let observation = serde_json::json!({"consolePresent":!window.is_null(),"consoleVisible":!window.is_null()&&unsafe {windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible(window)}!=0});
            if let Some(path) = args.get(2) {
                std::fs::write(path, observation.to_string()).unwrap();
            }
            println!("{observation}");
        }
        "spawn-descendant" | "spawn-console-descendant" => {
            let exe = std::env::current_exe().unwrap();
            let mut cmd = std::process::Command::new(exe);
            cmd.args([
                "--self-child",
                if args[0] == "spawn-console-descendant" {
                    "console-descendant"
                } else {
                    "descendant"
                },
            ])
            .args(&args[1..]);
            let child = cmd.spawn().unwrap();
            println!("descendant-pid={}", child.id());
            std::process::exit(17);
        }
        "echo" => {
            let mut buf = [0u8; 4096];
            loop {
                let n = std::io::stdin().read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                std::io::stdout().write_all(&buf[..n]).unwrap();
                std::io::stdout().flush().unwrap();
            }
        }
        "read-line" => {
            println!("read-line-ready");
            std::io::stdout().flush().unwrap();
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
            println!("received:{}", line.trim());
        }
        "filesystem" => {
            let rw = &args[1];
            let ro = &args[2];
            let denied = &args[3];
            let readonly_write = &args[4];
            println!(
                "{}",
                serde_json::json!({"readOnlyRead":std::fs::read_to_string(ro).ok(),"allowedWrite":std::fs::write(rw,b"allowed").is_ok(),"readOnlyWrite":std::fs::write(readonly_write,b"MUTATED").is_ok(),"deniedRead":std::fs::read(denied).is_ok(),"deniedWrite":std::fs::write(denied,b"MUTATED").is_ok()})
            );
        }
        "never-read" => thread::sleep(Duration::from_secs(60)),
        "flood" => {
            let chunk = vec![b'x'; 16384];
            loop {
                if std::io::stdout().write_all(&chunk).is_err() {
                    break;
                }
            }
        }
        _ => std::process::exit(64),
    }
}
