// Règles du système courant : lib/rules/win32.js ou lib/rules/linux.js.
// Les deux exportent la même chose (CLEANABLE, isProtected, categorize,
// garde-fous de l'IA, textes propres au système…).
module.exports = require(`./rules/${require("./platform").ID}`);
