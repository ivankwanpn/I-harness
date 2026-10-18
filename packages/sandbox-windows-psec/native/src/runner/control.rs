use crate::{
    error::{Error, Result},
    protocol::{self, Command},
};
use std::{
    io::{BufRead, BufReader},
    sync::mpsc::{self, Receiver},
    thread,
};

pub(super) enum Control {
    Command(Result<Command>),
    Eof,
}
pub(super) fn controls(file: std::fs::File) -> Receiver<Control> {
    let (tx, rx) = mpsc::sync_channel(16);
    thread::spawn(move || {
        let mut input = BufReader::new(file);
        let mut line = Vec::new();
        loop {
            let buf = match input.fill_buf() {
                Ok(b) => b,
                Err(e) => {
                    let _ = tx.send(Control::Command(Err(Error::io("read control", e))));
                    break;
                }
            };
            if buf.is_empty() {
                if !line.is_empty() {
                    let _ = tx.send(Control::Command(Err(Error::invalid(
                        "truncated control line",
                    ))));
                }
                break;
            }
            let n = buf
                .iter()
                .position(|b| *b == b'\n')
                .map_or(buf.len(), |i| i + 1);
            let complete = buf[n - 1] == b'\n';
            if line.len() + n > protocol::MAX_LINE {
                let _ = tx.send(Control::Command(Err(Error::invalid(
                    "control line limit exceeded",
                ))));
                break;
            }
            line.extend_from_slice(&buf[..n]);
            input.consume(n);
            if complete {
                let command = protocol::parse(&line);
                line.clear();
                if tx.send(Control::Command(command)).is_err() {
                    return;
                }
            }
        }
        let _ = tx.send(Control::Eof);
    });
    rx
}
