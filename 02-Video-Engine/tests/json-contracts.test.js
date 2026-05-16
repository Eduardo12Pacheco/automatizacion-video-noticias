const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { z } = require("zod");
const {
  readJsonSchema,
  writeJsonSchema,
} = require("../scripts/lib/json-contracts");
const { scriptPhrasesSchema } = require("../scripts/lib/schemas");

function makeTempPath(fileName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-editor-json-"));
  return path.join(dir, fileName);
}

test("readJsonSchema falla JSON invalido con ruta del contrato", () => {
  const contractPath = makeTempPath("bad.json");
  fs.writeFileSync(contractPath, "{ invalid", "utf8");

  assert.throws(
    () => readJsonSchema(contractPath, z.object({ ok: z.boolean() })),
    (error) => {
      assert.match(error.message, /JSON invalido/);
      assert.match(error.message, /bad\.json/);
      return true;
    },
  );
});

test("readJsonSchema falla schema invalido con ruta y campo violado", () => {
  const contractPath = makeTempPath("timeline.json");
  fs.writeFileSync(contractPath, JSON.stringify({ totalDurationSeconds: "5" }));

  assert.throws(
    () =>
      readJsonSchema(
        contractPath,
        z.object({ totalDurationSeconds: z.number(), frames: z.array(z.any()) }),
      ),
    (error) => {
      assert.match(error.message, /Contrato JSON invalido/);
      assert.match(error.message, /timeline\.json/);
      assert.match(error.message, /totalDurationSeconds/);
      assert.match(error.message, /frames/);
      return true;
    },
  );
});

test("writeJsonSchema valida antes de escribir y serializa JSON estable", () => {
  const contractPath = makeTempPath("valid.json");
  const schema = z.object({ id: z.number(), label: z.string() });

  writeJsonSchema(contractPath, schema, { id: 7, label: "ok" });

  assert.equal(
    fs.readFileSync(contractPath, "utf8"),
    '{\n  "id": 7,\n  "label": "ok"\n}\n',
  );
  assert.throws(
    () => writeJsonSchema(contractPath, schema, { id: "bad", label: "ok" }),
    /id/,
  );
});

test("scriptPhrasesSchema valida la forma real del contrato con phrases", () => {
  const validPayload = scriptPhrasesSchema.parse({
    phrases: [
      {
        id: 1,
        blockIndex: 0,
        phrase: "Bosque en calma",
        keywords: ["bosque", "calma"],
        image: "bosque.jpg",
        imageSelection: {
          strategy: "keyword",
          matchedKeywords: ["bosque"],
          score: 2,
          reason: "filename match",
          severity: "ok",
          warnings: [],
        },
      },
    ],
  });

  assert.equal(validPayload.phrases[0].blockIndex, 0);
  assert.deepEqual(validPayload.phrases[0].keywords, ["bosque", "calma"]);
  assert.throws(
    () => scriptPhrasesSchema.parse([{ id: 1, phrase: "Bosque", image: "bosque.jpg" }]),
    /expected object|Invalid input/i,
  );
});
