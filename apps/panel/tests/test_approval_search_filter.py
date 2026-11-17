import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML_PATH = ROOT / "index.html"


def _run_node(script: str):
    return subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def test_approval_search_is_accent_insensitive_case_insensitive_and_multi_term():
    script = r"""
import { approvalItemMatchesSearch } from './js/modules/app-shell/search-filter.js';

const item = {
  seleccion: 'Montelia',
  jugador: 'Luis Cárdenas',
  tema_principal: 'Club Lago Sereno conquista la Copa Demo con asistencia del monteliano',
};

const matchingQueries = [
  'luis cardenas',
  'LUIS CARDENAS',
  'lago sereno cardenas',
  'montelia copa demo',
];

for (const query of matchingQueries) {
  if (!approvalItemMatchesSearch(item, query)) {
    throw new Error(`expected query to match: ${query}`);
  }
}

if (approvalItemMatchesSearch(item, 'marquez')) {
  throw new Error('unexpected match for unrelated player');
}
"""

    result = _run_node(script)

    assert result.returncode == 0, result.stderr


def test_approval_search_matches_channel_and_source_fields():
    script = r"""
import { approvalItemMatchesSearch } from './js/modules/app-shell/search-filter.js';

const item = {
  seleccion: 'Aurenia',
  jugador: 'Mateo Salvatierra',
  tema_principal: 'Defensa recibe elogios tras la fecha europea',
  channel_label: 'Mundo Demo',
  source_name: 'Canal Demo Deportes',
};

if (!approvalItemMatchesSearch(item, 'mundo demo')) {
  throw new Error('expected search to match channel label even when title does not include it');
}

if (!approvalItemMatchesSearch(item, 'canal demo')) {
  throw new Error('expected search to match source name even when title does not include it');
}

if (approvalItemMatchesSearch(item, 'mundo valdoria')) {
  throw new Error('expected multi-term search to require all terms across searchable fields');
}
"""

    result = _run_node(script)

    assert result.returncode == 0, result.stderr


def test_approval_search_matches_nested_source_channel_fields():
    script = r"""
import { approvalItemMatchesSearch } from './js/modules/app-shell/search-filter.js';

const item = {
  seleccion: 'Rivamar',
  jugador: 'Federico Valdés',
  tema_principal: 'El volante mantiene su nivel en Europa',
  sources: [
    { titular: 'Nota táctica', fuente_origen: 'Mundo Demo', channel_name: 'La Pizarra TV' },
  ],
};

if (!approvalItemMatchesSearch(item, 'mundo demo')) {
  throw new Error('expected search to match nested source origin');
}

if (!approvalItemMatchesSearch(item, 'pizarra tv')) {
  throw new Error('expected search to match nested source channel name');
}

if (approvalItemMatchesSearch(item, 'mundo montelia')) {
  throw new Error('expected nested source search to still require all terms');
}
"""

    result = _run_node(script)

    assert result.returncode == 0, result.stderr
