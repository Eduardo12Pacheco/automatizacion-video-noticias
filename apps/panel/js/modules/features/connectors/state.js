export function createConnectorsState() {
  return {
    connectors: [],
    status: 'idle',
    error: '',
    cause: null,
    busyId: '',
    refreshInFlight: false,
    results: {},
  };
}
