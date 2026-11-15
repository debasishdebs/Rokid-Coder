// installer.nsi's failure paths (6b T8), read from the script: makensis and a
// Windows desktop are needed to run them, which this check does not have. The
// gate's W-steps exercise them on Windows.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const NSI = fs.readFileSync(path.join(__dirname, "..", "installer.nsi"), "utf8");

function block(start, end) {
  const at = NSI.indexOf(start);
  assert.ok(at >= 0, `installer.nsi has ${start}`);
  return NSI.slice(at, NSI.indexOf(end, at) + end.length);
}

test("nsis_compensates_this_runs_machine_objects_on_partial_apply_failure_and_cancel", () => {
  const apply = block("Function OnApplyMachine", "FunctionEnd");
  const attempted = apply.indexOf("StrCpy $MachineAttempted 1");
  assert.ok(attempted >= 0 && attempted < apply.indexOf("-ApplyMachine"), "an Apply counts before its exit code is known");
  assert.doesNotMatch(NSI, /MachineApplied/, "nothing waits for a fully successful Apply any more");

  assert.match(NSI, /^!define MUI_CUSTOMFUNCTION_ABORT OnUserAbort$/m, "Cancel runs OnUserAbort");
  assert.ok(NSI.indexOf("!define MUI_CUSTOMFUNCTION_ABORT") < NSI.indexOf("!insertmacro MUI_PAGE_WELCOME"), "defined before the pages, as MUI2 needs");
  assert.match(block("Function OnUserAbort", "FunctionEnd"), /Call RevertMachineRun/);

  const revert = block("Function RevertMachineRun", "FunctionEnd");
  assert.match(revert, /\$\{If\} \$MachineAttempted == 1/);
  // From the payload .onInit unpacked: on Cancel, nothing is in $INSTDIR yet.
  assert.match(revert, /"\$PLUGINSDIR\\win\\user-setup\.ps1" -RevertMachine -RunId \$RunId/);
  assert.match(revert, /StrCpy \$MachineAttempted 0/, "reverted once, not again on the way out");
  assert.doesNotMatch(revert, /Pop \$[0-9]\b/, "the caller's $0 (the install's exit code) survives the call");

  const section = block('Section "Rokid Coder"', "SectionEnd");
  assert.match(section, /\$\{If\} \$0 != 0\s+[^]*?Call RevertMachineRun[^]*?Abort/);
});

test("nsis_uninstaller_keeps_itself_and_its_registration_until_removal_succeeds", () => {
  const uninstall = block('Section "Uninstall"', "SectionEnd");
  const failed = uninstall.indexOf("${If} $1 != 0");
  const success = uninstall.indexOf("${Else}", failed);
  assert.ok(failed >= 0 && success > failed);
  for (const removal of ['RMDir /r "$INSTDIR"', 'DeleteRegKey HKCU "${UNINST_KEY}"']) {
    const at = uninstall.indexOf(removal);
    assert.ok(at > success && at < uninstall.indexOf("${EndIf}", success), `${removal} only after uninstall.ps1 exits 0`);
    assert.equal(uninstall.indexOf(removal, at + 1), -1, `${removal} nowhere else`);
  }
});

test("nsis_failed_install_says_the_undo_may_be_incomplete", () => {
  const section = block('Section "Rokid Coder"', "SectionEnd");
  const failure = section.slice(section.indexOf("${If} $0 != 0"), section.indexOf("${EndIf}"));
  const box = /MessageBox MB_ICONSTOP "([^"]*)"/.exec(failure);
  assert.ok(box, "a failed install says so");
  // The em dash as NSIS's code-point form: the script is read without a BOM.
  assert.ok(box[1].startsWith("Setup stopped. Some changes may not have been undone ${U+2014} run the installer again to finish or undo."), box[1]);
  assert.doesNotMatch(box[1], /put back/, "Call RevertMachineRun may not have undone everything");
  assert.match(box[1], /exit \$0/);
  assert.match(box[1], /~\/\.rokid-coder\/logs\/setup\.log/);
});
