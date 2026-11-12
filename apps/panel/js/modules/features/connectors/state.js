export function createConnectorsState() {
  return {
    connectors: [],
    status: 'idle',
    error: '',
    busyId: '',
    refreshInFlight: false,
    results: {},
  };
}
