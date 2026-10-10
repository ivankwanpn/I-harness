#ifndef IH_MSYS_API_H
#define IH_MSYS_API_H
#include <stddef.h>
#include <stdint.h>

/* The public C ABI of the selected x86-64 MSYS runtime. These declarations
 * intentionally avoid mixing the Windows CRT's descriptors with MSYS ones.
 * Layouts/constants are checked against the pinned runtime-devel headers. */
struct ih_winsize { uint16_t rows, cols, xpixel, ypixel; };
struct ih_pollfd { int fd; short events, revents; };
#define IH_API __declspec(dllimport)
IH_API int forkpty(int *, char *, void *, const struct ih_winsize *);
IH_API int execv(const char *, const char *const *);
IH_API int ioctl(int, uint64_t, ...);
IH_API int dup(int);
IH_API int close(int);
IH_API int waitpid(int, int *, int);
IH_API int poll(struct ih_pollfd *, unsigned int, int);
IH_API int _setmode(int, int);
IH_API int fcntl(int, int, ...);
IH_API int *__errno(void);
IH_API int snprintf(char *, size_t, const char *, ...);
IH_API int atoi(const char *);
IH_API unsigned long long strtoull(const char *, char **, int);
IH_API int pthread_create(void **, const void *, void *(*)(void *), void *);
IH_API int pthread_join(void *, void **);
IH_API void *malloc(size_t);
IH_API void free(void *);
IH_API void _exit(int);
IH_API int64_t read(int, void *, size_t);
IH_API int64_t write(int, const void *, size_t);
#endif
