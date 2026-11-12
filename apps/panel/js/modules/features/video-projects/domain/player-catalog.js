export const VIDEO_PROJECT_PLAYERS_BY_COUNTRY = Object.freeze({
  Aurenia: Object.freeze({
    players: Object.freeze(['Nicolás Andrade', 'Mateo Salvatierra', 'Iván Cordero', 'Diego Peralta', 'Ángel Mera', 'Bruno Valdivia']),
    nicknames: Object.freeze(['La Aurenia']),
  }),
  Montelia: Object.freeze({
    players: Object.freeze(['Jaime Rueda', 'Luis Cárdenas', 'Juan Fernando Quiroga', 'Jonás Arriola']),
    nicknames: Object.freeze(['Los Montelios']),
  }),
  Valdoria: Object.freeze({
    players: Object.freeze(['Leonel Márquez', 'Julián Alvarado', 'Emiliano Ferreyra']),
    nicknames: Object.freeze(['La Valdoriana']),
  }),
  Rivamar: Object.freeze({
    players: Object.freeze(['Federico Valdés']),
    nicknames: Object.freeze(['La Rivamarense']),
  }),
  Bosquemar: Object.freeze({
    players: Object.freeze(['Julio Enríquez', 'Miguel Almada']),
    nicknames: Object.freeze(['La Bosquemarense']),
  }),
  Terramar: Object.freeze({
    players: Object.freeze(['Santiago Gil', 'Guillermo Olvera', 'Edson Ávila']),
    nicknames: Object.freeze(['El Terramar']),
  }),
});

export function listVideoProjectCountries() {
  return Object.keys(VIDEO_PROJECT_PLAYERS_BY_COUNTRY);
}

export function listVideoProjectPlayers(country) {
  const entry = VIDEO_PROJECT_PLAYERS_BY_COUNTRY[country];
  if (!entry) return [];
  return [...(entry.players || []), ...(entry.nicknames || [])];
}
