export function formatDemoDateTime(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.toString();
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace(/\./g, '');
}

export function formatDemoDateTimeWithZone(value = '') {
  const formatted = formatDemoDateTime(value);
  if (!formatted) return '';
  const zone = new Intl.DateTimeFormat('es-ES', { timeZoneName: 'short' })
    .formatToParts(new Date(value))
    .find((part) => part.type === 'timeZoneName')?.value;
  return zone ? `${formatted} ${zone}` : formatted;
}
