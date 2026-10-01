'use strict';

// SPARQL 1.2 RL §4.1 (01 October 2026): assignments, head blank nodes,
// and head triple-term templates containing variables make a rule run once.
function assignmentsNeedRunOnce(clauses = []) {
  return clauses.some((clause) => clause.type === 'set' || clause.type === 'bind');
}

function ruleNeedsRunOnce(head = [], body = []) {
  return assignmentsNeedRunOnce(body)
    || head.some(tripleHasBlankNode)
    || head.some(tripleHasVariableTripleTerm);
}

function tripleHasVariableTripleTerm(triple) {
  return [triple && triple.s, triple && triple.p, triple && triple.o]
    .some((term) => term && term.type === 'triple' && termHasVariable(term));
}

function termHasVariable(term) {
  if (!term) return false;
  if (term.type === 'var') return true;
  if (term.type === 'triple') return termHasVariable(term.s) || termHasVariable(term.p) || termHasVariable(term.o);
  return false;
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

module.exports = { assignmentsNeedRunOnce, ruleNeedsRunOnce, tripleHasBlankNode, termHasBlankNode, tripleHasVariableTripleTerm };
