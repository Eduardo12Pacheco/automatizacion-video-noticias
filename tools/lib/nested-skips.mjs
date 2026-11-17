/**
 * Parse and classify nested test skips (individual tests that skip inside an
 * otherwise passing suite). The runner surfaces these separately and fails on
 * any reason that is not declared by the suite step.
 */

export function parseNestedSkips(step, stdout, stderr, tapText) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  const reasons = [];
  if (step.skipParser === 'node') {
    for (const line of (tapText || '').split('\n')) {
      const match = /# SKIP (.+)$/.exec(line.trim());
      if (match) reasons.push(match[1].trim());
    }
  } else if (step.skipParser === 'pytest') {
    for (const match of text.matchAll(/^SKIPPED \[\d+\] .*?:\d+: (.+)$/gm)) reasons.push(match[1].trim());
  } else if (step.skipParser === 'unittest') {
    for (const match of text.matchAll(/skipped '([^']+)'/g)) reasons.push(match[1].trim());
  }
  return reasons;
}

export function classifyNestedSkips(step, reasons) {
  const allowlist = step.nestedSkipAllowlist || [];
  const groups = new Map();
  const unexpected = [];
  for (const reason of reasons) {
    const allowed = allowlist.find((entry) => entry.match.test(reason));
    if (!allowed) {
      unexpected.push(reason);
      continue;
    }
    groups.set(allowed.code, (groups.get(allowed.code) || 0) + 1);
  }
  return { groups: [...groups.entries()], unexpected };
}
