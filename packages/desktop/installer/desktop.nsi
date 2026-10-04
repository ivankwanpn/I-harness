; -*- coding: utf-8 -*-
; build-installer.mjs supplies a validated, exact file list. No recursive removal.
Unicode true
RequestExecutionLevel user
AllowRootDirInstall false
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 32

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!ifdef TEST_HOOKS
  !include "${TEST_HOOKS}"
!endif

!define APP_NAME "I-harness Desktop"
!define INSTALL_MARKER ".i-harness-desktop-install.ini"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\I-harness Desktop"
!ifdef TEST_ROOT
  !define PRODUCT_OWNER "I-harness.Desktop.Installer.Test.v1.${TEST_TOKEN}"
  InstallDir "${TEST_ROOT}\${APP_NAME}"
!else
  !define PRODUCT_OWNER "I-harness.Desktop.Installer.v1"
  InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
!endif

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${OUTPUT_FILE}"
BrandingText "I-harness"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "I-harness contributors"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "TradChinese"

Var FailureMessage
Var CleanupFailed
Var ExecutableLock
Var MarkerLock
Var RecoveryLock
Var OperationMutexName
Var SetupMutex
Var UninstallMutex
Var UpgradeNonce
Var UpgradeParent

!macro Fail MESSAGE CODE
  StrCpy $FailureMessage "${MESSAGE}"
!ifdef TEST_ROOT
  ReadINIStr $0 "${TEST_ROOT}\.ih-desktop-installer-test-owner.ini" "Test" "Token"
  ReadINIStr $1 "${TEST_ROOT}\.ih-desktop-installer-test-owner.ini" "Test" "Owner"
  ${If} $0 == "${TEST_TOKEN}"
  ${AndIf} $1 == "I-harness.Desktop.Installer.Test.v1"
    FileOpen $0 "${TEST_ROOT}\last-failure.txt" w
    FileWrite $0 "$FailureMessage"
    FileClose $0
  ${EndIf}
!endif
  IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "$FailureMessage"
  SetErrorLevel ${CODE}
  Quit
!macroend

; Called before any writes or removals. Canonicalize and refuse junctions in
; the destination's ancestry, roots, and locations without the product leaf.
!macro LocationFunction PREFIX
Function ${PREFIX}ValidateLocation
  ; NSIS GetFullPathName requires an existing path portion. The Win32 API also
  ; normalizes a fresh destination before it has been created.
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i.r1'
  ${If} $1 == 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    !insertmacro Fail "The installation path is invalid or too long." 2
  ${EndIf}
  StrCpy $INSTDIR $0
  ${GetFileName} "$INSTDIR" $0
  ${If} $0 != "${APP_NAME}"
    !insertmacro Fail "Choose an installation folder named ${APP_NAME}. Drive roots and shared parent folders cannot be used. Received: $INSTDIR (folder: $0)" 2
  ${EndIf}
  StrCpy $1 "$INSTDIR"
  location_ancestor:
    System::Call 'kernel32::GetFileAttributesW(w r1) i.r0'
    ${If} $0 != -1
      IntOp $0 $0 & 0x400
      ${If} $0 != 0
        !insertmacro Fail "The installation path contains a link or junction. Choose a plain directory." 2
      ${EndIf}
    ${EndIf}
    ${GetParent} "$1" $2
    StrCmp $2 "" location_checked
    StrCmp $1 $2 location_checked
    StrCpy $1 $2
    Goto location_ancestor
  location_checked:
!ifdef TEST_ROOT
  ReadINIStr $0 "${TEST_ROOT}\.ih-desktop-installer-test-owner.ini" "Test" "Owner"
  ${If} $0 != "I-harness.Desktop.Installer.Test.v1"
    !insertmacro Fail "The isolated test root ownership marker is missing." 2
  ${EndIf}
  ReadINIStr $0 "${TEST_ROOT}\.ih-desktop-installer-test-owner.ini" "Test" "Token"
  ${If} $0 != "${TEST_TOKEN}"
    !insertmacro Fail "The isolated test root ownership token does not match." 2
  ${EndIf}
  StrLen $0 "${TEST_ROOT}\"
  StrCpy $1 "$INSTDIR" $0
  ${If} $1 != "${TEST_ROOT}\"
    !insertmacro Fail "This test installer only operates inside its isolated test root." 2
  ${EndIf}
!endif
FunctionEnd
!macroend
!insertmacro LocationFunction ""
!insertmacro LocationFunction "un."

!macro CheckPayloadDirectory RELATIVE
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\${RELATIVE}") i.r0'
  ${If} $0 != -1
    IntOp $0 $0 & 0x400
    ${If} $0 != 0
      !insertmacro Fail "An installed payload directory is a link or junction. No files were removed." 2
    ${EndIf}
  ${EndIf}
!macroend

!macro RefuseExistingFile RELATIVE
  ${If} ${FileExists} "$INSTDIR\${RELATIVE}"
    !insertmacro Fail "An unrelated file conflicts with the new payload: ${RELATIVE}. Move that file before installing." 2
  ${EndIf}
!macroend

!macro RemoveOwnedFile RELATIVE
  ClearErrors
  Delete "$INSTDIR\${RELATIVE}"
  ${If} ${Errors}
    StrCpy $CleanupFailed 1
  ${EndIf}
!macroend

!macro CheckBootstrapWrite
  ${If} ${Errors}
    !insertmacro Fail "Installer recovery files could not be created. No application payload was copied. Choose a writable empty folder; bootstrap files may remain in this folder." 6
  ${EndIf}
!macroend

; Global names include the current user's SID and product/test namespace.
; Keep operation mutex handles alive until process exit. An upgrade parent
; retains SetupMutex while its authenticated child owns UninstallMutex.
!macro MutexNamesFunction PREFIX
Function ${PREFIX}CreateMutexNames
  System::Call 'kernel32::GetCurrentProcess() p.r0'
  System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i.r2'
  ${If} $2 == 0
    !insertmacro Fail "The current user identity could not be read. No application files were changed." 5
  ${EndIf}
  System::Call 'advapi32::GetTokenInformation(p r1, i 1, p 0, i 0, *i .r2)'
  System::Alloc $2
  Pop $3
  ${If} $3 == 0
    !insertmacro Fail "The installer operation lock could not be initialized." 5
  ${EndIf}
  System::Call 'advapi32::GetTokenInformation(p r1, i 1, p r3, i r2, *i .r2) i.r4'
  ${If} $4 == 0
    !insertmacro Fail "The current user identity could not be read." 5
  ${EndIf}
  System::Call '*$3(p .r4)'
  System::Call 'advapi32::ConvertSidToStringSidW(p r4, *p .r5) i.r6'
  ${If} $6 == 0
    !insertmacro Fail "The current user identity could not be converted." 5
  ${EndIf}
  System::Call 'kernel32::lstrcpynW(w .r7, p r5, i ${NSIS_MAX_STRLEN})'
  System::Call 'kernel32::LocalFree(p r5)'
  System::Free $3
  System::Call 'kernel32::CloseHandle(p r1)'
  StrCpy $0 $7 4
  ${If} $0 != "S-1-"
    !insertmacro Fail "The installer operation lock identity is invalid." 5
  ${EndIf}
  StrCpy $OperationMutexName "Global\I-harness.Desktop.${PRODUCT_OWNER}.$7"
FunctionEnd
!macroend
!insertmacro MutexNamesFunction ""
!insertmacro MutexNamesFunction "un."

!macro OpenOperationMutex HANDLE SUFFIX
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "$OperationMutexName.${SUFFIX}") p.r0'
  ${If} $0 == 0
    !insertmacro Fail "The installer operation lock could not be opened. No application files were changed." 5
  ${EndIf}
  StrCpy ${HANDLE} $0
!macroend

Function AcquireSetupOperation
  Call CreateMutexNames
  !insertmacro OpenOperationMutex $SetupMutex "setup"
  System::Call 'kernel32::WaitForSingleObject(p $SetupMutex, i 0) i.r0'
  ${If} $0 != 0
  ${AndIf} $0 != 128
    !insertmacro Fail "Another ${APP_NAME} installation or removal is in progress. Close it before trying again." 5
  ${EndIf}
  !insertmacro OpenOperationMutex $UninstallMutex "uninstall"
  System::Call 'kernel32::WaitForSingleObject(p $UninstallMutex, i 0) i.r0'
  ${If} $0 != 0
  ${AndIf} $0 != 128
    !insertmacro Fail "A ${APP_NAME} removal is in progress. Wait for it to finish before installing." 5
  ${EndIf}
  System::Call 'kernel32::ReleaseMutex(p $UninstallMutex)'
FunctionEnd

Function un.AcquireUninstallOperation
  Call un.CreateMutexNames
  !insertmacro OpenOperationMutex $SetupMutex "setup"
  System::Call 'kernel32::WaitForSingleObject(p $SetupMutex, i 0) i.r0'
  ${If} $0 != 0
  ${AndIf} $0 != 128
    ; Only the child inheriting the active parent's fresh nonce may proceed
    ; while SetupMutex is held. Other uninstallers have no inherited nonce.
    ReadEnvStr $1 "IH_DESKTOP_UPGRADE_NONCE"
    ReadEnvStr $2 "IH_DESKTOP_UPGRADE_PARENT"
    ReadINIStr $3 "$INSTDIR\${INSTALL_MARKER}" "Upgrade" "Nonce"
    ReadINIStr $4 "$INSTDIR\${INSTALL_MARKER}" "Upgrade" "Parent"
    ${If} $1 == ""
    ${OrIf} $2 == ""
    ${OrIf} $1 != $3
    ${OrIf} $2 != $4
      !insertmacro Fail "A ${APP_NAME} installation is in progress. Wait for it to finish before uninstalling." 5
    ${EndIf}
    System::Call 'kernel32::OpenProcess(i 0x100000, i 0, i r2) p.r5'
    ${If} $5 == 0
      !insertmacro Fail "The upgrade parent is no longer active. Retry the operation." 5
    ${EndIf}
    System::Call 'kernel32::WaitForSingleObject(p r5, i 0) i.r6'
    System::Call 'kernel32::CloseHandle(p r5)'
    ${If} $6 != 258
      !insertmacro Fail "The upgrade parent is no longer active. Retry the operation." 5
    ${EndIf}
  ${EndIf}
  !insertmacro OpenOperationMutex $UninstallMutex "uninstall"
  System::Call 'kernel32::WaitForSingleObject(p $UninstallMutex, i 0) i.r0'
  ${If} $0 != 0
  ${AndIf} $0 != 128
    !insertmacro Fail "Another ${APP_NAME} removal is in progress. Wait for it to finish before trying again." 5
  ${EndIf}
FunctionEnd

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    !insertmacro Fail "${APP_NAME} requires 64-bit Windows." 2
  ${EndIf}
!ifndef TEST_ROOT
  ; InstallDirRegKey ignores SetRegView, so read the same 64-bit registry view
  ; used for the uninstall entry explicitly. A raw /D= below overrides it.
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
!endif
  ; NSIS can discard an invalid /D= and fall back to InstallDir. Read the raw
  ; final /D= value so our own guard refuses the requested root explicitly.
  System::Call 'kernel32::GetCommandLineW() w.r0'
  StrCpy $1 0
  raw_destination_loop:
    StrCpy $2 $0 3 $1
    StrCmp $2 "" raw_destination_done
    StrCmp $2 "/D=" raw_destination_found
    IntOp $1 $1 + 1
    Goto raw_destination_loop
  raw_destination_found:
    IntOp $1 $1 + 3
    StrCpy $INSTDIR $0 "" $1
  raw_destination_done:
  Call ValidateLocation
  Call AcquireSetupOperation
!ifdef TEST_HOOKS
  !insertmacro TestSetupReady
!endif
FunctionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  Call un.ValidateLocation
  Call un.AcquireUninstallOperation
FunctionEnd

Section "${APP_NAME}" Install
  Call ValidateLocation
!ifndef TEST_ROOT
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 != ""
  ${AndIf} $0 != $INSTDIR
    !insertmacro Fail "${APP_NAME} is already installed in another folder. Uninstall that copy before changing its installation location." 2
  ${EndIf}
!endif
  ${DirState} "$INSTDIR" $0
  ${If} $0 = 1
    ReadINIStr $0 "$INSTDIR\${INSTALL_MARKER}" "Install" "Owner"
    ${If} $0 != "${PRODUCT_OWNER}"
      !insertmacro Fail "This nonempty folder is not owned by the ${APP_NAME} installer. Choose an empty installation folder." 2
    ${EndIf}
    ReadINIStr $0 "$INSTDIR\${INSTALL_MARKER}" "Install" "Path"
    ${If} $0 != $INSTDIR
      !insertmacro Fail "The installation ownership marker belongs to a different path." 2
    ${EndIf}
    ${IfNot} ${FileExists} "$INSTDIR\Uninstall.exe"
      !insertmacro Fail "The previous installation has no uninstaller. Restore its installer before upgrading." 2
    ${EndIf}
    InitPluginsDir
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\Uninstall.exe" "$PLUGINSDIR\previous-uninstall.exe"
    ${If} ${Errors}
      !insertmacro Fail "The previous uninstaller could not be staged. No new payload was installed." 2
    ${EndIf}
    System::Call 'ole32::CoCreateGuid(g .s)'
    Pop $UpgradeNonce
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    StrCpy $UpgradeParent $0
    ClearErrors
    WriteINIStr "$INSTDIR\${INSTALL_MARKER}" "Upgrade" "Nonce" "$UpgradeNonce"
    !insertmacro CheckBootstrapWrite
    ClearErrors
    WriteINIStr "$INSTDIR\${INSTALL_MARKER}" "Upgrade" "Parent" "$UpgradeParent"
    !insertmacro CheckBootstrapWrite
    System::Call 'kernel32::SetEnvironmentVariableW(w "IH_DESKTOP_UPGRADE_NONCE", w "$UpgradeNonce")'
    System::Call 'kernel32::SetEnvironmentVariableW(w "IH_DESKTOP_UPGRADE_PARENT", w "$UpgradeParent")'
    ClearErrors
    ExecWait '"$PLUGINSDIR\previous-uninstall.exe" /S _?=$INSTDIR' $0
    System::Call 'kernel32::SetEnvironmentVariableW(w "IH_DESKTOP_UPGRADE_NONCE", p 0)'
    System::Call 'kernel32::SetEnvironmentVariableW(w "IH_DESKTOP_UPGRADE_PARENT", p 0)'
    ${If} ${Errors}
    ${OrIf} $0 != 0
      !insertmacro Fail "The previous installation could not be removed. Close ${APP_NAME} and try again." 2
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\${INSTALL_MARKER}"
      !insertmacro Fail "The previous installation did not complete its cleanup." 2
    ${EndIf}
  ${EndIf}
  ; An upgrade can leave unrelated files. Refuse collisions and reparse points
  ; rather than overwriting them. The executable is extracted last.
  !include "${PAYLOAD_DIRECTORIES}"
  !include "${PAYLOAD_CONFLICTS}"
  SetOutPath "$INSTDIR"
!ifdef TEST_HOOKS
  !insertmacro TestBeforeBootstrap
!endif
  ClearErrors
  WriteINIStr "$INSTDIR\${INSTALL_MARKER}" "Install" "Owner" "${PRODUCT_OWNER}"
  !insertmacro CheckBootstrapWrite
  ClearErrors
  WriteINIStr "$INSTDIR\${INSTALL_MARKER}" "Install" "Path" "$INSTDIR"
  !insertmacro CheckBootstrapWrite
  ClearErrors
  WriteINIStr "$INSTDIR\${INSTALL_MARKER}" "Install" "Version" "${APP_VERSION}"
  !insertmacro CheckBootstrapWrite
  ClearErrors
  WriteINIStr "$INSTDIR\${INSTALL_MARKER}" "Install" "PayloadId" "${PAYLOAD_ID}"
  !insertmacro CheckBootstrapWrite
  ClearErrors
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  !insertmacro CheckBootstrapWrite
  ClearErrors
  !include "${PAYLOAD_INSTALL}"
  ${If} ${Errors}
    !insertmacro Fail "The application could not be fully copied. Use Uninstall.exe to remove the partial installation, then install again." 2
  ${EndIf}
  SetOutPath "$INSTDIR"
!ifdef TEST_ROOT
  CreateDirectory "${TEST_ROOT}\shortcuts\desktop"
  CreateDirectory "${TEST_ROOT}\shortcuts\start-menu"
  CreateShortCut "${TEST_ROOT}\shortcuts\desktop\${APP_NAME}.lnk" "$INSTDIR\${APP_NAME}.exe"
  CreateShortCut "${TEST_ROOT}\shortcuts\start-menu\${APP_NAME}.lnk" "$INSTDIR\${APP_NAME}.exe"
  CreateShortCut "${TEST_ROOT}\shortcuts\start-menu\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"
!else
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_NAME}.exe"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_NAME}.exe"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "I-harness contributors"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_NAME}.exe,0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "https://github.com/ivankwanpn/I-harness"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" ${ESTIMATED_SIZE}
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
!endif
  SetErrorLevel 0
SectionEnd

Section "Uninstall"
  Call un.ValidateLocation
  ReadINIStr $0 "$INSTDIR\${INSTALL_MARKER}" "Install" "Owner"
  ${If} $0 != "${PRODUCT_OWNER}"
    !insertmacro Fail "The installation ownership marker is missing or does not match. No files were removed." 2
  ${EndIf}
  ReadINIStr $0 "$INSTDIR\${INSTALL_MARKER}" "Install" "Path"
  ${If} $0 != $INSTDIR
    !insertmacro Fail "The installation ownership marker belongs to a different path. No files were removed." 2
  ${EndIf}
  ReadINIStr $0 "$INSTDIR\${INSTALL_MARKER}" "Install" "Version"
  ${If} $0 != "${APP_VERSION}"
    !insertmacro Fail "This uninstaller belongs to a different application version. No files were removed." 2
  ${EndIf}
  ReadINIStr $0 "$INSTDIR\${INSTALL_MARKER}" "Install" "PayloadId"
  ${If} $0 != "${PAYLOAD_ID}"
    !insertmacro Fail "This uninstaller belongs to a different installed payload. Use the current installation's Uninstall.exe. No files were removed." 2
  ${EndIf}
  !include "${PAYLOAD_DIRECTORIES}"
  ; Validate deletion access before deleting payload files. Keep ownership and
  ; the recovery executable intact when another process has either file open.
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\${INSTALL_MARKER}", i 0xC0010000, i 4, p 0, i 3, i 0x80, p 0) p.r0'
  ${If} $0 == -1
    !insertmacro Fail "The installation ownership marker is locked or cannot be removed. No application files were removed." 4
  ${EndIf}
  StrCpy $MarkerLock $0
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\Uninstall.exe", i 0xC0010000, i 4, p 0, i 3, i 0x80, p 0) p.r0'
  ${If} $0 == -1
    !insertmacro Fail "The recovery uninstaller is locked or cannot be removed. Close applications using this folder and retry; ownership was preserved." 4
  ${EndIf}
  StrCpy $RecoveryLock $0
  StrCpy $ExecutableLock 0
  ${If} ${FileExists} "$INSTDIR\${APP_NAME}.exe"
    ; Write access fails for an executing image. Keep the handle without read
    ; sharing while cleanup runs; FILE_SHARE_DELETE permits our exact deletion.
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\${APP_NAME}.exe", i 0xC0000000, i 4, p 0, i 3, i 0x80, p 0) p.r0'
    ${If} $0 == -1
      !insertmacro Fail "Close ${APP_NAME} before uninstalling or upgrading. The installer does not stop running applications." 3
    ${EndIf}
    StrCpy $ExecutableLock $0
  ${EndIf}
  StrCpy $CleanupFailed 0
  SetOutPath "$TEMP"
  !include "${PAYLOAD_REMOVE}"
  ${If} $ExecutableLock != 0
    System::Call 'kernel32::CloseHandle(p $ExecutableLock)'
  ${EndIf}
  ${If} $CleanupFailed != 0
    !insertmacro Fail "Some owned application files could not be removed. Close applications using this folder and run Uninstall.exe again." 4
  ${EndIf}
  ClearErrors
  Delete "$INSTDIR\Uninstall.exe"
  ${If} ${Errors}
    !insertmacro Fail "The recovery uninstaller could not be removed. Ownership was preserved; run Uninstall.exe again." 4
  ${EndIf}
  ClearErrors
  Delete "$INSTDIR\${INSTALL_MARKER}"
  ${If} ${Errors}
    System::Call 'kernel32::CloseHandle(p $RecoveryLock)'
    CopyFiles /SILENT "$EXEPATH" "$INSTDIR\Uninstall.exe"
    !insertmacro Fail "The installation ownership marker could not be removed. Recovery files were retained; retry after closing applications using this folder." 4
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p $RecoveryLock)'
  System::Call 'kernel32::CloseHandle(p $MarkerLock)'
!ifdef TEST_ROOT
  Delete "${TEST_ROOT}\shortcuts\desktop\${APP_NAME}.lnk"
  Delete "${TEST_ROOT}\shortcuts\start-menu\${APP_NAME}.lnk"
  Delete "${TEST_ROOT}\shortcuts\start-menu\Uninstall ${APP_NAME}.lnk"
  RMDir "${TEST_ROOT}\shortcuts\desktop"
  RMDir "${TEST_ROOT}\shortcuts\start-menu"
  RMDir "${TEST_ROOT}\shortcuts"
!else
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 == $INSTDIR
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ${EndIf}
!endif
  ; Empty-directory removal only: unrelated files and AppData are preserved.
  RMDir "$INSTDIR"
  SetErrorLevel 0
SectionEnd
