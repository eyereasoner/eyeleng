'use strict';

// SPARQL 1.2 RL run-once rules are exactly rules with an assignment element
// or a blank node in the rule head. See SPARQL-RL §4.4.
function assignmentsNeedRunOnce(clauses = []) {
  return clauses.some((clause) => clause.type === 'set' || clause.type === 'bind');
}

function ruleNeedsRunOnce(head = [], body = []) {
  return assignmentsNeedRunOnce(body) || head.some(tripleHasBlankNode);
}

function tripleHasBlankNode(triple) {
  return termHasBlankNode(triple && triple.s)
    || termHasBlankNode(triple && triple.p)
    || termHasBlankNode(triple && triple.o);
}

function termHasBlankNode(term) {
  if (!term) return false;
  if (term.type === 'blank') return true;
  if (term.type === 'triple') return termHasBlankNode(term.s) || termHasBlankNode(term.p) || termHasBlankNode(term.o);
  return false;
}

module.exports = { assignmentsNeedRunOnce, ruleNeedsRunOnce, tripleHasBlankNode, termHasBlankNode };
