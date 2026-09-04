; ============================================================================
; ih.nsi -- I-harness self-contained Windows installer (NSIS 3.x, MUI2)
;
; Build contract (see installer/README.md, specs/2026-09-05-m45-packaging-design.md)
; ----------------------------------------------------------------------------
; This script is the "clean contract" variant of the staging idea: the build
; script (scripts/build-installer.mjs) COPIES the app payload and the bundled
; Node runtime into installer/staging/{dist,node} (+ the two .cmd launchers)
; and this script registers them with NSIS File commands.  installer/staging/
; is a gitignored build artifact -- nothing generated is committed.
;
;   staging/**        -> $INSTDIR via: File /r "${STAGING_DIR}\*"
;                        (staging/dist/* -> $INSTDIR\dist (ih.mjs + node_modules),
;                         staging/node/* -> $INSTDIR\node (node.exe + *.dll + LICENSE),
;                         staging/*.cmd  -> $INSTDIR (i-harness.cmd, ih.cmd))
;
; DIST layout contract (owned by G1 / scripts/build-dist.mjs):
;   dist/ih.mjs          - bundled ESM CLI entry (esbuild, target node22)
;   dist/node_modules/   - externalized native packages (@vscode/ripgrep etc.)
;
; Compile-time overrides (makensis command line):
;   /DAPP_VERSION=0.1.0   - version baked into the exe name and registry
;   /DIH_NSIS_TEST        - TEST BUILD: RequestExecutionLevel user, no PATH /
;                           registry / start-menu writes, only a silent
;                           install/uninstall of the file payload.
;                           (scripts/build-installer.mjs compiles both builds.)
;
; Path handling: HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\
; Environment\Path (REG_EXPAND_SZ) + WM_SETTINGCHANGE broadcast.  Segment
; comparison for the append-guard is exact (case-sensitive): the entry is
; only ever written by this installer itself, so our own appended bytes match
; bit-for-bit on reinstall/uninstall cycles.
; ============================================================================

!ifndef APP_NAME
  !define APP_NAME "I-harness"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.1.0"
!endif

; staging directory (relative to this script's dir -- see !cd below)
!ifndef STAGING_DIR
  !define STAGING_DIR "staging"
!endif

!define REG_KEY_APP    "Software\I-harness"
!define REG_KEY_UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\I-harness"
!define KEY_ENV        "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
!define APP_DIR_NAME   "I-harness"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "x64.nsh"

; ----------------------------------------------------------------------------
; Global metadata / output / execution level
; ----------------------------------------------------------------------------
Name "${APP_NAME} ${APP_VERSION}"

!ifdef IH_NSIS_TEST
  ; test build: user-level execution so a verify run needs no elevation
  OutFile "..\build\I-harness-Setup-${APP_VERSION}-test.exe"
  RequestExecutionLevel user
!else
  OutFile "..\build\I-harness-Setup-${APP_VERSION}.exe"
  RequestExecutionLevel admin
!endif

InstallDir "$PROGRAMFILES64\${APP_DIR_NAME}"
!ifndef IH_NSIS_TEST
  ; normal build only: remember the last install location (read-only for tests)
  InstallDirRegKey HKLM "${REG_KEY_APP}" "InstallDir"
!endif

; make all relative paths below resolve against THIS script's directory no
; matter what working directory makensis is invoked from
!cd "${__FILEDIR__}"

; zlib solid: node.exe (~75 MB) dominates the payload; solid zlib keeps the
; exe small-ish and compiles in seconds.  lzma would shave a few MB but takes
; minutes per build -- not worth it for a build-time tool.
SetCompressor /SOLID zlib

; ----------------------------------------------------------------------------
; MUI pages
; ----------------------------------------------------------------------------
!define MUI_ABORTWARNING
!ifndef IH_NSIS_TEST
  !insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!endif
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ----------------------------------------------------------------------------
; PATH helpers (machine level).  These run inside the "System" blocks only:
; the test build compiles every call site of these macros out.
; ----------------------------------------------------------------------------

; Append $INSTDIR to the machine PATH if it isn't already a segment.
; Uses $R0-$R4.  Case-sensitive segment compare -- only we ever write this
; entry, so exact matching is correct (and prevents double-appends).
!macro AppendToMachinePath
  ReadRegStr $R0 HKLM "${KEY_ENV}" "Path"
  ${If} $R0 == ""
    ; no Path value at all -- seed it with our entry
    WriteRegExpandStr HKLM "${KEY_ENV}" "Path" "$INSTDIR"
    Goto ap_done
  ${EndIf}
  StrCpy $R1 ""           ; current segment (being built)
  StrCpy $R2 "$R0"        ; remainder of the original
ap_walk:
  StrCpy $R3 "$R2" 1      ; next char
  StrCmp $R3 "" ap_flush  ; end of string -- flush final segment
  StrCmp $R3 ";" ap_flush
  StrCpy $R1 "$R1$R3"
  StrCpy $R2 "$R2" "" 1   ; drop the consumed char
  Goto ap_walk
ap_flush:
  StrCmp $R1 "" ap_next
  StrCmp $R1 "$INSTDIR" ap_found
ap_next:
  StrCpy $R1 ""
  ${If} $R2 != ""
    StrCpy $R2 "$R2" "" 1 ; drop the ';'
    Goto ap_walk
  ${Else}
    Goto ap_need_append
  ${EndIf}
ap_found:
  Goto ap_done
ap_need_append:
  WriteRegExpandStr HKLM "${KEY_ENV}" "Path" "$R0;$INSTDIR"
ap_done:
!macroend

; Remove the $INSTDIR segment from the machine PATH and write the value back
; only if something actually changed.  Uses $R0-$R4, $R6.
!macro RemoveFromMachinePath
  ReadRegStr $R0 HKLM "${KEY_ENV}" "Path"
  StrCmp $R0 "" rm_done
  StrCpy $R1 ""           ; current segment
  StrCpy $R2 "$R0"        ; remainder
  StrCpy $R6 ""           ; rebuilt result
rm_walk:
  StrCpy $R3 "$R2" 1
  StrCmp $R3 "" rm_flush
  StrCmp $R3 ";" rm_flush
  StrCpy $R1 "$R1$R3"
  StrCpy $R2 "$R2" "" 1
  Goto rm_walk
rm_flush:
  StrCmp $R1 "$INSTDIR" rm_keep_skip
  ${If} $R1 != ""
    ${If} $R6 == ""
      StrCpy $R6 "$R1"
    ${Else}
      StrCpy $R6 "$R6;$R1"
    ${EndIf}
  ${EndIf}
rm_keep_skip:
  StrCpy $R1 ""
  StrCmp $R2 "" rm_end
  StrCpy $R2 "$R2" "" 1
  Goto rm_walk
rm_end:
  StrCmp $R6 "$R0" rm_done       ; nothing removed
  StrCmp $R6 "" rm_no_entries
  WriteRegExpandStr HKLM "${KEY_ENV}" "Path" "$R6"
  Goto rm_done
rm_no_entries:
  ; every segment removed -- leave an empty value rather than deleting the
  ; whole Path (some tools choke on a missing Path)
  WriteRegStr HKLM "${KEY_ENV}" "Path" ""
rm_done:
!macroend

; Broadcast WM_SETTINGCHANGE so new processes see the updated PATH.
; Optional by design (exiting + re-launching also picks up the new PATH).
!macro RefreshEnvironment
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

; ----------------------------------------------------------------------------
; Install section
; ----------------------------------------------------------------------------
Section "${APP_NAME}"
  SetOverwrite on
  SetOutPath "$INSTDIR"

  ; app payload + Node runtime + launchers.  staging/ is
  ; { dist/, node/, i-harness.cmd, ih.cmd }; the single wildcard flattens the
  ; staging prefix while preserving the inner tree, yielding the install
  ; layout:
  ;   $INSTDIR\dist\ih.mjs         (+ dist/node_modules, ...)
  ;   $INSTDIR\node\node.exe
  ;   $INSTDIR\i-harness.cmd / ih.cmd
  File /r "${STAGING_DIR}\*"

  ; 4) uninstaller (always written -- the test build's verify uses it too)
  WriteUninstaller "$INSTDIR\uninstall.exe"

!ifdef IH_NSIS_TEST
  DetailPrint "[I-harness] TEST BUILD: PATH / registry / start-menu writes skipped"
!else
  ; 5) system scratch: registry, PATH, start-menu (normal builds only)
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  SetShellVarContext all

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\i-harness.cmd"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\ih.lnk" "$INSTDIR\ih.cmd"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"

  WriteRegStr HKLM "${REG_KEY_APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${REG_KEY_APP}" "Version" "${APP_VERSION}"

  WriteRegStr HKLM "${REG_KEY_UNINST}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "${REG_KEY_UNINST}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "${REG_KEY_UNINST}" "Publisher" "${APP_NAME}"
  WriteRegStr HKLM "${REG_KEY_UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${REG_KEY_UNINST}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKLM "${REG_KEY_UNINST}" "NoModify" 1
  WriteRegDWORD HKLM "${REG_KEY_UNINST}" "NoRepair" 1

  !insertmacro AppendToMachinePath
  !insertmacro RefreshEnvironment
!endif
SectionEnd

; ----------------------------------------------------------------------------
; Uninstall section
; ----------------------------------------------------------------------------
Section "Uninstall"
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}

!ifdef IH_NSIS_TEST
  DetailPrint "[I-harness] TEST BUILD: PATH / registry / start-menu cleanup skipped"
!else
  ; machine cleanup: registry keys + start menu + PATH entry
  SetShellVarContext all
  DeleteRegKey HKLM "${REG_KEY_UNINST}"
  DeleteRegKey HKLM "${REG_KEY_APP}"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\ih.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  !insertmacro RemoveFromMachinePath
  !insertmacro RefreshEnvironment
!endif

  ; file payload: the uninstaller runs from a temp copy of itself, so it may
  ; delete its own exe in $INSTDIR.  Refuse to RMDir anything suspiciously
  ; shallow (a drive root) -- belt and braces around RMDir /r.
  StrLen $R0 "$INSTDIR"
  ${If} $R0 <= 3
    DetailPrint "[I-harness] refusing to remove suspicious \$INSTDIR='$INSTDIR'"
  ${Else}
    Delete "$INSTDIR\uninstall.exe"
    RMDir /r "$INSTDIR"
  ${EndIf}
SectionEnd
