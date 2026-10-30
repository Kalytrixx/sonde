// Corbeille du système : jamais de suppression définitive.
// Windows : lib/trash-win32.js ; Linux : lib/trash-linux.js (format freedesktop).
// Les deux exportent check, send, binStatus, binItems, restoreOne, restoreEntry.
module.exports = require(require("./platform").IS_WIN ? "./trash-win32" : "./trash-linux");
