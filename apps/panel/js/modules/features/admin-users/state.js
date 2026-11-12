export function createAdminUsersState() {
  return {
    users: [],
    roles: [],
    status: 'idle',
    error: '',
    busyUserId: '',
    refreshInFlight: false,
  };
}
