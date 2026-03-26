const fs = require("fs");
const path = require("path");

const projectRoot = process.cwd();
const requiredDirs = ["guion", "audio", "imagenes", "output"];

for (const dir of requiredDirs) {
  const absolutePath = path.join(projectRoot, dir);
  fs.mkdirSync(absolutePath, { recursive: true });
}

const guionPath = path.join(projectRoot, "guion", "guion.txt");
if (!fs.existsSync(guionPath)) {
  fs.writeFileSync(
    guionPath,
    "Escena de apertura con energia|Presentacion del tema principal|Cierre con llamado a la accion\n",
    "utf8",
  );
}

console.log("Estructura del proyecto lista:", requiredDirs.join(", "));
