/**
 * Shared structural contract harness for every port adapter.
 *
 * Behavioural suites still cover what each method does; this harness stops the
 * class of defect where an adapter is wired into the composition root but one
 * declared port method is missing (the old `not_implemented` stubs hid it).
 */
export function missingPortMethods(portClass, adapter) {
  const methods = portClass?.methods || [];
  return methods.filter((method) => typeof adapter?.[method] !== 'function');
}

export function verifyPortContracts(pairs = []) {
  return pairs.flatMap(({ portClass, adapter, label }) => {
    const missing = missingPortMethods(portClass, adapter);
    return missing.length ? [{ label, port: portClass.name, missing }] : [];
  });
}
