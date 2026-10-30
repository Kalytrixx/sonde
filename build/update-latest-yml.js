// Après la signature de l'installateur Windows, son contenu change : on remet
// dans latest.yml la taille et l'empreinte SHA-512 du fichier signé, sinon
// Sonde refuserait la mise à jour. L'ancien .blockmap ne correspond plus :
// on le supprime (la mise à jour se télécharge alors en entier).
//
// Usage : node build/update-latest-yml.js release

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dir = process.argv[2] || "release";
const ymlPath = path.join(dir, "latest.yml");
let yml = fs.readFileSync(ymlPath, "utf8");
const file = /^\s*-?\s*url:\s*(.+\.exe)\s*$/m.exec(yml)?.[1]?.trim();
if (!file) throw new Error("Aucun .exe dans latest.yml");
const exe = path.join(dir, file);
const buf = fs.readFileSync(exe);
const sha512 = crypto.createHash("sha512").update(buf).digest("base64");

yml = yml.replace(/^(\s*sha512:\s*).+$/gm, `$1${sha512}`).replace(/^(\s*size:\s*)\d+$/gm, `$1${buf.length}`);
fs.writeFileSync(ymlPath, yml);
fs.rmSync(`${exe}.blockmap`, { force: true });
console.log(`latest.yml mis à jour pour ${file} (${buf.length} octets).`);
