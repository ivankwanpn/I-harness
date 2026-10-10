# MSYS PTY adapter source and notices

The IH adapter uses the MSYS library startup/import components from the pinned
MSYS2 runtime-devel package. The selected installed runtime DLL is observed and
pinned at execution admission; this component does not distribute that DLL.

- Build package: msys2-runtime-devel 3.6.10-6, x86_64.
- Package URL: https://repo.msys2.org/msys/x86_64/msys2-runtime-devel-3.6.10-6-x86_64.pkg.tar.zst
- Package SHA-256: d50d94d36f45da93fc8ed53c91cd1c1eae38a370da1b3e00d31d0f8760e91ca9.
- Source package: https://repo.msys2.org/msys/sources/msys2-runtime-3.6.10-6.src.tar.zst
- Source package SHA-256: 1d06b1482199ca8adaea770c4b596ec3adb2749345ef81a5d111cb792f0f1643.
- Upstream tag cygwin-3.6.10: b11613e477c006b2ce0332463ed07f1118260e79.
- IH source: packages/sandbox-windows-psec/native/msys.

CYGWIN_LICENSE, COPYING.LIB and COPYING are copied unchanged from the source
tag's winsup directory. CYGWIN_LICENSE identifies library code as LGPLv3+,
other listed components as GPLv3+, and contains the explicit linking exception
for libcygwin.a, crt0.o and gcrt0.o with independent modules. Individual source
notices also apply. The aggregate MSYS2 package metadata labels the complete
package GPL-3.0-or-later.

The MSYS2 binutils 2.47-1 linker is a build-only tool. Its package SHA-256 is
b7ddaca6e8b63774cdb1f5ac2720963cd76f8f62ca7e2667b1b0f008ed7ecba2; source is
https://repo.msys2.org/msys/sources/binutils-2.47-1.src.tar.zst. The linker and its
SDK are not included in the Desktop runtime. Actual adapter/helper/source hashes
and build inputs are recorded in the shipped native manifest.
