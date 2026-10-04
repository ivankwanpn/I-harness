; Included only in the compile-time, owned file-only TEST_ROOT namespace.
!macro TestBeforeUpgrade
  ReadINIStr $8 "${TEST_ROOT}\test-controls.ini" "Controls" "SimulateElevatedUpgrade"
  ${If} $8 == 1
    StrCpy $SetupElevated 1
  ${EndIf}
!macroend

!macro TestSetupReady
  ReadINIStr $8 "${TEST_ROOT}\test-controls.ini" "Controls" "HoldFirstSetup"
  ${If} $8 == 1
  ${AndIfNot} ${FileExists} "${TEST_ROOT}\setup-ready.txt"
    FileOpen $8 "${TEST_ROOT}\setup-ready.txt" w
    FileWrite $8 "ready"
    FileClose $8
    StrCpy $8 0
    test_hold_loop:
      ReadINIStr $9 "${TEST_ROOT}\test-controls.ini" "Controls" "HoldFirstSetup"
      StrCmp $9 1 0 test_hold_finished
      Sleep 50
      IntOp $8 $8 + 1
      IntCmp $8 400 test_hold_finished
      Goto test_hold_loop
    test_hold_finished:
  ${EndIf}
!macroend

!macro TestBeforeBootstrap
  ReadINIStr $8 "${TEST_ROOT}\test-controls.ini" "Controls" "FailMarkerBootstrap"
  ${If} $8 == 1
    CreateDirectory "$INSTDIR\${INSTALL_MARKER}"
  ${EndIf}
  ReadINIStr $8 "${TEST_ROOT}\test-controls.ini" "Controls" "FailUninstallerBootstrap"
  ${If} $8 == 1
    CreateDirectory "$INSTDIR\Uninstall.exe"
  ${EndIf}
!macroend
