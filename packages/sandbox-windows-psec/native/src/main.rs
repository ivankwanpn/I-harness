mod command_line;
mod error;
mod ffi;
mod job;
mod policy;
mod protocol;
mod runner;
mod self_child;
mod transport;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--self-child") {
        self_child::run(&args[2..]);
        return;
    }
    if args.get(1).map(String::as_str) == Some("--probe") {
        let discovered = ffi::PsecApi::load();
        let (available, flags, error) = match discovered {
            Ok(api) => (api.flags & 1 != 0, api.flags, None),
            Err(e) => (false, 0, Some(e)),
        };
        println!(
            "{}",
            serde_json::json!({"version":1,"helperVersion":"0.1.0","target":"x86_64-pc-windows-msvc","psecDiscovery":available,"supportFlags":flags,"error":error,"assurance":"experimental","engines":{
            "psec":{"available":available,"writeIsolation":available,"readIsolation":false,"denyPaths":available&&flags&2!=0,"pipes":true,"pty":false,"retainedTree":true,"hiddenConsole":false},
            "unrestricted":{"available":true,"writeIsolation":false,"readIsolation":false,"denyPaths":false,"pipes":true,"pty":true,"retainedTree":true,"hiddenConsole":true}
            }})
        );
        return;
    }
    if args.get(1).map(String::as_str) == Some("--create-close") {
        let result = ffi::PsecApi::load().and_then(|api| {
            let bytes = policy::serialize(&[], &policy::volume_roots()?, &[]);
            api.create(&bytes)
        });
        match result {
            Ok(psec) => {
                drop(psec);
                println!(
                    "{}",
                    serde_json::json!({"version":1,"created":true,"closed":true})
                );
            }
            Err(e) => {
                println!(
                    "{}",
                    serde_json::json!({"version":1,"created":false,"error":e})
                );
                std::process::exit(1);
            }
        }
        return;
    }
    if let Err(error) = runner::run() {
        runner::fatal(error);
        std::process::exit(1);
    }
}
