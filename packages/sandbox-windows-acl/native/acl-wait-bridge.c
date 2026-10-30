#include <windows.h>

/* Called off the JS thread after a registered callback has returned. */
__declspec(dllexport) DWORD WINAPI ih_acl_unregister_wait_and_drain(HANDLE registration)
{
    if (UnregisterWaitEx(registration, INVALID_HANDLE_VALUE)) return ERROR_SUCCESS;
    return GetLastError();
}
