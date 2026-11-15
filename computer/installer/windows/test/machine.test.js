// machine.ps1's firewall checks and cleanup in RokidCoder.psm1 (6b), read from the
// module's source: they run only in PowerShell on Windows, which this check does not
// have. The Pester suite (Machine.Tests.ps1) runs the same cases through the module.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MODULE = fs.readFileSync(path.join(__dirname, "..", "lib", "RokidCoder.psm1"), "utf8");

function functionBody(name) {
  const start = MODULE.indexOf(`function ${name} {`);
  assert.ok(start >= 0, `RokidCoder.psm1 defines ${name}`);
  const next = MODULE.indexOf("\nfunction ", start + 1);
  return MODULE.slice(start, next < 0 ? undefined : next);
}

function between(text, start, end) {
  const at = text.indexOf(start);
  assert.ok(at >= 0, `found ${start}`);
  const to = text.indexOf(end, at + start.length);
  assert.ok(to >= 0, `found ${end} after ${start}`);
  return text.slice(at, to);
}

/** Each planned rule's cmdlet and the parameter names it is created with. */
function plannedRules() {
  return [...functionBody("Get-MachinePlan").matchAll(/Cmdlet = '(New-NetFirewall\w+)'; Parameters = @\{([^}]*)\}/g)].map((m) => ({
    cmdlet: m[1],
    keys: [...m[2].matchAll(/(?:^|;|\s)(\w+) = /g)].map((k) => k[1]),
  }));
}

test("firewall_validation_compares_every_planned_rule_parameter", () => {
  const rules = plannedRules();
  assert.equal(rules.filter((r) => r.cmdlet === "New-NetFirewallHyperVRule").length, 2);
  assert.equal(rules.filter((r) => r.cmdlet === "New-NetFirewallRule").length, 3);
  const expected = functionBody("Get-ExpectedRuleFilter");
  const effective = functionBody("Get-EffectiveRuleFilter");
  const expectedHyperV = expected.slice(0, expected.indexOf("} else {"));
  const expectedHost = expected.replace(expectedHyperV.slice(expectedHyperV.indexOf("if ($Item.Kind -eq 'hyperv')")), "");
  const effectiveHyperV = between(effective, "if ($Item.Kind -eq 'hyperv')", "$rule = Get-NetFirewallRule");
  const effectiveHost = effective.slice(effective.indexOf("$rule = Get-NetFirewallRule"));
  // Identification and grouping, not filters Windows enforces.
  const labels = new Set(["Name", "DisplayName", "Group"]);
  for (const rule of rules) {
    const hyperV = rule.cmdlet === "New-NetFirewallHyperVRule";
    for (const key of rule.keys.filter((k) => !labels.has(k))) {
      assert.match(hyperV ? expectedHyperV : expectedHost, new RegExp(`Get-ParameterValue \\$p '${key}'`), `${rule.cmdlet} -${key} is part of the expected filter`);
      assert.match(hyperV ? effectiveHyperV : effectiveHost, new RegExp(`'${key}'`), `${rule.cmdlet} -${key} is read back from what Windows enforces`);
    }
  }
});
