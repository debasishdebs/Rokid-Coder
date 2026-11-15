; Rokid Coder for Windows: installs into WSL2, per user, unelevated [FR 13].
;
;   makensis /DVERSION=<v> /DBUNDLE_DIR=<dir> [/DOUTDIR=<dir>] installer.nsi
;
; BUNDLE_DIR holds T7a's rokid-coder-bundle-<v>-linux-x64.tar.gz and its .sha256,
; carried unmodified (windows-installer.yml checks the digest first). The only
; elevation is machine.ps1, through user-setup.ps1 -ApplyMachine: firewall and
; port proxy, nothing of the user's.

Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "StrFunc.nsh"
${StrStr}

!ifndef VERSION
  !error "Build with /DVERSION=<version> /DBUNDLE_DIR=<dir with the linux-x64 bundle archive>"
!endif
!ifndef BUNDLE_DIR
  !error "Build with /DBUNDLE_DIR=<dir with the linux-x64 bundle archive and its .sha256>"
!endif
!ifndef OUTDIR
  !define OUTDIR "."
!endif
!define SRCDIR "${__FILEDIR__}"
!define ARCHIVE "rokid-coder-bundle-${VERSION}-linux-x64.tar.gz"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\RokidCoder"
; NSIS is a 32-bit process: Sysnative is the real System32, where wsl.exe lives.
!define PS "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
!define PSRUN '"${PS}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File'

Name "Rokid Coder ${VERSION}"
OutFile "${OUTDIR}\rokid-coder-${VERSION}-windows-x64.exe"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\RokidCoder"
ManifestDPIAware true
SetCompressor /SOLID lzma
ShowInstDetails show

Var Mode
Var RunId
; 1 once this run asked machine.ps1 to Apply, whatever it returned: a partial Apply records what it made.
Var MachineAttempted
Var Distro
Var DistroArg
Var MirroredAvailable
Var PreflightOk
Var FinishText
Var MirroredRadio
Var NatRadio
Var ConsentCheck
Var DistroText
Var ChecksText
Var RetireCheck
Var NextButton

!define MUI_ABORTWARNING
; Cancel after "Apply firewall rules" takes this run's machine objects back out.
!define MUI_CUSTOMFUNCTION_ABORT OnUserAbort
!define MUI_FINISHPAGE_TEXT "$FinishText"
!insertmacro MUI_PAGE_WELCOME
Page custom ModePage ModePageLeave
Page custom ChecksPage ChecksPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!macro PAYLOAD DEST
  SetOutPath "${DEST}"
  File "${SRCDIR}\preflight.ps1"
  File "${SRCDIR}\user-setup.ps1"
  File "${SRCDIR}\machine.ps1"
  File "${SRCDIR}\start-agentd.ps1"
  File "${SRCDIR}\uninstall.ps1"
  File "${SRCDIR}\task.xml.template"
  File "${SRCDIR}\wsl-requirements.json"
  SetOutPath "${DEST}\lib"
  File "${SRCDIR}\lib\RokidCoder.psm1"
!macroend

Function .onInit
  InitPluginsDir
  !insertmacro PAYLOAD "$PLUGINSDIR\win"
  nsExec::ExecToStack '${PSRUN} "$PLUGINSDIR\win\user-setup.ps1" -CheckSession'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Run the installer from your own Windows account, not as another user"
    Abort
  ${EndIf}
  System::Call 'kernel32::GetTickCount() i .r0'
  StrCpy $RunId "run-$0"
  StrCpy $MachineAttempted 0
  StrCpy $Mode "nat"
  nsExec::ExecToStack '${PSRUN} "$PLUGINSDIR\win\preflight.ps1" -Recommend'
  Pop $0
  Pop $1
  ${StrStr} $2 $1 '"mirroredAvailable":true'
  ${If} $2 != ""
    StrCpy $MirroredAvailable 1
  ${Else}
    StrCpy $MirroredAvailable 0
  ${EndIf}
FunctionEnd

; This run's recorded firewall rules and port proxy, and nothing else (user-setup.ps1 asks for
; no elevation when the run recorded none). Run on a failed install and on Cancel.
Function RevertMachineRun
  ${If} $MachineAttempted == 1
    ; $R9, not $0: the install section still reports its own exit code from $0 after this.
    nsExec::ExecToLog '${PSRUN} "$PLUGINSDIR\win\user-setup.ps1" -RevertMachine -RunId $RunId'
    Pop $R9
    ${If} $R9 == 0
      StrCpy $MachineAttempted 0
    ${Else}
      MessageBox MB_ICONEXCLAMATION "The firewall rules this setup added could not be removed (exit $R9). Run the installer again and cancel it to retry, or remove the rules named RokidCoder-* yourself."
    ${EndIf}
  ${EndIf}
FunctionEnd

Function OnUserAbort
  Call RevertMachineRun
FunctionEnd

; ---- 1: the network mode, chosen first [6b-R1]

Function ModePage
  !insertmacro MUI_HEADER_TEXT "Network mode" "How your phone reaches Rokid Coder inside WSL"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateRadioButton} 0 0 100% 12u "Mirrored networking (recommended): WSL shares this computer's network"
  Pop $MirroredRadio
  ${NSD_CreateCheckBox} 12u 14u 100% 22u "I agree to set networkingMode=mirrored in %UserProfile%\.wslconfig. WSL restarts, which closes every running Linux distro."
  Pop $ConsentCheck
  ${NSD_CreateRadioButton} 0 42u 100% 22u "NAT with a port proxy (works with any WSL). Automatic discovery does not work: you scan the QR code, or use Tailscale."
  Pop $NatRadio
  ${NSD_CreateLabel} 0 72u 100% 10u "WSL distro (leave empty for your default Ubuntu):"
  Pop $0
  ${NSD_CreateText} 0 84u 50% 12u "$Distro"
  Pop $DistroText
  ${If} $MirroredAvailable == 1
    ${NSD_Check} $MirroredRadio
  ${Else}
    EnableWindow $MirroredRadio 0
    EnableWindow $ConsentCheck 0
    ${NSD_Check} $NatRadio
    ${NSD_CreateLabel} 0 104u 100% 20u "Mirrored networking needs WSL 2.0.9 or later. Run wsl --update in a terminal, then start this installer again to use it."
    Pop $0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function ModePageLeave
  ${NSD_GetText} $DistroText $Distro
  ${If} $Distro == ""
    StrCpy $DistroArg ""
  ${Else}
    StrCpy $DistroArg '-Distro "$Distro"'
  ${EndIf}
  ${NSD_GetState} $MirroredRadio $0
  ${NSD_GetState} $ConsentCheck $1
  ${If} $0 == ${BST_CHECKED}
    ${If} $1 != ${BST_CHECKED}
      MessageBox MB_ICONINFORMATION "Mirrored networking changes .wslconfig: agree to it, or choose NAT."
      Abort
    ${EndIf}
    StrCpy $Mode "mirrored"
  ${Else}
    StrCpy $Mode "nat"
  ${EndIf}
FunctionEnd

; ---- 2: preflight for that mode, each item with its fix and a Re-check (U37)

Function ChecksPage
  !insertmacro MUI_HEADER_TEXT "Checks" "What Rokid Coder needs for $Mode networking"
  nsDialogs::Create 1018
  Pop $0
  nsDialogs::CreateControl EDIT "${__NSD_Text_STYLE}|${ES_MULTILINE}|${ES_READONLY}|${WS_VSCROLL}|${ES_AUTOVSCROLL}" "${__NSD_Text_EXSTYLE}" 0 0 100% 96u ""
  Pop $ChecksText
  ${NSD_CreateCheckBox} 0 100u 100% 12u "Replace the old Rokid-Coder agent (NexusAgentd) if it holds agentd's ports"
  Pop $RetireCheck
  ${NSD_CreateButton} 0 116u 56u 14u "Re-check"
  Pop $0
  ${NSD_OnClick} $0 OnRecheck
  ${NSD_CreateButton} 60u 116u 120u 14u "Apply firewall rules (admin)"
  Pop $0
  ${NSD_OnClick} $0 OnApplyMachine
  ${NSD_CreateButton} 184u 116u 116u 14u "Apply WSL network setting"
  Pop $0
  ${NSD_OnClick} $0 OnApplyWslConfig
  GetDlgItem $NextButton $HWNDPARENT 1
  Call RunPreflight
  nsDialogs::Show
FunctionEnd

Function RunPreflight
  StrCpy $1 ""
  ${NSD_GetState} $RetireCheck $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $1 "-RetireLegacy"
  ${EndIf}
  ${NSD_SetText} $ChecksText "Checking..."
  Delete "$PLUGINSDIR\preflight.txt"
  nsExec::ExecToStack '${PSRUN} "$PLUGINSDIR\win\preflight.ps1" -Mode $Mode -OutFile "$PLUGINSDIR\preflight.txt" $DistroArg $1'
  Pop $0
  Pop $2
  ${NSD_SetText} $ChecksText ""
  ; Line by line: the whole report can be longer than one NSIS string.
  ClearErrors
  FileOpen $3 "$PLUGINSDIR\preflight.txt" r
  ${IfNot} ${Errors}
    ${Do}
      ClearErrors
      FileReadUTF16LE $3 $4
      ${IfThen} ${Errors} ${|} ${ExitDo} ${|}
      SendMessage $ChecksText ${WM_GETTEXTLENGTH} 0 0 $5
      SendMessage $ChecksText ${EM_SETSEL} $5 $5
      SendMessage $ChecksText ${EM_REPLACESEL} 0 "STR:$4"
    ${Loop}
    FileClose $3
  ${Else}
    ${NSD_SetText} $ChecksText "The checks could not run (exit $0).$\r$\n$2"
  ${EndIf}
  ${If} $0 == 0
    StrCpy $PreflightOk 1
    EnableWindow $NextButton 1
  ${Else}
    StrCpy $PreflightOk 0
    EnableWindow $NextButton 0
  ${EndIf}
FunctionEnd

Function OnRecheck
  Pop $0
  Call RunPreflight
FunctionEnd

Function OnApplyMachine
  Pop $0
  ; Before the call: an Apply that fails part-way has still recorded (and undone) what it made.
  StrCpy $MachineAttempted 1
  nsExec::ExecToStack '${PSRUN} "$PLUGINSDIR\win\user-setup.ps1" -ApplyMachine -Mode $Mode -RunId $RunId'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "The firewall rules were not applied (exit $0), and what this attempt changed was put back. An administrator has to approve the prompt.$\r$\n$1"
  ${EndIf}
  Call RunPreflight
FunctionEnd

Function OnApplyWslConfig
  Pop $0
  MessageBox MB_OKCANCEL|MB_ICONQUESTION "This changes %UserProfile%\.wslconfig (a backup is kept) and restarts WSL, which closes every running Linux distro. Continue?" IDOK apply
  Return
  apply:
  nsExec::ExecToStack '${PSRUN} "$PLUGINSDIR\win\user-setup.ps1" -ApplyWslConfig -Mode $Mode $DistroArg'
  Pop $0
  Pop $1
  ${If} $0 == 3
    MessageBox MB_ICONINFORMATION "WSL did not switch to mirrored networking, so Rokid Coder uses NAT with a port proxy instead."
    StrCpy $Mode "nat"
  ${ElseIf} $0 != 0
    MessageBox MB_ICONEXCLAMATION "The WSL network setting could not be changed (exit $0).$\r$\n$1"
  ${EndIf}
  Call RunPreflight
FunctionEnd

Function ChecksPageLeave
  ${If} $PreflightOk != 1
    Abort
  ${EndIf}
FunctionEnd

; ---- 3: the per-user install, then rokid-setup in its own console window

Section "Rokid Coder"
  !insertmacro PAYLOAD "$INSTDIR"
  SetOutPath "$PLUGINSDIR\bundle"
  File "${BUNDLE_DIR}\${ARCHIVE}"
  File "${BUNDLE_DIR}\${ARCHIVE}.sha256"
  DetailPrint "Setting up Rokid Coder inside WSL. A console window opens for the CLI step and the pairing."
  nsExec::ExecToLog '${PSRUN} "$INSTDIR\user-setup.ps1" -Install -Mode $Mode $DistroArg -Version ${VERSION} -Archive "$PLUGINSDIR\bundle\${ARCHIVE}" -Sha256File "$PLUGINSDIR\bundle\${ARCHIVE}.sha256"'
  Pop $0
  ${If} $0 != 0
    ; Only what THIS run's machine.ps1 -Apply created or replaced goes back.
    Call RevertMachineRun
    MessageBox MB_ICONSTOP "Setup stopped. Some changes may not have been undone ${U+2014} run the installer again to finish or undo.$\r$\n$\r$\n(exit $0) The setup log is in WSL: ~/.rokid-coder/logs/setup.log"
    Abort
  ${EndIf}
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Rokid Coder"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Rokid-Coder"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${If} $Mode == "nat"
    StrCpy $FinishText "Rokid Coder ${VERSION} is installed in WSL.$\r$\n$\r$\nAutomatic discovery doesn't work in this network mode: scan the QR code on your phone, or use Tailscale. If this computer's IP address changes, the phone asks to pair again until your next sign-in; Tailscale keeps one address."
  ${Else}
    StrCpy $FinishText "Rokid Coder ${VERSION} is installed in WSL. agentd starts at every sign-in."
  ${EndIf}
SectionEnd

; ---- uninstall (Apps & Features)

Section "Uninstall"
  StrCpy $0 ""
  MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONQUESTION "Also delete your pairings and settings? (No keeps them for a later install.)" IDNO keep
  StrCpy $0 "-Purge"
  keep:
  ; A visible console: uninstall.ps1 may ask "Keep mirrored networking? [Y/n]".
  ExecWait '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\uninstall.ps1" $0' $1
  ; Only a complete removal takes the uninstaller, the launchers and the Apps & Features entry with it:
  ; after a failed step everything stays, so uninstalling again retries.
  ${If} $1 != 0
    MessageBox MB_ICONEXCLAMATION "Rokid Coder could not be removed completely (exit $1); see the console output. Nothing else was removed: uninstall it again to retry."
    SetErrorLevel 1
  ${Else}
    RMDir /r "$INSTDIR"
    DeleteRegKey HKCU "${UNINST_KEY}"
  ${EndIf}
SectionEnd
