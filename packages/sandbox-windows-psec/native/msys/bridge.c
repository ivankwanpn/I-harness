#include "api.h"
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* One private parent owns this controller pipe. The child receives only the
 * slave tty; it never inherits the controller or its acknowledgements. */
static int status_fd;
static CRITICAL_SECTION status_lock;
static int status_lock_ready;
struct output_state { int master, fd; volatile LONG ended; };
struct input_frame { unsigned int length; char id[129]; unsigned char bytes[16384]; };
struct input_state {
    int master, ended, stopping;
    unsigned int head, tail, count;
    char end_id[129];
    struct input_frame frames[8];
    CRITICAL_SECTION lock;
    HANDLE wake;
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
        int ready = poll(&fd, 1, 100);
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
    InterlockedExchange(&state->ended, 1);
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
            struct ih_pollfd fd = {state->master, 4, 0};
            int ready = poll(&fd, 1, 100);
            if (ready < 0 && *__errno() == 4) continue;
            if (ready < 0) { error = *__errno(); break; }
            if (!(fd.revents & 4)) {
                if (fd.revents & (8 | 16 | 32)) { error = 5; break; }
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
        if (!state->count && state->end_id[0]) { ack(state->end_id, 0); state->end_id[0] = 0; }
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
        for (int i = 0; i < 3; i++) close(raw[i]);
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
    int child_exited = 0, child_status = 0;
    struct input_state *input = malloc(sizeof(struct input_state));
    if (!input) fail("malloc-input");
    input->master = master; input->ended = input->stopping = 0; input->head = input->tail = input->count = 0; input->end_id[0] = 0;
    InitializeCriticalSection(&input->lock);
    input->wake = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!input->wake) fail("create-input-wake");
    void *input_thread;
    if (pthread_create(&input_thread, NULL, deliver_input, input)) fail("pthread-input");
    struct output_state output = {master, raw[1], 0};
    void *output_thread;
    if (pthread_create(&output_thread, NULL, relay_output, &output)) fail("pthread-create");
    for (;;) {
        struct ih_pollfd fds[1] = {{raw[0], 1, 0}};
        int ready = poll(fds, 1, 100);
        if (ready < 0 && *__errno() != 4) fail("poll");
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
                if (!child_exited && kill(child, 9) < 0) { ack((char *)id, *__errno()); continue; }
            }
            ack((char *)id, 0);
        }
        if (!child_exited) {
            int observed = waitpid(child, &child_status, 1);
            if (observed == child) {
                int code = (child_status & 127) ? 128 + (child_status & 127) : (child_status >> 8) & 255;
                char line[64];
                int length = snprintf(line, sizeof(line), "ROOT %d\n", code);
                EnterCriticalSection(&status_lock); write_all(status_fd, line, length); LeaveCriticalSection(&status_lock);
                child_exited = 1;
            } else if (observed < 0 && *__errno() != 4) fail("waitpid");
        }
        if (child_exited && InterlockedCompareExchange(&output.ended, 0, 0)) break;
    }
    if (pthread_join(output_thread, NULL)) fail("pthread-join");
    if (!child_exited) {
        while (waitpid(child, &child_status, 0) < 0) if (*__errno() != 4) fail("waitpid");
        int code = (child_status & 127) ? 128 + (child_status & 127) : (child_status >> 8) & 255;
        char line[64];
        int length = snprintf(line, sizeof(line), "ROOT %d\n", code);
        EnterCriticalSection(&status_lock); write_all(status_fd, line, length); LeaveCriticalSection(&status_lock);
    }
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
    close(master); CloseHandle(input->wake); DeleteCriticalSection(&input->lock); DeleteCriticalSection(&status_lock);
    free(buffer); free(input);
    return (child_status & 127) ? 128 + (child_status & 127) : (child_status >> 8) & 255;
}
