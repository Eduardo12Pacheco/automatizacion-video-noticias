const fs = require("fs");

function formatZodIssues(issues) {
  return issues
    .map((issue) => {
      const fieldPath = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${fieldPath}: ${issue.message}`;
    })
    .join("; ");
}

function parseJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`JSON invalido en ${filePath}: ${error.message}`);
  }
}

function validateJsonSchema(filePath, schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Contrato JSON invalido en ${filePath}: ${formatZodIssues(result.error.issues)}`,
    );
  }

  return result.data;
}

function readJsonSchema(filePath, schema) {
  return validateJsonSchema(filePath, schema, parseJsonFile(filePath));
}

function writeJsonSchema(filePath, schema, value) {
  const parsed = validateJsonSchema(filePath, schema, value);
  fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

module.exports = {
  formatZodIssues,
  readJsonSchema,
  validateJsonSchema,
  writeJsonSchema,
};
