const test = require("node:test");
const assert = require("node:assert/strict");
const { alignPhrasesToTranscript } = require("@newsroom/contracts/approval-contract-pipeline/phrase-alignment");

test("alignPhrasesToTranscript usa timestamps reales de palabras", () => {
  const phrases = [
    { id: 1, phrase: "hola mundo", image: "a.jpg" },
    { id: 2, phrase: "adios planeta", image: "b.jpg" },
  ];

  const transcript = {
    totalDurationSeconds: 2.5,
    words: [
      { word: "hola", start: 0.1, end: 0.4 },
      { word: "mundo", start: 0.45, end: 0.8 },
      { word: "adios", start: 1.2, end: 1.5 },
      { word: "planeta", start: 1.6, end: 2.2 },
    ],
    segments: [
      { id: 1, text: "hola mundo", start: 0.1, end: 0.8 },
      { id: 2, text: "adios planeta", start: 1.2, end: 2.2 },
    ],
  };

  const result = alignPhrasesToTranscript(phrases, transcript);
  assert.equal(result.totalDurationSeconds, 4.2);
  assert.equal(result.phrases[0].startTime, 0);
  assert.equal(result.phrases[0].endTime, 0.8);
  assert.equal(result.phrases[0].alignment.source, "word-match");
  assert.equal(result.phrases[0].alignment.confidence, 1);
  assert.equal(result.phrases[0].alignment.severity, "ok");
  assert.deepEqual(result.phrases[0].alignment.warnings, []);
  assert.equal(result.phrases[1].startTime, 1.2);
  assert.equal(result.phrases[1].endTime, 2.2);
  assert.equal(result.phrases[1].alignment.source, "word-match");
});

test("alignPhrasesToTranscript cae a segmentos reales sin prorrateo", () => {
  const phrases = [
    { id: 1, phrase: "frase que no matchea", image: "a.jpg" },
    { id: 2, phrase: "otra frase imposible", image: "b.jpg" },
  ];

  const transcript = {
    words: [],
    totalDurationSeconds: 6,
    segments: [
      { id: 1, text: "texto uno", start: 0.2, end: 2.4 },
      { id: 2, text: "texto dos", start: 3.1, end: 5.8 },
    ],
  };

  const result = alignPhrasesToTranscript(phrases, transcript);
  assert.equal(result.phrases[0].startTime, 0);
  assert.equal(result.phrases[0].endTime, 2.4);
  assert.equal(result.phrases[0].alignment.source, "segment-fallback");
  assert.equal(result.phrases[0].alignment.confidence, 0);
  assert.equal(result.phrases[0].alignment.severity, "error");
  assert.match(result.phrases[0].alignment.warnings.join(" "), /fallback/i);
  assert.equal(result.phrases[1].startTime, 3.1);
  assert.equal(result.phrases[1].endTime, 5.8);
  assert.equal(result.phrases[1].alignment.source, "segment-fallback");
});

test("alignPhrasesToTranscript garantiza duracion positiva en tail fallback", () => {
  const phrases = [
    { id: 1, phrase: "uno", image: "a.jpg" },
    { id: 2, phrase: "dos", image: "b.jpg" },
    { id: 3, phrase: "tres", image: "c.jpg" },
  ];

  const transcript = {
    totalDurationSeconds: 1,
    words: [{ word: "uno", start: 0.1, end: 0.4 }],
    segments: [{ id: 1, text: "uno", start: 0.1, end: 0.4 }],
  };

  const result = alignPhrasesToTranscript(phrases, transcript);

  assert.equal(result.phrases[0].alignment.source, "word-match");
  assert.equal(result.phrases[1].alignment.source, "timeline-tail-fallback");
  assert.equal(result.phrases[1].alignment.severity, "error");
  assert.match(result.phrases[1].alignment.warnings.join(" "), /tail fallback/i);
  assert.equal(result.phrases[2].alignment.source, "timeline-tail-fallback");
  assert.ok(result.phrases[1].endTime > result.phrases[1].startTime);
  assert.ok(result.phrases[2].endTime > result.phrases[2].startTime);
  assert.ok(result.totalDurationSeconds > transcript.totalDurationSeconds);
});

test("alignPhrasesToTranscript fuerza que la primera imagen arranque en 0.00", () => {
  const phrases = [
    { id: 1, phrase: "hola mundo", image: "a.jpg" },
    { id: 2, phrase: "adios planeta", image: "b.jpg" },
  ];

  const transcript = {
    totalDurationSeconds: 4,
    words: [
      { word: "hola", start: 1.29, end: 1.5 },
      { word: "mundo", start: 1.55, end: 1.9 },
      { word: "adios", start: 2.5, end: 2.9 },
      { word: "planeta", start: 3.0, end: 3.6 },
    ],
    segments: [
      { id: 1, text: "hola mundo", start: 1.29, end: 1.9 },
      { id: 2, text: "adios planeta", start: 2.5, end: 3.6 },
    ],
  };

  const result = alignPhrasesToTranscript(phrases, transcript);
  assert.equal(result.phrases[0].startTime, 0);
  assert.ok(result.phrases[0].endTime > 0);
});

test("alignPhrasesToTranscript extiende la foto final dos segundos despues de la ultima frase", () => {
  const phrases = [{ id: 1, phrase: "cierre final", image: "a.jpg" }];
  const transcript = {
    totalDurationSeconds: 1,
    words: [
      { word: "cierre", start: 0.2, end: 0.5 },
      { word: "final", start: 0.6, end: 1.4 },
    ],
    segments: [{ id: 1, text: "cierre final", start: 0.2, end: 1.4 }],
  };

  const result = alignPhrasesToTranscript(phrases, transcript);

  assert.equal(result.phrases[0].startTime, 0);
  assert.equal(result.phrases[0].endTime, 1.4);
  assert.equal(result.totalDurationSeconds, 3.4);
});

test("alignPhrasesToTranscript marca warning para confianza parcial entre umbrales", () => {
  const phrases = [{ id: 1, phrase: "uno dos tres cuatro", image: "a.jpg" }];
  const transcript = {
    totalDurationSeconds: 2,
    words: [
      { word: "uno", start: 0, end: 0.2 },
      { word: "dos", start: 0.3, end: 0.5 },
      { word: "tres", start: 0.6, end: 0.8 },
    ],
    segments: [{ id: 1, text: "uno dos tres", start: 0, end: 0.8 }],
  };

  const result = alignPhrasesToTranscript(phrases, transcript);

  assert.equal(result.phrases[0].alignment.source, "word-match");
  assert.equal(result.phrases[0].alignment.confidence, 0.75);
  assert.equal(result.phrases[0].alignment.severity, "ok");
  assert.deepEqual(result.phrases[0].alignment.warnings, []);
});

test("alignPhrasesToTranscript reporta drift mayor a 250ms como warning diagnostico", () => {
  const phrases = [{ id: 1, phrase: "hola mundo", image: "a.jpg" }];
  const transcript = {
    totalDurationSeconds: 2,
    words: [
      { word: "hola", start: 0.5, end: 0.8 },
      { word: "mundo", start: 0.85, end: 1.1 },
    ],
    segments: [{ id: 1, text: "hola mundo", start: 0.1, end: 1.1 }],
  };

  const result = alignPhrasesToTranscript(phrases, transcript);

  assert.equal(result.phrases[0].alignment.source, "word-match");
  assert.equal(result.phrases[0].alignment.confidence, 1);
  assert.equal(result.phrases[0].alignment.severity, "warn");
  assert.equal(result.phrases[0].alignment.maxDriftMs, 400);
  assert.match(result.phrases[0].alignment.warnings.join(" "), /250ms/i);
});

test("alignPhrasesToTranscript alinea dos a cero con Whisper 2 -0 sin saltar a dos repetido", () => {
  const phrases = [
    { id: 1, phrase: "para poner el dos a cero parcial en el marcador", image: "a.jpg" },
  ];

  const transcript = {
    totalDurationSeconds: 80,
    words: [
      { word: "para", start: 63.4, end: 63.55 },
      { word: "poner", start: 63.56, end: 63.8 },
      { word: "el", start: 63.81, end: 63.92 },
      { word: "2", start: 63.93, end: 64.05 },
      { word: "-0", start: 64.06, end: 64.22 },
      { word: "parcial", start: 64.7, end: 65.1 },
      { word: "en", start: 65.15, end: 65.28 },
      { word: "el", start: 65.3, end: 65.42 },
      { word: "marcador", start: 65.5, end: 66.0 },
      { word: "dos", start: 74.2, end: 74.45 },
      { word: "defensores", start: 74.5, end: 75.1 },
    ],
    segments: [
      { id: 1, text: "para poner el 2 -0 parcial en el marcador", start: 63.4, end: 66.0 },
      { id: 2, text: "dos defensores", start: 74.2, end: 75.1 },
    ],
  };

  const result = alignPhrasesToTranscript(phrases, transcript);

  assert.equal(result.phrases[0].alignment.source, "word-match");
  assert.equal(result.phrases[0].alignment.confidence, 0.9);
  assert.equal(result.phrases[0].startTime, 0);
  assert.equal(result.phrases[0].endTime, 66);
});

test("alignPhrasesToTranscript rechaza matches parciales con salto largo a repetidos", () => {
  const phrases = [
    { id: 1, phrase: "para poner el dos a cero parcial en el marcador", image: "a.jpg" },
  ];

  const transcript = {
    totalDurationSeconds: 90,
    words: [
      { word: "para", start: 63.4, end: 63.55 },
      { word: "poner", start: 63.56, end: 63.8 },
      { word: "el", start: 63.81, end: 63.92 },
      { word: "dos", start: 74.2, end: 74.45 },
      { word: "defensores", start: 74.5, end: 75.1 },
      { word: "en", start: 75.2, end: 75.3 },
      { word: "el", start: 75.35, end: 75.45 },
      { word: "marcador", start: 75.5, end: 76.0 },
    ],
    segments: [{ id: 1, text: "para poner el", start: 63.4, end: 63.92 }],
  };

  const result = alignPhrasesToTranscript(phrases, transcript);

  assert.equal(result.phrases[0].alignment.source, "segment-fallback");
  assert.equal(result.phrases[0].alignment.severity, "error");
  assert.equal(result.phrases[0].startTime, 0);
  assert.equal(result.phrases[0].endTime, 63.92);
});

test("alignPhrasesToTranscript no usa fallback por indice cuando frases y segmentos no coinciden", () => {
  const phrases = [
    { id: 1, phrase: "frase real", image: "a.jpg" },
    { id: 2, phrase: "frase imposible", image: "b.jpg" },
    { id: 3, phrase: "otra frase imposible", image: "c.jpg" },
  ];

  const transcript = {
    totalDurationSeconds: 12,
    words: [
      { word: "frase", start: 10, end: 10.3 },
      { word: "real", start: 10.4, end: 11 },
    ],
    segments: [
      { id: 1, text: "segmento viejo", start: 0, end: 2 },
      { id: 2, text: "segmento tambien viejo", start: 5, end: 6 },
    ],
  };

  const result = alignPhrasesToTranscript(phrases, transcript);

  assert.equal(result.phrases[0].alignment.source, "word-match");
  assert.equal(result.phrases[1].alignment.source, "timeline-tail-fallback");
  assert.equal(result.phrases[2].alignment.source, "timeline-tail-fallback");
  assert.ok(result.phrases[1].startTime >= result.phrases[0].endTime);
  assert.ok(result.phrases[2].startTime >= result.phrases[1].endTime);
});

test("alignPhrasesToTranscript soporta multiples frases pipe dentro de un segmento Whisper", () => {
  const phrases = [
    { id: 1, phrase: "la seleccion ataca", image: "a.jpg" },
    { id: 2, phrase: "y convierte el gol", image: "b.jpg" },
  ];

  const transcript = {
    totalDurationSeconds: 8,
    words: [
      { word: "la", start: 1, end: 1.1 },
      { word: "seleccion", start: 1.12, end: 1.5 },
      { word: "ataca", start: 1.55, end: 2 },
      { word: "y", start: 2.1, end: 2.2 },
      { word: "convierte", start: 2.25, end: 2.8 },
      { word: "el", start: 2.82, end: 2.92 },
      { word: "gol", start: 3, end: 3.3 },
    ],
    segments: [{ id: 1, text: "la seleccion ataca y convierte el gol", start: 1, end: 3.3 }],
  };

  const result = alignPhrasesToTranscript(phrases, transcript);

  assert.equal(result.phrases[0].alignment.source, "word-match");
  assert.equal(result.phrases[0].startTime, 0);
  assert.equal(result.phrases[0].endTime, 2);
  assert.equal(result.phrases[1].alignment.source, "word-match");
  assert.equal(result.phrases[1].startTime, 2.1);
  assert.equal(result.phrases[1].endTime, 3.3);
});
