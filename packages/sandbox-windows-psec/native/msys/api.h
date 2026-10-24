#ifndef IH_MSYS_API_H
#define IH_MSYS_API_H
#include <stddef.h>
#include <stdint.h>

/* The public C ABI of the selected x86-64 MSYS runtime. These declarations
 * intentionally avoid mixing the Windows CRT's descriptors with MSYS ones.
 * Layouts/constants are checked against the pinned runtime-devel headers. */
struct ih_winsize { uint16_t rows, cols, xpixel, ypixel; };
struct ih_pollfd { int fd; short events, revents; };
/* Pinned x86-64 Cygwin/MSYS uses LP64 (unlike the compiling MSVC CRT).
 * sys/_sigset.h unsigned long is 64 bits; cygwin/signal.h sigaction is
 * handler pointer, sigset_t, int flags, then alignment padding. */
typedef uint64_t ih_sigset_t;
struct ih_sigaction { void (*handler)(int); ih_sigset_t mask; int flags; };
#define IH_SIGCHLD 20
#define IH_SIGUSR1 30
#define IH_SIG_BLOCK 1
#define IH_SIG_SETMASK 0
#define IH_WNOHANG 1
#define IH_API __declspec(dllimport)
IH_API int forkpty(int *, char *, void *, const struct ih_winsize *);
IH_API int execv(const char *, const char *const *);
IH_API int ioctl(int, uint64_t, ...);
IH_API int dup(int);
IH_API int pipe(int [2]);
IH_API int close(int);
IH_API int waitpid(int, int *, int);
IH_API int kill(int, int);
IH_API int poll(struct ih_pollfd *, unsigned int, int);
IH_API int _setmode(int, int);
IH_API int fcntl(int, int, ...);
IH_API int *__errno(void);
IH_API int snprintf(char *, size_t, const char *, ...);
IH_API int atoi(const char *);
IH_API unsigned long long strtoull(const char *, char **, int);
IH_API int pthread_create(void **, const void *, void *(*)(void *), void *);
IH_API int pthread_join(void *, void **);
IH_API int pthread_sigmask(int, const ih_sigset_t *, ih_sigset_t *);
IH_API int pthread_kill(void *, int);
IH_API int sigemptyset(ih_sigset_t *);
IH_API int sigaddset(ih_sigset_t *, int);
IH_API int sigwait(const ih_sigset_t *, int *);
IH_API int sigaction(int, const struct ih_sigaction *, struct ih_sigaction *);
IH_API void *malloc(size_t);
IH_API void free(void *);
IH_API void _exit(int);
IH_API int64_t read(int, void *, size_t);
IH_API int64_t write(int, const void *, size_t);
#endif
