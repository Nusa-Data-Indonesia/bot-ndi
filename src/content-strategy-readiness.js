'use strict';

// Phase A deliberately ships without the Phase B category/style engine. Keep
// publication closed until that engine and its per-slot state are implemented.
/** @type {{readonly ready: boolean, readonly reasonCode: string, readonly message: string}} */
const CONTENT_STRATEGY_READINESS = Object.freeze({
  ready: false,
  reasonCode: 'CONTENT_STRATEGY_NOT_READY',
  message: 'Penerbitan menunggu mesin kategori dan gaya konten Fase B.',
});

module.exports = { CONTENT_STRATEGY_READINESS };
