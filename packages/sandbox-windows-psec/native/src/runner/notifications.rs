//! Private bounded reactor inbox. Payload queues and lifecycle wakes share one predicate.
use super::control::Control;
use crate::transport::Event;
use std::{
    collections::VecDeque,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

#[derive(Default)]
struct State {
    controls: VecDeque<Control>,
    replies: VecDeque<Event>,
    terminals: Vec<Arc<Mutex<Terminal>>>,
    changed: bool,
    control_closed: bool,
}
#[derive(Default)]
struct Terminal {
    handle: Option<crate::ffi::Handle>,
    results: [Option<Event>; 2],
    published: bool,
}
#[derive(Clone)]
pub(crate) struct EventSender {
    pub(crate) inbox: Arc<Inbox>,
    terminal: Option<Arc<Mutex<Terminal>>>,
}
impl EventSender {
    pub(crate) fn worker(&self) -> Self {
        let slot = Arc::new(Mutex::new(Terminal::default()));
        let mut state = self.inbox.state.lock().unwrap_or_else(|e| e.into_inner());
        assert!(state.terminals.len() < 8, "fixed shipping worker bound");
        state.terminals.push(slot.clone());
        Self {
            inbox: self.inbox.clone(),
            terminal: Some(slot),
        }
    }
    pub(crate) fn terminal_published(&self) -> bool {
        self.terminal
            .as_ref()
            .is_some_and(|slot| slot.lock().unwrap_or_else(|e| e.into_inner()).published)
    }
    pub(crate) fn send(&self, event: Event) -> Result<(), ()> {
        if let Some(slot) = &self.terminal {
            if matches!(
                event,
                Event::RetainedHandle(_)
                    | Event::Reader(_)
                    | Event::Output(_)
                    | Event::InputClosed
                    | Event::ConsoleClosed
                    | Event::BridgeDone(_)
            ) {
                let mut slot = slot.lock().unwrap_or_else(|e| e.into_inner());
                if let Event::RetainedHandle(handle) = event {
                    slot.handle = Some(handle);
                } else {
                    if slot.results[0].is_none() {
                        slot.results[0] = Some(event);
                    } else if slot.results[1].is_none() {
                        slot.results[1] = Some(event);
                    } else {
                        self.inbox.failed.store(true, Ordering::Release);
                    }
                    slot.published = true;
                }
                drop(slot);
                self.inbox.wake();
                return Ok(());
            }
        }
        self.inbox.send(event)
    }
}
#[derive(Default)]
pub(crate) struct Inbox {
    state: Mutex<State>,
    changed: Condvar,
    capacity: Condvar,
    failed: AtomicBool,
}
impl Inbox {
    pub(crate) fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }
    pub(crate) fn take_failure(&self) -> bool {
        self.failed.swap(false, Ordering::AcqRel)
    }
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub(crate) fn sender(self: &Arc<Self>) -> EventSender {
        EventSender {
            inbox: self.clone(),
            terminal: None,
        }
    }
    pub(crate) fn wake(&self) {
        self.state
            .lock()
            .unwrap_or_else(|e| {
                self.failed.store(true, Ordering::Release);
                e.into_inner()
            })
            .changed = true;
        self.changed.notify_one();
    }
    pub(crate) fn wait(&self, deadline: Option<Instant>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while !state.changed
            && !self.failed()
            && state.controls.is_empty()
            && state.replies.is_empty()
        {
            state = if let Some(deadline) = deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                let (state, result) = self
                    .changed
                    .wait_timeout(state, remaining)
                    .unwrap_or_else(|e| e.into_inner());
                if result.timed_out() {
                    return;
                }
                state
            } else {
                self.changed.wait(state).unwrap_or_else(|e| e.into_inner())
            };
        }
        state.changed = false;
    }
    pub(super) fn control(&self, control: Control) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.controls.len() == 16 && !state.control_closed {
            state = self.capacity.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        if state.control_closed {
            return false;
        }
        state.controls.push_back(control);
        drop(state);
        self.changed.notify_one();
        true
    }
    pub(super) fn take_control(&self) -> Option<Control> {
        let value = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .controls
            .pop_front();
        self.capacity.notify_all();
        value
    }
    pub(crate) fn controls_closed(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .control_closed
    }
    pub(crate) fn close_controls(&self) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .control_closed = true;
        self.capacity.notify_all();
    }
    pub(crate) fn send(&self, event: Event) -> Result<(), ()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.replies.len() == 32 {
            state = self.capacity.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        state.replies.push_back(event);
        drop(state);
        self.changed.notify_one();
        Ok(())
    }
    /// The sole consumer must never wait for its own reply capacity. Preserve
    /// FIFO by exchanging a full queue's oldest reply for its current work item,
    /// with the new response appended at the tail under the same mutex.
    pub(crate) fn publish_from_consumer(&self, event: Event) -> Option<Event> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let current = if state.replies.len() == 32 {
            state.replies.pop_front()
        } else {
            None
        };
        state.replies.push_back(event);
        drop(state);
        self.changed.notify_one();
        current
    }
    pub(crate) fn try_recv(&self) -> Result<Event, ()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        for terminal in &state.terminals {
            let mut slot = terminal.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(handle) = slot.handle.take() {
                return Ok(Event::RetainedHandle(handle));
            }
            if let Some(event) = slot.results[0].take().or_else(|| slot.results[1].take()) {
                return Ok(event);
            }
        }
        let value = state.replies.pop_front();
        drop(state);
        self.capacity.notify_all();
        value.ok_or(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    #[test]
    fn terminal_slot_bypasses_saturated_public_reply_capacity() {
        let inbox = Inbox::new();
        for n in 0..32 {
            inbox
                .send(Event::Input(format!("request-{n}"), Ok(())))
                .unwrap();
        }
        let worker = inbox.sender().worker();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let publisher = std::thread::spawn(move || {
            worker.send(Event::Output(Ok(()))).unwrap();
            done_tx.send(()).unwrap();
        });
        let published = done_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        if !published {
            while inbox.try_recv().is_ok() {}
        }
        publisher.join().unwrap();
        assert!(
            published,
            "worker terminal publication must not wait behind public replies"
        );
        assert!(matches!(inbox.try_recv(), Ok(Event::Output(Ok(())))));
        for _ in 0..32 {
            assert!(matches!(inbox.try_recv(), Ok(Event::Input(_, Ok(())))));
        }
    }
    #[test]
    fn lifecycle_publication_before_sleep_is_not_lost() {
        let inbox = Inbox::new();
        inbox.wake();
        assert!(
            inbox.state.lock().unwrap().changed,
            "lifecycle wake must persist before receiver sleeps"
        );
        inbox.wait(Some(Instant::now() + Duration::from_secs(1)));
        assert!(!inbox.state.lock().unwrap().changed);
    }
    #[test]
    fn control_capacity_waiter_is_released_by_retirement() {
        let inbox = Inbox::new();
        for _ in 0..16 {
            assert!(inbox.control(Control::Eof));
        }
        let publisher = inbox.clone();
        let thread = std::thread::spawn(move || publisher.control(Control::Eof));
        inbox.close_controls();
        assert!(!thread.join().unwrap());
    }
}
