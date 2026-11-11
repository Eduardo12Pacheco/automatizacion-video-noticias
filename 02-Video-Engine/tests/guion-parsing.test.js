const test = require("node:test");
const assert = require("node:assert/strict");
const { parseGuionSegments } = require("../scripts/lib/guion-parsing");

test("parseGuionSegments preserva indices y falla bloque vacio entre delimitadores", () => {
  assert.throws(
    () => parseGuionSegments("intro || cierre"),
    /bloque 2.*vacio/i,
  );
});

test("parseGuionSegments falla delimitadores iniciales y finales con indice claro", () => {
  assert.throws(() => parseGuionSegments("|intro"), /bloque 1.*vacio/i);
  assert.throws(() => parseGuionSegments("intro|"), /bloque 2.*vacio/i);
});

test("parseGuionSegments reporta bloques solo whitespace por indice original", () => {
  assert.throws(
    () => parseGuionSegments("intro|   \n\t |cierre"),
    /bloque 2.*vacio/i,
  );
});

test("parseGuionSegments devuelve segmentos no vacios con indice original", () => {
  const result = parseGuionSegments(" intro | cierre ");

  assert.deepEqual(result, [
    { blockIndex: 1, phrase: "intro" },
    { blockIndex: 2, phrase: "cierre" },
  ]);
});

test("parseGuionSegments marca solo el bloque saliente separado por salto de parrafo", () => {
  const result = parseGuionSegments("intro|cuerpo\r\n\r\n|cierre");

  assert.deepEqual(result, [
    { blockIndex: 1, phrase: "intro" },
    { blockIndex: 2, phrase: "cuerpo", paragraphBoundaryAfter: true },
    { blockIndex: 3, phrase: "cierre" },
  ]);
});

test("parseGuionSegments marca salto de parrafo cuando el pipe esta solo en su linea", () => {
  const result = parseGuionSegments("intro|cuerpo \n|\n cierre");

  assert.deepEqual(result, [
    { blockIndex: 1, phrase: "intro" },
    { blockIndex: 2, phrase: "cuerpo", paragraphBoundaryAfter: true },
    { blockIndex: 3, phrase: "cierre" },
  ]);
});
