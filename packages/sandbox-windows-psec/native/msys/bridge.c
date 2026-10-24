#include "api.h"
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#if defined(IH_MSYS_CONTROLLED_SKIP_CHILD_RESTORE) && !defined(IH_MSYS_CONTROLLED_TRACE)
#error Child-restore counterfactual is confined to controlled trace builds.
#endif
#if defined(IH_MSYS_CONTROLLED_SEED_CHILD_POLICY) && !defined(IH_MSYS_CONTROLLED_TRACE)
#error Nondefault child policy is confined to controlled trace builds.
#endif
#if defined(IH_MSYS_CONTROLLED_RAW_CHILD) && !defined(IH_MSYS_CONTROLLED_TRACE)
#error Raw slave mode is confined to controlled trace builds.
#endif

/* One private parent owns this controller pipe. The child receives only the
 * slave tty; it never inherits the controller or its acknowledgements. */
static int status_fd;
static CRITICAL_SECTION status_lock;
static int status_lock_ready;
struct lifecycle {
    CRITICAL_SECTION lock;
    int wake[2], pending, child, child_exited, child_status, output_ended;
    int stop_requested, stop_submitted, owner_terminal;
    void *owner_thread;
    ih_sigset_t wait_set;
    struct input_state *input;
};
struct output_state { int master, fd; struct lifecycle *life; };
struct input_frame { unsigned int length; char id[129]; unsigned char bytes[16384]; };
struct input_state {
    int master, ended, stopping;
    unsigned int head, tail, count;
    char end_id[129];
    struct input_frame frames[8];
    CRITICAL_SECTION lock;
    HANDLE wake;
    int stop_wake[2];
};
static void write_all(int fd, const void *input, size_t length) {
    const unsigned char *bytes = input;
    while (length) {
        int64_t count = write(fd, bytes, length);
        if (count < 0 && *__errno() == 4) continue;
        if (count <= 0) _exit(91);
        bytes += count;
        length -= (size_t)count;
    }
}
static void fail(const char *api) {
    char line[160];
    int length = snprintf(line, sizeof(line), "ERROR %s %d\n", api, *__errno());
    if (status_lock_ready) EnterCriticalSection(&status_lock);
    if (length > 0 && length < sizeof(line)) write_all(status_fd, line, length);
    if (status_lock_ready) LeaveCriticalSection(&status_lock);
    _exit(91);
}
static void ack(const char *id, int error) {
    char line[160];
    int length = snprintf(line, sizeof(line), "ACK %s %d\n", id, error);
    if (length <= 0 || length >= sizeof(line)) _exit(91);
    if (status_lock_ready) EnterCriticalSection(&status_lock);
    write_all(status_fd, line, length);
    if (status_lock_ready) LeaveCriticalSection(&status_lock);
}
static void delivery_error(const char *id, int error) {
    char line[160];
    int length = snprintf(line, sizeof(line), "INPUT_ERROR %s %d\n", id, error);
    if (length <= 0 || length >= sizeof(line)) _exit(91);
    EnterCriticalSection(&status_lock); write_all(status_fd, line, length); LeaveCriticalSection(&status_lock);
}
static int read_all(int fd, void *output, size_t length) {
    unsigned char *bytes = output;
    while (length) {
        int64_t count = read(fd, bytes, length);
        if (count < 0 && *__errno() == 4) continue;
        if (count <= 0) return -1;
        bytes += count;
        length -= (size_t)count;
    }
    return 0;
}
/* Called with life->lock held: one readable byte represents the predicate.
 * Both pipe ends are nonblocking; EAGAIN preserves an existing readable wake. */
static void wake_lifecycle(struct lifecycle *life) {
    if (!life->pending) {
        unsigned char byte = 1;
        int64_t count;
        do { count = write(life->wake[1], &byte, 1); } while (count < 0 && *__errno() == 4);
        if (count != 1 && !(count < 0 && *__errno() == 11)) fail("wake-lifecycle");
        life->pending = 1;
    }
}
static void make_wake(int descriptors[2]) {
    if (pipe(descriptors) < 0) fail("pipe-wake");
    for (int i = 0; i < 2; i++) {
        int flags = fcntl(descriptors[i], 3);
        if (flags < 0 || fcntl(descriptors[i], 4, flags | 0x4000) < 0 || fcntl(descriptors[i], 2, 1) < 0) fail("fcntl-wake");
    }
}
static void stop_delivery(struct input_state *input) {
    EnterCriticalSection(&input->lock);
    int first = !input->stopping;
    input->stopping = input->ended = 1;
    LeaveCriticalSection(&input->lock);
    if (first) {
        unsigned char byte = 1;
        int64_t count;
        do { count = write(input->stop_wake[1], &byte, 1); } while (count < 0 && *__errno() == 4);
        if (count != 1 && !(count < 0 && *__errno() == 11)) fail("wake-stop-input");
        if (!SetEvent(input->wake)) fail("wake-input-stop");
    }
}
static void caught_child(int signal_number) { (void)signal_number; }
#ifdef IH_MSYS_CONTROLLED_SEED_CHILD_POLICY
static volatile LONG controlled_original_signal;
static void controlled_original_child(int signal_number) { InterlockedExchange(&controlled_original_signal, signal_number); }
#endif
#ifdef IH_MSYS_CONTROLLED_TRACE
static void trace_owner(const char *operation, int result, uint64_t value) {
    char line[192]; int length = snprintf(line, sizeof(line), "TRACE %s %d %llu\n", operation, result, (unsigned long long)value);
    EnterCriticalSection(&status_lock); write_all(status_fd, line, length); LeaveCriticalSection(&status_lock);
}
#else
#define trace_owner(operation, result, value) ((void)0)
#endif
static void publish_root(struct lifecycle *life, int status) {
    EnterCriticalSection(&life->lock);
    life->child_status = status; life->child_exited = 1;
    LeaveCriticalSection(&life->lock);
    int code = (status & 127) ? 128 + (status & 127) : (status >> 8) & 255;
    char line[64];
    int length = snprintf(line, sizeof(line), "ROOT %d\n", code);
    EnterCriticalSection(&status_lock); write_all(status_fd, line, length); LeaveCriticalSection(&status_lock);
    stop_delivery(life->input);
    EnterCriticalSection(&life->lock);
    life->owner_terminal = 1; wake_lifecycle(life);
    LeaveCriticalSection(&life->lock);
}
/* After handoff, this is the ONLY caller of kill(original_child) or waitpid.
 * The PID remains an unreaped child identity until this same thread observes
 * its terminal status. A controller wake is notification, never stop intent. */
static void *own_root(void *context) {
    struct lifecycle *life = context;
    int signal_number = 0, initial = 1;
    trace_owner("owner-start", 0, life->wait_set);
    for (;;) {
        EnterCriticalSection(&life->lock);
        int stop = life->stop_requested && !life->stop_submitted;
        if (stop) life->stop_submitted = 1;
        LeaveCriticalSection(&life->lock);
        if (initial || signal_number == IH_SIGCHLD || stop) {
            int status, observed;
            do { observed = waitpid(life->child, &status, IH_WNOHANG); } while (observed < 0 && *__errno() == 4);
            trace_owner("waitpid-return", observed, (uint64_t)stop);
            if (observed < 0) fail("waitpid-event");
            if (observed == life->child) { publish_root(life, status); return NULL; }
            if (observed != 0) fail("waitpid-identity");
            if (stop) {
                int killed = kill(life->child, 9);
                trace_owner("kill-return", killed, (uint64_t)*__errno());
                if (killed < 0) {
                    do { observed = waitpid(life->child, &status, IH_WNOHANG); } while (observed < 0 && *__errno() == 4);
                    if (observed != life->child) fail("kill-owned-child");
                } else {
                    /* N2-10: only a requested stop uses this exact-child
                     * blocking reap. MSYS may omit SIGCHLD after early kill. */
                    trace_owner("stop-waitpid-enter", 0, 0);
                    do { observed = waitpid(life->child, &status, 0); } while (observed < 0 && *__errno() == 4);
                    trace_owner("stop-waitpid-return", observed, 0);
                    if (observed != life->child) fail("stop-waitpid-identity");
                }
                publish_root(life, status); return NULL;
            }
        }
        initial = 0;
        trace_owner("sigwait-enter", signal_number, 0);
        int error = sigwait(&life->wait_set, &signal_number);
        trace_owner("sigwait-return", error, (uint64_t)signal_number);
        if (error) { *__errno() = error; fail("sigwait-owned-child"); }
    }
}
static void request_stop(struct lifecycle *life) {
    EnterCriticalSection(&life->lock);
    life->stop_requested = 1;
    /* The owner is joinable through the controller's later pthread_join.
     * Its terminal boundary uses this same lock; no wake targets a joined ID. */
    int error = life->owner_terminal ? 0 : pthread_kill(life->owner_thread, IH_SIGUSR1);
    LeaveCriticalSection(&life->lock);
    if (error) { *__errno() = error; fail("pthread-kill-owner"); }
    trace_owner("controller-stop-wake", error, 0);
}
static int consume_lifecycle(struct lifecycle *life) {
    EnterCriticalSection(&life->lock);
    if (life->pending) {
        unsigned char bytes[64];
        for (;;) {
            int64_t count = read(life->wake[0], bytes, sizeof(bytes));
            if (count > 0 || (count < 0 && *__errno() == 4)) continue;
            if (!(count < 0 && *__errno() == 11)) fail("drain-wake");
            break;
        }
        life->pending = 0;
    }
    int complete = life->child_exited && life->output_ended;
    LeaveCriticalSection(&life->lock);
    return complete;
}
static int valid_id(unsigned char ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' || ch == ':';
}
static void *relay_output(void *context) {
    struct output_state *state = context;
    unsigned char *buffer = malloc(16384);
    if (!buffer) fail("malloc-output");
    for (;;) {
        struct ih_pollfd fd = {state->master, 1, 0};
        int ready = poll(&fd, 1, -1);
        if (ready < 0 && *__errno() == 4) continue;
        if (ready < 0) fail("poll-output");
        if (!fd.revents) continue;
        int64_t length = read(state->master, buffer, 16384);
        if (length < 0 && *__errno() == 4) continue;
        if (length < 0 && *__errno() == 11) continue;
        if (length < 0 && *__errno() != 5) fail("read-master");
        if (length <= 0) break;
        write_all(state->fd, buffer, (size_t)length);
    }
    free(buffer);
    EnterCriticalSection(&state->life->lock);
    state->life->output_ended = 1; wake_lifecycle(state->life);
    LeaveCriticalSection(&state->life->lock);
    return NULL;
}
static void *deliver_input(void *context) {
    struct input_state *state = context;
    for (;;) {
        EnterCriticalSection(&state->lock);
        if (!state->count) {
            int stopping = state->stopping;
            LeaveCriticalSection(&state->lock);
            if (stopping) return NULL;
            if (WaitForSingleObject(state->wake, INFINITE) != WAIT_OBJECT_0) fail("input-wake");
            continue;
        }
        struct input_frame *frame = &state->frames[state->head];
        LeaveCriticalSection(&state->lock);
        /* MSYS master write holds input_mutex, which master read/poll also
         * needs in flush_to_slave. Wait outside write and submit one byte:
         * POLLOUT promises some pipe space, not space for the entire frame. */
        unsigned int offset = 0;
        int error = 0;
        while (offset < frame->length) {
            struct ih_pollfd fds[2] = {{state->master, 4, 0}, {state->stop_wake[0], 1, 0}};
            int ready = poll(fds, 2, -1);
            if (ready < 0 && *__errno() == 4) continue;
            if (ready < 0) { error = *__errno(); break; }
            EnterCriticalSection(&state->lock); int stopping = state->stopping; LeaveCriticalSection(&state->lock);
            if (stopping) { error = 125; break; }
            if (fds[1].revents & (8 | 16 | 32)) fail("input-stop-wake-closed");
            if (!(fds[0].revents & 4)) {
                if (fds[0].revents & (8 | 16 | 32)) { error = 5; break; }
                continue;
            }
            int64_t count = write(state->master, frame->bytes + offset, 1);
            if (count < 0 && *__errno() == 4) continue;
            if (count <= 0) { error = count < 0 ? *__errno() : 5; break; }
            offset += (unsigned int)count;
        }
        EnterCriticalSection(&state->lock);
        if (error) delivery_error(frame->id, error); else ack(frame->id, 0);
        state->head = (state->head + 1) % 8; state->count--;
        if (!state->count && state->end_id[0]) { ack(state->end_id, state->stopping ? 125 : 0); state->end_id[0] = 0; }
        LeaveCriticalSection(&state->lock);
    }
}
int main(int argc, char **argv) {
    if (argc < 7 || argv[5][0] != '-' || argv[5][1] != '-' || argv[5][2]) return 90;
    int cols = atoi(argv[2]), rows = atoi(argv[3]);
    if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) return 90;
    int raw[3];
    for (int i = 0; i < 3; i++) {
        raw[i] = dup(i);
        if (raw[i] < 0 || _setmode(raw[i], 0x10000) < 0 || fcntl(raw[i], 2, 1) < 0) return 91;
    }
    status_fd = raw[2];
    struct ih_winsize size = {(uint16_t)rows, (uint16_t)cols, 0, 0};
    ih_sigset_t wait_set, original_mask;
#ifdef IH_MSYS_CONTROLLED_SEED_CHILD_POLICY
    /* Pinned Cygwin signal.h: SIGTERM=15, SIGPIPE=13. Seed unrelated blocked
     * policy and a distinct disposition before capturing the original values. */
    ih_sigset_t seeded_mask;
    struct ih_sigaction seeded_action = {0};
    seeded_action.handler = controlled_original_child;
    if (sigemptyset(&seeded_mask) || sigaddset(&seeded_mask, 15) || pthread_sigmask(IH_SIG_BLOCK, &seeded_mask, NULL)
        || sigemptyset(&seeded_action.mask) || sigaddset(&seeded_action.mask, 13)
        || sigaction(IH_SIGCHLD, &seeded_action, NULL)) fail("controlled-original-policy");
#endif
#ifdef IH_MSYS_CONTROLLED_TRACE
    struct ih_sigaction original_child_action = {0}, child_action;
#else
    struct ih_sigaction original_child_action, child_action;
#endif
    if (sigemptyset(&wait_set) || sigaddset(&wait_set, IH_SIGCHLD) || sigaddset(&wait_set, IH_SIGUSR1)) fail("make-signal-set");
    int mask_error = pthread_sigmask(IH_SIG_BLOCK, &wait_set, &original_mask);
    if (mask_error) { *__errno() = mask_error; fail("block-owner-signals"); }
    child_action.handler = caught_child; child_action.flags = 0;
    if (sigemptyset(&child_action.mask) || sigaction(IH_SIGCHLD, &child_action, &original_child_action)) fail("catch-child-signal");
#ifdef IH_MSYS_CONTROLLED_TRACE
    /* Independent same-runtime no-fork round trip: observe any native
     * sigaction normalization rather than assuming its returned mask encoding. */
    struct ih_sigaction parent_roundtrip = {0};
    if (sigaction(IH_SIGCHLD, &original_child_action, NULL) || sigaction(IH_SIGCHLD, NULL, &parent_roundtrip)
        || sigaction(IH_SIGCHLD, &child_action, NULL)) fail("controlled-action-roundtrip");
    char roundtrip_line[192];
    int roundtrip_size = snprintf(roundtrip_line, sizeof(roundtrip_line), "TRACE parent-roundtrip %llu %d %llu\n",
        (unsigned long long)(uintptr_t)parent_roundtrip.handler, parent_roundtrip.flags, (unsigned long long)parent_roundtrip.mask);
    if (roundtrip_size <= 0 || roundtrip_size >= sizeof(roundtrip_line)) _exit(91);
    write_all(status_fd, roundtrip_line, (size_t)roundtrip_size);
#endif
    int master;
    int child = forkpty(&master, NULL, NULL, &size);
    if (child < 0) fail("forkpty");
    if (child == 0) {
        /* forkpty performed setsid/login_tty and closed this child's master.
         * Close every extra private descriptor before untrusted code starts. */
        char *end;
        HANDLE workload_job = (HANDLE)(uintptr_t)strtoull(argv[4], &end, 10);
        if (*end || !workload_job || !AssignProcessToJobObject(workload_job, GetCurrentProcess())) fail("assign-child-job");
        if (!CloseHandle(workload_job)) fail("close-child-job");
#ifdef IH_MSYS_CONTROLLED_RAW_CHILD
        struct ih_termios raw_policy;
        if (tcgetattr(0, &raw_policy)) fail("controlled-get-raw");
        cfmakeraw(&raw_policy);
        if (tcsetattr(0, 2, &raw_policy) || tcgetattr(0, &raw_policy)) fail("controlled-set-raw");
        if ((raw_policy.local & (0x0001 | 0x0002 | 0x0004)) || (raw_policy.output & 1) || raw_policy.cc[9] != 1 || raw_policy.cc[16] != 0) fail("controlled-verify-raw");
        char raw_line[160];
        int raw_size = snprintf(raw_line, sizeof(raw_line), "TRACE raw-child %u %u %u %u %u\n", raw_policy.local, raw_policy.output, (unsigned int)raw_policy.cc[9], (unsigned int)raw_policy.cc[16], (unsigned int)sizeof(raw_policy));
        write_all(status_fd, raw_line, (size_t)raw_size);
#endif
#ifndef IH_MSYS_CONTROLLED_TRACE
        for (int i = 0; i < 3; i++) close(raw[i]);
#endif
#ifndef IH_MSYS_CONTROLLED_SKIP_CHILD_RESTORE
        if (sigaction(IH_SIGCHLD, &original_child_action, NULL) || pthread_sigmask(IH_SIG_SETMASK, &original_mask, NULL)) _exit(91);
#endif
#ifdef IH_MSYS_CONTROLLED_TRACE
        /* Trusted pre-exec observation through the still-owned private fd.
         * Neither this branch nor the counterfactual exists in a normal build.
         * The same three descriptors are closed before any untrusted exec. */
        ih_sigset_t observed_mask = 0;
        struct ih_sigaction observed_action;
        int queried_mask = pthread_sigmask(IH_SIG_SETMASK, NULL, &observed_mask);
        int queried_action = sigaction(IH_SIGCHLD, NULL, &observed_action);
        if (queried_mask || queried_action) _exit(91);
        char policy_line[256];
        int policy_size = snprintf(policy_line, sizeof(policy_line), "TRACE child-preexec %llu %llu %llu %llu %d %d %llu %llu\n",
            (unsigned long long)original_mask, (unsigned long long)observed_mask,
            (unsigned long long)(uintptr_t)original_child_action.handler, (unsigned long long)(uintptr_t)observed_action.handler,
            original_child_action.flags, observed_action.flags,
            (unsigned long long)original_child_action.mask, (unsigned long long)observed_action.mask);
        if (policy_size <= 0 || policy_size >= sizeof(policy_line)) _exit(91);
        write_all(status_fd, policy_line, (size_t)policy_size);
        for (int i = 0; i < 3; i++) close(raw[i]);
#endif
        execv(argv[6], (const char *const *)(argv + 6));
        _exit(127);
    }
    HANDLE inherited_job = (HANDLE)(uintptr_t)strtoull(argv[4], NULL, 10);
    if (!CloseHandle(inherited_job)) fail("close-parent-job");
    if (fcntl(master, 2, 1) < 0) fail("fcntl-master");
    InitializeCriticalSection(&status_lock); status_lock_ready = 1;
    write_all(status_fd, "READY\n", 6);
    unsigned char *buffer = malloc(16384);
    if (!buffer) fail("malloc");
    struct lifecycle life;
    InitializeCriticalSection(&life.lock);
    life.pending = life.child_exited = life.child_status = life.output_ended = 0; life.child = child;
    life.stop_requested = life.stop_submitted = life.owner_terminal = 0; life.owner_thread = NULL; life.wait_set = wait_set;
    make_wake(life.wake);
    struct input_state *input = malloc(sizeof(struct input_state));
    if (!input) fail("malloc-input");
    input->master = master; input->ended = input->stopping = 0; input->head = input->tail = input->count = 0; input->end_id[0] = 0;
    InitializeCriticalSection(&input->lock);
    input->wake = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!input->wake) fail("create-input-wake");
    make_wake(input->stop_wake);
    life.input = input;
    void *input_thread;
    if (pthread_create(&input_thread, NULL, deliver_input, input)) fail("pthread-input");
    struct output_state output = {master, raw[1], &life};
    void *output_thread;
    if (pthread_create(&output_thread, NULL, relay_output, &output)) fail("pthread-create");
    EnterCriticalSection(&life.lock);
    int owner_error = pthread_create(&life.owner_thread, NULL, own_root, &life);
    LeaveCriticalSection(&life.lock);
    if (owner_error) { *__errno() = owner_error; fail("pthread-root-owner"); }
    for (;;) {
        if (consume_lifecycle(&life)) break;
        struct ih_pollfd fds[2] = {{raw[0], 1, 0}, {life.wake[0], 1, 0}};
        int ready = poll(fds, 2, -1);
        if (ready < 0 && *__errno() == 4) continue;
        if (ready < 0) fail("poll");
        if (fds[1].revents & (8 | 16 | 32)) fail("lifecycle-wake-closed");
        if (fds[0].revents & (1 | 16)) {
            unsigned char header[8], id[129];
            if (read_all(raw[0], header, 8) < 0) fail("controller-eof");
            unsigned int length = (unsigned int)header[4] | ((unsigned int)header[5] << 8) |
                ((unsigned int)header[6] << 16) | ((unsigned int)header[7] << 24);
            unsigned int id_length = header[1];
            if (!id_length || id_length > 128 || header[2] || header[3] || length > 16384 ||
                header[0] < 1 || header[0] > 4) fail("controller-header");
            if (read_all(raw[0], id, id_length) < 0 || read_all(raw[0], buffer, length) < 0) fail("controller-frame");
            for (unsigned int i = 0; i < id_length; i++) if (!valid_id(id[i])) fail("controller-id");
            id[id_length] = 0;
            if (header[0] == 1) {
                EnterCriticalSection(&input->lock);
                if (input->ended) { LeaveCriticalSection(&input->lock); ack((char *)id, 22); continue; }
                if (input->count == 8) { LeaveCriticalSection(&input->lock); ack((char *)id, 11); continue; }
                if (length) {
                    struct input_frame *frame = &input->frames[input->tail];
                    frame->length = length;
                    for (unsigned int i = 0; i <= id_length; i++) frame->id[i] = (char)id[i];
                    for (unsigned int i = 0; i < length; i++) frame->bytes[i] = buffer[i];
                    input->tail = (input->tail + 1) % 8; input->count++;
                    LeaveCriticalSection(&input->lock);
                    if (!SetEvent(input->wake)) fail("wake-input");
                    continue;
                }
                LeaveCriticalSection(&input->lock);
            } else if (header[0] == 2) {
                if (length) fail("end-input-length");
                EnterCriticalSection(&input->lock); input->ended = 1;
                if (input->count) { for (unsigned int i = 0; i <= id_length; i++) input->end_id[i] = (char)id[i]; LeaveCriticalSection(&input->lock); continue; }
                LeaveCriticalSection(&input->lock);
            } else if (header[0] == 3) {
                if (length != 4) fail("resize-length");
                size.cols = (uint16_t)(buffer[0] | (buffer[1] << 8));
                size.rows = (uint16_t)(buffer[2] | (buffer[3] << 8));
                if (!size.cols || size.cols > 1000 || !size.rows || size.rows > 1000) fail("resize-size");
                if (ioctl(master, (('T' << 8) | 2), &size) < 0) { ack((char *)id, *__errno()); continue; }
            } else {
                if (length) fail("stop-length");
                /* The native owner requests this only for its forkpty root.
                 * Let MSYS record SIGKILL before the nested Job terminates any
                 * remaining descendants; direct Win32 termination can lose
                 * the runtime's POSIX exit status. */
                stop_delivery(input);
                request_stop(&life);
            }
            ack((char *)id, 0);
        }
    }
    if (pthread_join(life.owner_thread, NULL) || pthread_join(output_thread, NULL)) fail("pthread-join");
    int child_status = life.child_status;
    stop_delivery(input);
    EnterCriticalSection(&input->lock);
    int pending = input->count != 0; input->stopping = 1;
    LeaveCriticalSection(&input->lock);
    if (pending) {
        /* Child exit and output drain are already observed. The remaining
         * accepted input has no receiver; do not join a blocked MSYS write or
         * claim delivery. The native owner rejects its unanswered requests.
         * Termination skips DLL locks held by that writer, exactly as native
         * cancellation does, while all external tree ownership remains native. */
        TerminateProcess(GetCurrentProcess(), (child_status & 127) ? 128 + (child_status & 127) : (child_status >> 8) & 255);
    }
    if (!SetEvent(input->wake) || pthread_join(input_thread, NULL)) fail("join-input");
    close(master); close(input->stop_wake[0]); close(input->stop_wake[1]);
    close(life.wake[0]); close(life.wake[1]); DeleteCriticalSection(&life.lock);
    CloseHandle(input->wake); DeleteCriticalSection(&input->lock); DeleteCriticalSection(&status_lock);
    free(buffer); free(input);
    return (child_status & 127) ? 128 + (child_status & 127) : (child_status >> 8) & 255;
}
