export function createAdminUsersState() {
  return {
    users: [],
    roles: [],
    status: 'idle',
    error: '',
    cause: null,
    busyUserId: '',
    refreshInFlight: false,
  };
}
