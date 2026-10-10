/* The native owner replaces only this reserved slot and the one MSYS import
 * descriptor's Name RVA before admission. Ordinary MSYS CRT startup then uses
 * the admitted installed DLL directly, without a DLL search or dynamic ABI. */
#pragma section(".ihmsys", read)
__declspec(allocate(".ihmsys")) const unsigned char ih_msys_import_path[32768] = "IH_MSYS_ABSOLUTE_IMPORT_V1";
