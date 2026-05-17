'use strict';

function resultTriples(result, program = {}, options = {}) {
  return options.all ? result.closure : result.inferred;
}

module.exports = { resultTriples };
