'use strict';

// Most SET expressions are deterministic and can safely participate in the
// ordinary fixpoint loop.  Only genuinely fresh generators need run-once
// evaluation, otherwise a recursive rule such as SET(?x := UUID()) would keep
// creating new terms forever.
function assignmentsNeedRunOnce(clauses = [], options = {}) {
  if (options.shacl12Conformance) {
    return clauses.some((clause) => clause.type === 'set' || clause.type === 'bind');
  }
  const hasSet = clauses.some((clause) => clause.type === 'set');
  const hasNegation = clauses.some((clause) => clause.type === 'not');
  return (hasSet && hasNegation)
    || clauses.some((clause) => (clause.type === 'set' || clause.type === 'bind') && expressionIsVolatile(clause.expr));
}

function ruleNeedsRunOnce(head = [], body = [], options = {}) {
  return assignmentsNeedRunOnce(body, options) || head.some(tripleHasBlankNode);
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

function expressionIsVolatile(expr) {
  if (!expr) return false;
  switch (expr.type) {
    case 'call': {
      const name = localName(expr.name).toLowerCase();
      if (name === 'uuid' || name === 'struuid') return true;
      if (name === 'bnode' && (!expr.args || expr.args.length === 0)) return true;
      return (expr.args || []).some(expressionIsVolatile);
    }
    case 'binary':
      return expressionIsVolatile(expr.left) || expressionIsVolatile(expr.right);
    case 'unary':
      return expressionIsVolatile(expr.expr);
    case 'list':
      return (expr.items || []).some(expressionIsVolatile);
    default:
      return false;
  }
}

function localName(name) {
  const text = String(name || '');
  const hash = text.lastIndexOf('#');
  const slash = text.lastIndexOf('/');
  const colon = text.lastIndexOf(':');
  const index = Math.max(hash, slash, colon);
  return index >= 0 ? text.slice(index + 1) : text;
}

module.exports = { assignmentsNeedRunOnce, ruleNeedsRunOnce, expressionIsVolatile, tripleHasBlankNode, termHasBlankNode };
