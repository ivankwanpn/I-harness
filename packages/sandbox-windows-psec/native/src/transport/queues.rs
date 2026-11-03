//! Bounded payload queues. Closing admission wakes blocked publishers/receivers.
use std::{
    collections::VecDeque,
    sync::{Arc, Condvar, Mutex},
};
pub(super) enum TrySendError<T> {
    Full(T),
    Disconnected(T),
}
struct State<T> {
    queue: VecDeque<T>,
    priority: Option<T>,
    closed: bool,
    senders: usize,
}
struct Queue<T> {
    state: Mutex<State<T>>,
    changed: Condvar,
    capacity: usize,
}
pub(super) struct Sender<T>(Arc<Queue<T>>, bool);
pub(super) struct Receiver<T>(Arc<Queue<T>>);
pub(super) fn channel<T>(capacity: usize) -> (Sender<T>, Receiver<T>) {
    let queue = Arc::new(Queue {
        state: Mutex::new(State {
            queue: VecDeque::new(),
            priority: None,
            closed: false,
            senders: 1,
        }),
        changed: Condvar::new(),
        capacity,
    });
    (Sender(queue.clone(), true), Receiver(queue))
}
impl<T> Clone for Sender<T> {
    fn clone(&self) -> Self {
        self.0
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .senders += 1;
        Self(self.0.clone(), true)
    }
}
impl<T> Drop for Sender<T> {
    fn drop(&mut self) {
        if self.1 {
            self.0
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .senders -= 1;
            self.0.changed.notify_all();
        }
    }
}
impl<T> Sender<T> {
    pub(super) fn controller(&self) -> Self {
        Self(self.0.clone(), false)
    }
    pub(super) fn try_send(&self, value: T) -> Result<(), TrySendError<T>> {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return Err(TrySendError::Disconnected(value));
        }
        if state.queue.len() == self.0.capacity {
            return Err(TrySendError::Full(value));
        }
        state.queue.push_back(value);
        drop(state);
        self.0.changed.notify_all();
        Ok(())
    }
    pub(super) fn send(&self, value: T) -> Result<(), T> {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.queue.len() == self.0.capacity && !state.closed {
            state = self
                .0
                .changed
                .wait(state)
                .unwrap_or_else(|e| e.into_inner());
        }
        if state.closed {
            return Err(value);
        }
        state.queue.push_back(value);
        drop(state);
        self.0.changed.notify_all();
        Ok(())
    }
    pub(super) fn priority(&self, value: T) -> Result<(), T> {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed || state.priority.is_some() {
            return Err(value);
        }
        state.priority = Some(value);
        drop(state);
        self.0.changed.notify_all();
        Ok(())
    }
    pub(super) fn close(&self, discard: bool) -> VecDeque<T> {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        let drained = if discard {
            std::mem::take(&mut state.queue)
        } else {
            VecDeque::new()
        };
        drop(state);
        self.0.changed.notify_all();
        drained
    }
}
impl<T> Receiver<T> {
    pub(super) fn recv(&self) -> Result<T, ()> {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(value) = state.priority.take().or_else(|| state.queue.pop_front()) {
                drop(state);
                self.0.changed.notify_all();
                return Ok(value);
            }
            if state.closed || state.senders == 0 {
                return Err(());
            }
            state = self
                .0
                .changed
                .wait(state)
                .unwrap_or_else(|e| e.into_inner());
        }
    }
}
impl<T> Drop for Receiver<T> {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .closed = true;
        self.0.changed.notify_all();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_public_queue_still_admits_one_private_stop_and_drains_in_order() {
        let (tx, rx) = channel(8);
        for n in 0..8 {
            assert!(tx.try_send(n).is_ok());
        }
        assert!(matches!(tx.try_send(8), Err(TrySendError::Full(8))));
        tx.priority(99).unwrap();
        assert_eq!(rx.recv(), Ok(99));
        for n in 0..8 {
            assert_eq!(rx.recv(), Ok(n));
        }
        drop(tx);
        assert!(rx.recv().is_err());
    }
    #[test]
    fn cancelled_capacity_waiter_returns_its_undelivered_payload() {
        let (tx, _rx) = channel(1);
        tx.send(1).unwrap();
        let blocked = tx.clone();
        let worker = std::thread::spawn(move || blocked.send(2));
        assert_eq!(tx.close(true).into_iter().collect::<Vec<_>>(), vec![1]);
        assert_eq!(worker.join().unwrap(), Err(2));
    }
}
