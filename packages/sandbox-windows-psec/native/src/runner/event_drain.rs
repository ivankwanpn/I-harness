use super::{
    running::Running,
    status::{failure, status},
};
use crate::{error::Result, transport::Event};
use std::sync::mpsc::Receiver;

pub(super) fn drain_events(events: &Receiver<Event>, running: &mut Option<Running>) -> Result<()> {
    while let Ok(event) = events.try_recv() {
        match event {
            Event::RetainedHandle(handle) => {
                if let Some(r) = running.as_mut() {
                    r.retain_handle(handle);
                }
            }
            Event::Reader(result) | Event::Output(result) => {
                if let Err(e) = result {
                    if let Some(r) = running.as_mut() {
                        r.output_failed(e);
                    }
                }
            }
            Event::InputClosed | Event::ConsoleClosed => {}
            Event::Bridge(crate::msys::Observation::Ready) => {}
            Event::Input(id, result) | Event::Bridge(crate::msys::Observation::Ack(id, result)) => {
                match result {
                    _ if id == "_owned-stop" => {
                        if let Some(r) = running.as_mut() {
                            if let Err(error) = result {
                                // ESRCH can race a natural exit already in the
                                // controller pipe. Other failures remain diagnostic.
                                if error.native_code != Some(3) {
                                    r.remember(error);
                                }
                            }
                        }
                    }
                    Ok(()) => status(&id, "ack", serde_json::json!({}))?,
                    Err(e) => failure(&id, e)?,
                }
            }
            Event::Bridge(crate::msys::Observation::Root(code)) => {
                if let Some(r) = running.as_mut() {
                    r.observe_msys_root(code);
                }
            }
            Event::BridgeDone(result) => {
                if let Some(r) = running.as_mut() {
                    r.observe_bridge_done(result);
                }
            }
        }
    }
    Ok(())
}
