'use strict';

const { tokenize, SyntaxErrorWithLocation } = require('./tokenizer.js');
const { ruleNeedsRunOnce } = require('./assignments.js');
const {
  iri,
  variable,
  blankNode,
  literal,
  tripleTerm,
  termKey,
  termEquals,
  formatTerm,
  RDF_TYPE,
  RDF_FIRST,
  RDF_REST,
  RDF_NIL,
  XSD_BOOLEAN,
  XSD_INTEGER,
  XSD_DECIMAL,
  XSD_DOUBLE,
} = require('./term.js');

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SRL_NS = 'http://www.w3.org/ns/shacl-rules#';
const SHNEX_NS = 'http://www.w3.org/ns/shacl-node-expr#';
const SPARQL_NS = 'http://www.w3.org/ns/sparql#';
const OWL_IMPORTS = 'http://www.w3.org/2002/07/owl#imports';
const SRL_RULE_SET = `${SRL_NS}RuleSet`;
const SRL_RULE = `${SRL_NS}Rule`;
const SRL_DATA = `${SRL_NS}data`;
const SRL_RULES = `${SRL_NS}rules`;
const SRL_BODY = `${SRL_NS}body`;
const SRL_HEAD = `${SRL_NS}head`;
const SRL_SUBJECT = `${SRL_NS}subject`;
const SRL_PREDICATE = `${SRL_NS}predicate`;
const SRL_OBJECT = `${SRL_NS}object`;
const SRL_FILTER = `${SRL_NS}filter`;
const SRL_EXPR = `${SRL_NS}expr`;
const SRL_ASSIGN = `${SRL_NS}assign`;
const SRL_ASSIGN_VAR = `${SRL_NS}assignVar`;
const SRL_ASSIGN_VALUE = `${SRL_NS}assignValue`;
const SRL_NOT = `${SRL_NS}not`;
const SRL_VAR_NAME = `${SRL_NS}varName`;
const SHNEX_VAR = `${SHNEX_NS}var`;

class TurtleParser {
  constructor(source, options = {}) {
    this.tokens = Array.isArray(source) ? source : tokenize(source, options.filename || '<rdf>');
    this.pos = 0;
    this.baseIRI = options.baseIRI || null;
    this.bnodeCounter = 0;
    this.prefixes = {
      '': 'http://example/',
      rdf: RDF_NS,
      srl: SRL_NS,
      shnex: SHNEX_NS,
      sparql: SPARQL_NS,
      xsd: 'http://www.w3.org/2001/XMLSchema#',
      owl: 'http://www.w3.org/2002/07/owl#',
      ...options.prefixes,
    };
    this.triples = [];
    this.imports = [];
  }

  parseDocument() {
    while (!this.is('eof')) {
      if (this.matchDirective('PREFIX', '@prefix')) this.parsePrefix(this.previous().value.startsWith('@'));
      else if (this.matchDirective('BASE', '@base')) this.parseBase(this.previous().value.startsWith('@'));
      else this.parseTriplesStatement();
    }
    return {
      baseIRI: this.baseIRI,
      prefixes: { ...this.prefixes },
      triples: this.triples,
      imports: this.imports.slice(),
    };
  }

  parsePrefix(atStyle = false) {
    const nameToken = this.advance();
    if (nameToken.type !== 'word' || !nameToken.value.endsWith(':')) throw this.error('Expected prefix label ending in :', nameToken);
    const iriToken = this.expectType('iri');
    this.prefixes[nameToken.value.slice(0, -1)] = this.resolveIRI(iriToken.value, iriToken);
    if (atStyle) this.expectValue('.');
  }

  parseBase(atStyle = false) {
    const iriToken = this.expectType('iri');
    this.baseIRI = this.resolveIRI(iriToken.value, iriToken);
    if (atStyle) this.expectValue('.');
  }

  parseTriplesStatement() {
    const subjectNode = this.parseNode();
    this.triples.push(...subjectNode.triples);
    this.triples.push(...this.parsePredicateObjectList(subjectNode.term, ['.']));
    this.expectValue('.');
  }

  parsePredicateObjectList(subject, terminators = [']']) {
    const triples = [];
    while (!terminators.some((value) => this.checkValue(value))) {
      const predicate = this.parseVerb();
      do {
        const objectNode = this.parseNode();
        triples.push(...objectNode.triples);
        triples.push({ s: subject, p: predicate, o: objectNode.term });
        if (predicate.type === 'iri' && predicate.value === OWL_IMPORTS && objectNode.term.type === 'iri') this.imports.push(objectNode.term.value);
      } while (this.matchValue(','));
      if (this.matchValue(';')) {
        while (this.matchValue(';')) { /* tolerate repeated semicolons */ }
        if (terminators.some((value) => this.checkValue(value))) break;
      } else break;
    }
    return triples;
  }

  parseNode() {
    if (this.checkValue('[')) return this.parseBlankNodePropertyList();
    if (this.checkValue('(')) return this.parseCollection();
    return { term: this.parseTerm(), triples: [] };
  }

  parseBlankNodePropertyList() {
    this.expectValue('[');
    const node = this.freshBlankNode();
    if (this.matchValue(']')) return { term: node, triples: [] };
    const triples = this.parsePredicateObjectList(node, [']']);
    this.expectValue(']');
    return { term: node, triples };
  }

  parseCollection() {
    this.expectValue('(');
    if (this.matchValue(')')) return { term: iri(RDF_NIL), triples: [] };
    const items = [];
    while (!this.checkValue(')')) items.push(this.parseNode());
    this.expectValue(')');
    const triples = [];
    for (const item of items) triples.push(...item.triples);
    const cells = items.map(() => this.freshBlankNode());
    for (let i = 0; i < items.length; i += 1) {
      triples.push({ s: cells[i], p: iri(RDF_FIRST), o: items[i].term });
      triples.push({ s: cells[i], p: iri(RDF_REST), o: i + 1 < cells.length ? cells[i + 1] : iri(RDF_NIL) });
    }
    return { term: cells[0], triples };
  }

  parseVerb() {
    if (this.checkType('word') && this.peek().value === 'a') { this.advance(); return iri(RDF_TYPE); }
    const term = this.parseTerm();
    if (term.type !== 'iri') throw this.error('Expected IRI as Turtle predicate');
    return term;
  }

  parseTerm() {
    const token = this.advance();
    if (token.type === 'operator' && (token.value === '+' || token.value === '-') && this.peek().type === 'number') {
      const numberToken = this.advance();
      return numericLiteral(token.value === '-' ? -numberToken.value : numberToken.value);
    }
    if (token.type === 'iri') return iri(this.resolveIRI(token.value, token));
    if (token.type === 'string') return this.parseLiteralAfterToken(token);
    if (token.type === 'number') return numericLiteral(token.value);
    if (token.value === '<<(') return this.parseTripleTermAfterOpen();
    if (token.type === 'word') {
      const word = token.value.includes(':') || token.value.startsWith('_:') ? this.consumeHyphenatedWord(token.value) : token.value;
      if (word === 'a') return iri(RDF_TYPE);
      if (word === 'true') return literal(true, XSD_BOOLEAN);
      if (word === 'false') return literal(false, XSD_BOOLEAN);
      if (word.startsWith('_:')) return blankNode(word.slice(2));
      if (word.includes(':')) return iri(this.expandPrefixedName(word, token));
    }
    throw this.error(`Expected RDF term, got ${token.value}`, token);
  }

  parseTripleTermAfterOpen() {
    const s = this.parseTerm();
    const p = this.parseVerb();
    const o = this.parseTerm();
    this.expectValue(')>>');
    return tripleTerm(s, p, o);
  }

  parseLiteralAfterToken(token) {
    if (this.matchValue('^^')) {
      const datatype = this.parseDatatypeIRI();
      return literal(coerceLexicalLiteral(token.value, datatype), datatype, null);
    }
    if (this.checkType('word') && /^@[A-Za-z]+(?:-[A-Za-z0-9]+)*(?:--[A-Za-z]+)?$/.test(this.peek().value)) {
      const tag = this.advance().value.slice(1).toLowerCase();
      const [lang, langDir = null] = tag.split('--');
      return literal(token.value, null, lang, langDir);
    }
    return literal(token.value);
  }

  parseDatatypeIRI() {
    const token = this.advance();
    if (token.type === 'iri') return this.resolveIRI(token.value, token);
    if (token.type === 'word' && token.value.includes(':')) return this.expandPrefixedName(token.value, token);
    throw this.error(`Expected datatype IRI, got ${token.value}`, token);
  }

  freshBlankNode() {
    this.bnodeCounter += 1;
    return blankNode(`rdf${this.bnodeCounter}`);
  }

  consumeHyphenatedWord(value) {
    let out = value;
    while (this.checkValue('-') && (this.peekN(1).type === 'word' || this.peekN(1).type === 'number')) {
      this.advance();
      out += `-${this.advance().value}`;
    }
    return out;
  }

  expandPrefixedName(value, token) {
    const colon = value.indexOf(':');
    if (colon < 0) throw this.error(`Expected prefixed name, got ${value}`, token);
    const prefix = value.slice(0, colon);
    const local = value.slice(colon + 1);
    if (!Object.hasOwn(this.prefixes, prefix)) throw this.error(`Unknown prefix ${prefix}:`, token);
    return this.prefixes[prefix] + local;
  }

  resolveIRI(value) {
    if (!this.baseIRI || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return value;
    try { return new URL(value, this.baseIRI).href; } catch (_) { return value; }
  }

  matchDirective(...names) {
    if (this.checkType('word')) {
      const value = this.peek().value;
      if (names.some((name) => value.toUpperCase() === name.toUpperCase())) { this.advance(); return true; }
    }
    return false;
  }

  previous() { return this.tokens[this.pos - 1]; }
  peek() { return this.tokens[this.pos]; }
  peekN(n) { return this.tokens[this.pos + n]; }
  is(type) { return this.peek().type === type; }
  checkType(type) { return this.peek().type === type; }
  checkValue(value) { return this.peek().value === value; }
  matchValue(value) { if (this.checkValue(value)) { this.advance(); return true; } return false; }
  advance() { return this.tokens[this.pos++]; }
  expectType(type) { const token = this.advance(); if (token.type !== type) throw this.error(`Expected ${type}, got ${token.value}`, token); return token; }
  expectValue(value) { const token = this.advance(); if (token.value !== value) throw this.error(`Expected ${value}, got ${token.value}`, token); return token; }
  error(message, token = this.peek()) { return new SyntaxErrorWithLocation(message, token); }
}

function parseRdfDocument(source, options = {}) {
  return new TurtleParser(source, options).parseDocument();
}

function parseRdfSyntax(source, options = {}) {
  const document = parseRdfDocument(source, options);
  return rdfDocumentToProgram(document, options);
}

function rdfDocumentToProgram(document, options = {}) {
  const graph = new RdfGraph(document.triples, document.prefixes);
  const ruleSetNodes = chooseRuleSets(graph, options.ruleSet);
  if (ruleSetNodes.length === 0) throw new Error('No srl:RuleSet found in RDF Rules syntax input');

  const program = {
    baseIRI: document.baseIRI || null,
    version: null,
    imports: options.rdfImportsAsImports ? document.imports.slice() : [],
    prefixes: { ...document.prefixes },
    data: [],
    rules: [],
    rdfSyntax: true,
    options: { shacl12Conformance: !!options.shacl12Conformance },
    ruleSets: ruleSetNodes.map((term) => formatTerm(term, document.prefixes)),
  };

  for (const ruleSet of ruleSetNodes) {
    for (const dataList of graph.objects(ruleSet, SRL_DATA)) {
      for (const item of graph.list(dataList)) program.data.push(toDataTriple(item, graph));
    }
    for (const rulesList of graph.objects(ruleSet, SRL_RULES)) {
      for (const ruleNode of graph.list(rulesList)) program.rules.push(toRule(ruleNode, graph, options));
    }
  }
  return program;
}

function chooseRuleSets(graph, selected) {
  if (selected) {
    const term = graph.parseReference(selected);
    return [term];
  }
  const typed = graph.subjects(RDF_TYPE, iri(SRL_RULE_SET));
  if (typed.length > 0) return uniqueTerms(typed);
  const byData = graph.subjectsWithPredicate(SRL_DATA);
  const byRules = graph.subjectsWithPredicate(SRL_RULES);
  return uniqueTerms([...byData, ...byRules]).filter((term) => graph.objects(term, SRL_RULES).length > 0 || graph.objects(term, SRL_DATA).length > 0);
}

function toDataTriple(item, graph) {
  if (item.type === 'triple') return { s: item.s, p: item.p, o: item.o };
  const triple = toTripleLike(item, graph);
  if ([triple.s, triple.p, triple.o].some((term) => term.type === 'var')) throw new Error('RDF Rules srl:data may not contain variables');
  if (triple.p.type !== 'iri') throw new Error('RDF Rules data triple predicate must be an IRI');
  return triple;
}

function toRule(ruleNode, graph, options = {}) {
  const bodyLists = graph.objects(ruleNode, SRL_BODY);
  const headLists = graph.objects(ruleNode, SRL_HEAD);
  if (bodyLists.length !== 1 || headLists.length !== 1) throw new Error(`RDF Rule ${graph.label(ruleNode)} must have exactly one srl:body and one srl:head`);
  const body = graph.list(bodyLists[0]).map((item) => toBodyElement(item, graph));
  const head = graph.list(headLists[0]).map((item) => toTripleLike(item, graph));
  return { name: graph.label(ruleNode), head, body, runOnce: ruleNeedsRunOnce(head, body, options) };
}

function toBodyElement(node, graph) {
  if (hasTripleShape(node, graph)) return { type: 'triple', triple: toTripleLike(node, graph) };
  const filters = graph.objects(node, SRL_FILTER).concat(graph.objects(node, SRL_EXPR));
  if (filters.length > 0) {
    if (filters.length !== 1) throw new Error(`Filter element ${graph.label(node)} must have exactly one srl:filter`);
    return { type: 'filter', expr: toExpression(filters[0], graph) };
  }
  const assigns = graph.objects(node, SRL_ASSIGN);
  if (assigns.length > 0) {
    if (assigns.length !== 1) throw new Error(`Assignment element ${graph.label(node)} must have exactly one srl:assign`);
    const assign = assigns[0];
    const vars = graph.objects(assign, SRL_ASSIGN_VAR);
    const values = graph.objects(assign, SRL_ASSIGN_VALUE);
    if (vars.length !== 1 || values.length !== 1) throw new Error(`Assignment ${graph.label(assign)} must have exactly one srl:assignVar and srl:assignValue`);
    const variableTerm = toVarOrTerm(vars[0], graph);
    if (variableTerm.type !== 'var') throw new Error('srl:assignVar must point to a variable node');
    return { type: 'set', variable: variableTerm.value, expr: toExpression(values[0], graph) };
  }
  const negations = graph.objects(node, SRL_NOT);
  if (negations.length > 0) {
    if (negations.length !== 1) throw new Error(`Negation element ${graph.label(node)} must have exactly one srl:not`);
    const body = graph.list(negations[0]).map((item) => {
      const clause = toBodyElement(item, graph);
      if (clause.type === 'set' || clause.type === 'not') throw new Error('RDF Rules srl:not may contain only triple patterns and filters');
      return clause;
    });
    return { type: 'not', body };
  }
  throw new Error(`Unsupported RDF Rules body element ${graph.label(node)}`);
}

function toTripleLike(node, graph) {
  if (node.type === 'triple') return { s: node.s, p: node.p, o: node.o };
  const subjects = graph.objects(node, SRL_SUBJECT);
  const predicates = graph.objects(node, SRL_PREDICATE);
  const objects = graph.objects(node, SRL_OBJECT);
  if (subjects.length !== 1 || predicates.length !== 1 || objects.length !== 1) {
    throw new Error(`Triple node ${graph.label(node)} must have exactly one srl:subject, srl:predicate and srl:object`);
  }
  return {
    s: toVarOrTerm(subjects[0], graph),
    p: toVarOrTerm(predicates[0], graph),
    o: toVarOrTerm(objects[0], graph),
  };
}

function hasTripleShape(node, graph) {
  return graph.objects(node, SRL_SUBJECT).length > 0 || graph.objects(node, SRL_PREDICATE).length > 0 || graph.objects(node, SRL_OBJECT).length > 0;
}

function toVarOrTerm(node, graph) {
  const varNames = graph.objects(node, SRL_VAR_NAME);
  if (varNames.length > 0) {
    if (varNames.length !== 1 || varNames[0].type !== 'literal') throw new Error(`Variable node ${graph.label(node)} must have exactly one string srl:varName`);
    return variable(String(varNames[0].value));
  }
  return node;
}

function toExpression(node, graph) {
  const varNames = graph.objects(node, SHNEX_VAR).concat(graph.objects(node, SRL_VAR_NAME));
  if (varNames.length > 0) {
    if (varNames.length !== 1 || varNames[0].type !== 'literal') throw new Error(`Expression variable ${graph.label(node)} must name one variable`);
    return { type: 'var', name: String(varNames[0].value) };
  }
  if (node.type === 'literal') {
    if (node.datatype || node.lang) return { type: 'term', value: node };
    return { type: 'literal', value: node.value };
  }
  if (node.type === 'iri' || node.type === 'blank' || node.type === 'triple') {
    const call = graph.functionCall(node);
    if (call) return toFunctionExpression(call.name, call.args.map((arg) => toExpression(arg, graph)));
    if (node.type === 'blank' && graph.hasOutgoing(node)) return { type: 'term', value: node };
    return { type: 'term', value: toVarOrTerm(node, graph) };
  }
  return { type: 'term', value: node };
}

function toFunctionExpression(name, args) {
  if (name.startsWith(SPARQL_NS)) {
    const local = name.slice(SPARQL_NS.length);
    if (local === 'less-than' || local === 'lessThan') return binary('<', args);
    if (local === 'less-than-or-equal' || local === 'lessThanOrEqual') return binary('<=', args);
    if (local === 'greater-than' || local === 'greaterThan') return binary('>', args);
    if (local === 'greater-than-or-equal' || local === 'greaterThanOrEqual') return binary('>=', args);
    if (local === 'equal' || local === 'equals') return binary('=', args);
    if (local === 'not-equal' || local === 'notEqual') return binary('!=', args);
    if (local === 'add') return foldBinary('+', args);
    if (local === 'subtract') return binary('-', args);
    if (local === 'multiply') return foldBinary('*', args);
    if (local === 'divide') return binary('/', args);
    if (local === 'and' || local === 'function-and') return foldBinary('&&', args);
    if (local === 'or' || local === 'function-or') return foldBinary('||', args);
    if (local === 'not') return { type: 'unary', op: '!', expr: args[0] };
    const builtin = sparqlLocalToBuiltin(local);
    return { type: 'call', name: builtin, args };
  }
  return { type: 'call', name, args };
}

function binary(op, args) {
  if (args.length !== 2) throw new Error(`sparql operator ${op} expects 2 arguments`);
  return { type: 'binary', op, left: args[0], right: args[1] };
}

function foldBinary(op, args) {
  if (args.length < 2) throw new Error(`sparql operator ${op} expects at least 2 arguments`);
  return args.slice(1).reduce((left, right) => ({ type: 'binary', op, left, right }), args[0]);
}

function sparqlLocalToBuiltin(local) {
  return local.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()).replace(/^./, (ch) => ch.toUpperCase());
}

class RdfGraph {
  constructor(triples, prefixes = {}) {
    this.triples = triples;
    this.prefixes = prefixes;
    this.bySubject = new Map();
    for (const triple of triples) {
      const key = termKey(triple.s);
      if (!this.bySubject.has(key)) this.bySubject.set(key, []);
      this.bySubject.get(key).push(triple);
    }
  }

  objects(subject, predicateIRI) {
    const rows = this.bySubject.get(termKey(subject)) || [];
    return rows.filter((triple) => triple.p.type === 'iri' && triple.p.value === predicateIRI).map((triple) => triple.o);
  }

  subjects(predicateIRI, object) {
    return this.triples.filter((triple) => triple.p.type === 'iri' && triple.p.value === predicateIRI && termEquals(triple.o, object)).map((triple) => triple.s);
  }

  subjectsWithPredicate(predicateIRI) {
    return this.triples.filter((triple) => triple.p.type === 'iri' && triple.p.value === predicateIRI).map((triple) => triple.s);
  }

  hasOutgoing(subject) {
    return (this.bySubject.get(termKey(subject)) || []).length > 0;
  }

  list(head) {
    const out = [];
    let node = head;
    const seen = new Set();
    while (!(node.type === 'iri' && node.value === RDF_NIL)) {
      const key = termKey(node);
      if (seen.has(key)) throw new Error(`Cycle in RDF list at ${this.label(node)}`);
      seen.add(key);
      const first = this.objects(node, RDF_FIRST);
      const rest = this.objects(node, RDF_REST);
      if (first.length !== 1 || rest.length !== 1) throw new Error(`Expected RDF list node at ${this.label(node)}`);
      out.push(first[0]);
      node = rest[0];
    }
    return out;
  }

  functionCall(node) {
    if (node.type !== 'blank') return null;
    const rows = (this.bySubject.get(termKey(node)) || []).filter((triple) => triple.p.type === 'iri');
    const calls = rows.filter((triple) => triple.p.value.startsWith(SPARQL_NS) || triple.p.value.includes('#') || triple.p.value.includes('/'));
    const viable = calls.filter((triple) => isRdfListHead(triple.o, this));
    if (viable.length !== 1) return null;
    return { name: viable[0].p.value, args: this.list(viable[0].o) };
  }

  parseReference(text) {
    if (typeof text !== 'string') return text;
    if (text.startsWith('<') && text.endsWith('>')) return iri(text.slice(1, -1));
    if (text.startsWith('_:')) return blankNode(text.slice(2));
    const colon = text.indexOf(':');
    if (colon >= 0) {
      const prefix = text.slice(0, colon);
      const local = text.slice(colon + 1);
      const ns = this.prefixes[prefix] || (prefix === 'srl' ? SRL_NS : null);
      if (ns) return iri(ns + local);
    }
    return iri(text);
  }

  label(term) { return formatTerm(term, this.prefixes); }
}

function isRdfListHead(term, graph) {
  return (term.type === 'iri' && term.value === RDF_NIL) || graph.objects(term, RDF_FIRST).length === 1;
}

function uniqueTerms(terms) {
  const seen = new Set();
  const out = [];
  for (const term of terms) {
    const key = termKey(term);
    if (!seen.has(key)) { seen.add(key); out.push(term); }
  }
  return out;
}

function numericLiteral(value) {
  if (Number.isInteger(value)) return literal(value, XSD_INTEGER);
  if (String(value).includes('e') || String(value).includes('E')) return literal(value, XSD_DOUBLE);
  return literal(value, XSD_DECIMAL);
}

function parseIntegerLiteral(value) {
  const text = String(value);
  const asNumber = Number.parseInt(text, 10);
  return Number.isSafeInteger(asNumber) && String(asNumber) === text.replace(/^\+/, '') ? asNumber : BigInt(text);
}

function coerceLexicalLiteral(value, datatype) {
  if (datatype === XSD_INTEGER) return parseIntegerLiteral(value);
  if (datatype === XSD_DECIMAL || datatype === XSD_DOUBLE) return Number(value);
  if (datatype === XSD_BOOLEAN) return value === true || value === 'true' || value === '1';
  return value;
}

function looksLikeRdfRules(source, options = {}) {
  if (options.syntax === 'rdf') return true;
  if (options.syntax === 'srl') return false;
  if (options.filename && /\.(ttl|trig|nt|n3)$/i.test(options.filename)) return true;
  return /\bsrl:RuleSet\b|\bsrl:rules\b|http:\/\/www\.w3\.org\/ns\/shacl-rules#RuleSet/.test(source);
}

module.exports = {
  parseRdfDocument,
  parseRdfSyntax,
  rdfDocumentToProgram,
  looksLikeRdfRules,
  TurtleParser,
  RdfGraph,
  constants: {
    SRL_NS,
    SHNEX_NS,
    SPARQL_NS,
    SRL_RULE_SET,
    SRL_RULE,
  },
};


// ---- Grammar-hardened RDF 1.1 / RDF 1.2 syntax helpers ----
// These functions are used by the W3C RDF manifest harness and are kept in
// rdfSyntax.js beside the existing Turtle/RDF-Rules front-end instead of in a
// separate monolithic test file.  They intentionally keep an internal test
// graph representation because the W3C manifests exercise syntax, datasets,
// triple terms, and RDF 1.2 annotation isomorphism independently from the SRL
// rule engine representation.
const rdfW3cSyntax = (() => {
// Grammar-hardened RDF syntax code shared by the RDF Rules front-end and W3C manifest harness.
function iri(value) {
  if (!value) throw new Error('iri(value) requires a non-empty value');
  return Object.freeze({ kind: 'iri', value: String(value) });
}
function literal(value, datatype = null, language = null, langDir = null) {
  return Object.freeze({ kind: 'literal', value: String(value), datatype, language, langDir });
}
function blank(value) {
  const clean = String(value || '').replace(/^_:/, '');
  if (!clean) throw new Error('blank(value) requires a name');
  return Object.freeze({ kind: 'blank', value: clean });
}
function tripleTerm(s, p, o) { return Object.freeze({ kind: 'triple', s, p, o }); }
function variable(name) {
  const clean = String(name || '').replace(/^\?/, '');
  if (!clean) throw new Error('variable(name) requires a name');
  return Object.freeze({ kind: 'var', name: clean });
}
function triple(s, p, o, graph = null) { return Object.freeze({ s, p, o, graph }); }
function termKey(term) {
  if (!term) return 'default';
  switch (term.kind) {
    case 'iri': return `I:${term.value}`;
    case 'literal': return `L:${JSON.stringify(term.value)}^^${term.datatype || ''}@${term.language || ''}`;
    case 'blank': return `B:${term.value}`;
    case 'var': return `V:${term.name}`;
    case 'triple': return `T:${termKey(term.s)} ${termKey(term.p)} ${termKey(term.o)}`;
    default: throw new Error(`Unsupported term kind: ${term.kind}`);
  }
}
function tripleKey(t) { return `${termKey(t.s)} ${termKey(t.p)} ${termKey(t.o)} ${termKey(t.graph)}`; }
class Rule { constructor({ id, body = [], head = [], profile = 'n3-rules-subset-v0' } = {}) { this.id = id; this.body = body; this.head = head; this.profile = profile; } }

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDF_TYPE = `${RDF_NS}type`;
const RDF_FIRST = `${RDF_NS}first`;
const RDF_REST = `${RDF_NS}rest`;
const RDF_NIL = `${RDF_NS}nil`;
const RDF_REIFIES = `${RDF_NS}reifies`;
const RDF_LANG_STRING = `${RDF_NS}langString`;
const RDF_DIR_LANG_STRING = `${RDF_NS}dirLangString`;
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const XSD_DOUBLE = 'http://www.w3.org/2001/XMLSchema#double';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

// ---- N-Triples / N-Quads parser ----
const { parseNQuads, termToNQuads, tripleToNQuads, triplesToNQuads } = (() => {

function isWs(ch) { return ch === ' ' || ch === '\t'; }
function isLineEnd(ch) { return ch === '\n' || ch === '\r'; }
function isHex(text) { return /^[0-9A-Fa-f]+$/.test(text); }

function decodeCodePoint(hex, token) {
  const code = Number.parseInt(hex, 16);
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    throw new Error(`Invalid Unicode escape in ${token}`);
  }
  return String.fromCodePoint(code);
}

function decodeIriEscapes(value, token = 'IRI') {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch !== '\\') {
      if (/[<>"{}|^`\u0000-\u0020]/.test(ch)) throw new Error(`Invalid character in ${token}`);
      out += ch;
      continue;
    }
    const esc = value[++i];
    if (esc === 'u') {
      const hex = value.slice(i + 1, i + 5);
      if (hex.length !== 4 || !isHex(hex)) throw new Error(`Invalid Unicode escape in ${token}`);
      out += decodeCodePoint(hex, token);
      i += 4;
    } else if (esc === 'U') {
      const hex = value.slice(i + 1, i + 9);
      if (hex.length !== 8 || !isHex(hex)) throw new Error(`Invalid Unicode escape in ${token}`);
      out += decodeCodePoint(hex, token);
      i += 8;
    } else {
      throw new Error(`Invalid IRI escape \\${esc} in ${token}`);
    }
  }
  return out;
}

function decodeLiteralEscapes(value, token = 'literal') {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch !== '\\') {
      if (ch === '\n' || ch === '\r') throw new Error(`Raw line break in ${token}`);
      out += ch;
      continue;
    }
    const esc = value[++i];
    if (!esc) throw new Error(`Trailing escape in ${token}`);
    if (esc === 't') out += '\t';
    else if (esc === 'b') out += '\b';
    else if (esc === 'n') out += '\n';
    else if (esc === 'r') out += '\r';
    else if (esc === 'f') out += '\f';
    else if (esc === '"') out += '"';
    else if (esc === "'") out += "'";
    else if (esc === '\\') out += '\\';
    else if (esc === 'u') {
      const hex = value.slice(i + 1, i + 5);
      if (hex.length !== 4 || !isHex(hex)) throw new Error(`Invalid Unicode escape in ${token}`);
      out += decodeCodePoint(hex, token);
      i += 4;
    } else if (esc === 'U') {
      const hex = value.slice(i + 1, i + 9);
      if (hex.length !== 8 || !isHex(hex)) throw new Error(`Invalid Unicode escape in ${token}`);
      out += decodeCodePoint(hex, token);
      i += 8;
    } else {
      throw new Error(`Invalid escape \\${esc} in ${token}`);
    }
  }
  return out;
}

function stripNqComment(line) {
  let inString = false;
  let inIri = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (!inIri && ch === '"') { inString = !inString; continue; }
    if (!inString && ch === '<' && line[i + 1] !== '<') { inIri = true; continue; }
    if (!inString && inIri && ch === '>') { inIri = false; continue; }
    if (!inString && !inIri && ch === '#') return line.slice(0, i);
  }
  return line;
}

function validateAbsoluteIri(value, position) {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) throw new Error(`${position} must be absolute`);
  return value;
}

function validateBlankLabel(value) {
  // RDF blank node labels follow PN_CHARS-style rules. This deliberately accepts
  // Unicode letters and leading underscores; it still rejects empty labels,
  // labels ending in '.', and doubled dots because those are common false
  // positives when a compact statement terminator is adjacent to a blank node.
  if (!value || value.endsWith('.') || value.includes('..')) throw new Error(`Invalid blank node label _: ${value}`);
  if (!/^[\p{L}\p{N}_](?:[\p{L}\p{N}._\-\u00B7\u0300-\u036F\u203F-\u2040]*[\p{L}\p{N}_\-\u00B7\u0300-\u036F\u203F-\u2040])?$/u.test(value)) {
    throw new Error(`Invalid blank node label _: ${value}`);
  }
  return value;
}

function validateLang(value) {
  // LANG_DIR uses BCP47-style language tags. Keep this intentionally strict enough
  // for the W3C syntax tests: each subtag is 1..8 alphanumeric chars, starting alpha.
  if (!value || value.includes('--') || !/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)) throw new Error(`Invalid language tag @${value}`);
  return value;
}

class LineReader {
  constructor(line, lineNumber) {
    this.line = line;
    this.lineNumber = lineNumber;
    this.i = 0;
  }

  eof() { return this.i >= this.line.length; }
  peek(offset = 0) { return this.line[this.i + offset]; }
  startsWith(value) { return this.line.startsWith(value, this.i); }
  skipWs() { while (isWs(this.peek())) this.i += 1; }

  expect(value) {
    if (!this.startsWith(value)) throw new Error(`Expected ${value} on line ${this.lineNumber}, got ${this.line.slice(this.i, this.i + 20) || 'end of line'}`);
    this.i += value.length;
  }

  readIri(position = 'IRI') {
    this.expect('<');
    let raw = '';
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === '>') { this.i += 1; return validateAbsoluteIri(decodeIriEscapes(raw, position), position); }
      raw += ch;
      this.i += 1;
    }
    throw new Error(`Unterminated ${position} on line ${this.lineNumber}`);
  }

  readBlank() {
    this.expect('_:');
    const start = this.i;
    while (!this.eof()) {
      const ch = this.peek();
      if (!/[\p{L}\p{N}._\-\u00B7\u0300-\u036F\u203F-\u2040]/u.test(ch)) break;
      if (ch === '.') {
        const next = this.peek(1);
        if (!next || isWs(next) || next === '<' || next === '_' || next === '"' || next === '#') break;
      }
      this.i += 1;
    }
    return blank(validateBlankLabel(this.line.slice(start, this.i)));
  }

  readLiteral() {
    this.expect('"');
    let raw = '';
    let escaped = false;
    while (!this.eof()) {
      const ch = this.peek();
      this.i += 1;
      if (escaped) { raw += `\\${ch}`; escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') {
        const value = decodeLiteralEscapes(raw, 'literal');
        let language = null;
        let datatype = XSD_STRING;
        if (this.peek() === '@') {
          this.i += 1;
          const start = this.i;
          while (!this.eof() && /[A-Za-z0-9-]/.test(this.peek())) this.i += 1;
          let rawLang = this.line.slice(start, this.i);
          if (!rawLang) throw new Error('Invalid language tag: missing');
          if (rawLang.endsWith('--ltr') || rawLang.endsWith('--rtl')) rawLang = rawLang.slice(0, -5);
          language = validateLang(rawLang);
          datatype = null;
        } else if (this.startsWith('^^')) {
          this.i += 2;
          this.skipWs();
          datatype = this.readIri('datatype IRI');
          if (datatype === RDF_LANG_STRING || datatype === RDF_DIR_LANG_STRING) {
            throw new Error(`Datatype ${datatype} requires LANG_DIR syntax, not ^^`);
          }
        }
        // RDF 1.2 base direction suffix, e.g. --ltr / --rtl. The core term model does not preserve it yet;
        // accepting it is enough for syntax tests and keeps eval comparison conservative for now.
        if (this.startsWith('--ltr') || this.startsWith('--rtl')) {
          if (!language) throw new Error('Base direction requires a language tag');
          this.i += 5;
        }
        return literal(value, datatype, language);
      }
      raw += ch;
    }
    throw new Error(`Unterminated literal on line ${this.lineNumber}`);
  }

  readTerm(position = 'term') {
    this.skipWs();
    if (this.startsWith('<<')) return this.readTripleTerm();
    if (this.peek() === '<') return iri(this.readIri(position));
    if (this.startsWith('_:')) return this.readBlank();
    if (this.peek() === '"') return this.readLiteral();
    throw new Error(`Expected RDF term for ${position}, got ${this.line.slice(this.i, this.i + 20) || 'end of line'}`);
  }

  readSubjectOrGraph(position) {
    const term = this.readTerm(position);
    if (term.kind === 'literal') throw new Error(`N-Quads ${position} cannot be a literal`);
    if (term.kind === 'triple' && (position === 'subject' || position === 'graph')) throw new Error(`N-Quads ${position} cannot be a triple term`);
    return term;
  }

  readPredicate() {
    this.skipWs();
    if (this.peek() !== '<') throw new Error(`N-Quads predicate must be an IRI, got ${this.line.slice(this.i, this.i + 20) || 'end of line'}`);
    return iri(this.readIri('predicate'));
  }

  readTripleTerm() {
    this.expect('<<');
    this.skipWs();
    // RDF 1.2 N-Triples/N-Quads triple terms use parenthesized triples: <<( s p o )>>.
    // The older unparenthesized RDF-star form is a reified-triple syntax form and is not
    // accepted as a plain subject/object term by the RDF 1.2 syntax manifests.
    this.expect('(');
    this.skipWs();
    const s = this.readSubjectOrGraph('triple-term subject');
    this.skipWs();
    const p = this.readPredicate();
    this.skipWs();
    const o = this.readTerm('triple-term object');
    this.skipWs();
    this.expect(')');
    this.skipWs();
    this.expect('>>');
    return tripleTerm(s, p, o);
  }
}

function parseLine(line, lineNumber, format) {
  const clean = stripNqComment(line).trim();
  if (!clean) return null;
  const r = new LineReader(clean, lineNumber);
  const s = r.readSubjectOrGraph('subject');
  r.skipWs();
  const p = r.readPredicate();
  r.skipWs();
  const o = r.readTerm('object');
  r.skipWs();
  let g = null;
  if (r.peek() !== '.') {
    if (format === 'ntriples') throw new Error(`N-Triples line ${lineNumber} has too many terms before .`);
    g = r.readSubjectOrGraph('graph');
    r.skipWs();
  }
  if (r.peek() !== '.') throw new Error(`N-Quads line ${lineNumber} must end with .`);
  r.i += 1;
  r.skipWs();
  if (!r.eof()) throw new Error(`Unexpected trailing content on N-Quads line ${lineNumber}: ${clean.slice(r.i)}`);
  return triple(s, p, o, g);
}

function parseNQuads(source, options = {}) {
  const facts = [];
  const prefixes = { ...(options.prefixes || {}) };
  const format = options.format || (options.profileId === 'ntriples-graph-v0' ? 'ntriples' : 'nquads');
  const lines = String(source || '').split(/\r\n|\n|\r/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const fact = parseLine(lines[lineIndex], lineIndex + 1, format);
    if (fact) facts.push(fact);
  }
  return {
    profile: options.profileId || (format === 'ntriples' ? 'ntriples-graph-v0' : 'nquads-dataset-v0'),
    prefixes,
    base: options.base || '',
    imports: [],
    facts,
    rules: [],
    queries: [],
    expectations: [],
  };
}

function escapeIri(value) {
  return String(value).replace(/[\\>\u0000-\u0020]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function escapeLiteral(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\u0008/g, '\\b')
    .replace(/\u000c/g, '\\f');
}

function termToNQuads(term) {
  if (!term) return '';
  switch (term.kind) {
    case 'iri':
      return `<${escapeIri(term.value)}>`;
    case 'blank':
      return `_:${term.value}`;
    case 'literal': {
      let out = `"${escapeLiteral(term.value)}"`;
      if (term.language) out += `@${term.language}`;
      else if (term.datatype && term.datatype !== XSD_STRING) out += `^^<${escapeIri(term.datatype)}>`;
      return out;
    }
    case 'triple':
      return `<< ${termToNQuads(term.s)} ${termToNQuads(term.p)} ${termToNQuads(term.o)} >>`;
    default:
      throw new Error(`Cannot serialize ${term.kind} as N-Quads`);
  }
}

function tripleToNQuads(value) {
  const terms = [termToNQuads(value.s), termToNQuads(value.p), termToNQuads(value.o)];
  if (value.graph) terms.push(termToNQuads(value.graph));
  return `${terms.join(' ')} .`;
}

function triplesToNQuads(triples) {
  return Array.from(new Set(Array.from(triples || []).map(tripleToNQuads))).sort().join('\n');
}
return { parseNQuads, termToNQuads, tripleToNQuads, triplesToNQuads };
})();

// ---- Turtle / TriG parser ----
const { parseN3 } = (() => {

const DEFAULT_PREFIXES = Object.freeze({
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  log: 'http://www.w3.org/2000/10/swap/log#',
});


function isWs(ch) { return /\s/.test(ch || ''); }
function isPunct(ch) { return '{}.;,()[]|'.includes(ch || ''); }
function isHex(text) { return /^[0-9A-Fa-f]+$/.test(text); }
function isAbsoluteIri(value) { return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value || ''); }
function resolveIriReference(value, base) {
  if (isAbsoluteIri(value)) return value;
  if (!base) return value;
  try {
    const url = new URL(value, base);
    let href = url.href;
    // The RDF IRI-resolution tests expect bare authority references such as //g
    // to remain http://g, not to gain the URL API's cosmetic trailing slash.
    if (/^\/\/[^/?#]+$/.test(value) && href.endsWith('/')) href = href.slice(0, -1);
    if (/^file:\/\/[^/?#]+$/.test(value) && href.endsWith('/')) href = href.slice(0, -1);
    return href;
  } catch { return `${base}${value}`; }
}
function validateBlankLabel(value) {
  const clean = String(value || '').replace(/^_:/, '');
  if (!clean || clean.endsWith('.') || clean.includes('..')) throw new Error(`Invalid blank node label _: ${clean}`);
  // BLANK_NODE_LABEL follows the PN_CHARS family; ':' is only for prefixed names, not blank labels.
  if (/[\s<>"{}|^`\\:]/u.test(clean)) throw new Error(`Invalid blank node label _: ${clean}`);
  if (/^[\-.]/u.test(clean)) throw new Error(`Invalid blank node label _: ${clean}`);
  return clean;
}
function validateIriReference(value) {
  if (/[<>\"{}|^`\u0000-\u0020]/.test(value)) throw new Error('Invalid character in IRIREF');
  return value;
}
function validatePrefixedLocal(raw, decoded) {
  if (!raw) return decoded;
  if (raw.startsWith('-') || raw.startsWith('\\-') || raw.startsWith('.')) throw new Error(`Invalid prefixed name local ${raw}`);
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\') {
      const esc = raw[i + 1];
      if (!esc || !'_~.-!$&\'()*+,;=/?#@%'.includes(esc)) throw new Error(`Invalid prefixed name local escape ${raw}`);
      i += 1;
      continue;
    }
    if (ch === '%') {
      const hex = raw.slice(i + 1, i + 3);
      if (hex.length !== 2 || !isHex(hex)) throw new Error(`Invalid percent escape in prefixed name local ${raw}`);
      i += 2;
      continue;
    }
    if (ch === '~' || ch === '^') throw new Error(`Invalid prefixed name local ${raw}`);
  }
  return decoded;
}
function decodePrefixedLocal(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\') { out += raw[i + 1] || ''; i += 1; }
    else out += ch;
  }
  return out;
}
function codePoint(hex, label) {
  const n = Number.parseInt(hex, 16);
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error(`Invalid Unicode escape in ${label}`);
  return String.fromCodePoint(n);
}
function decodeEscapes(text, label, iriMode = false) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '\\') { out += ch; continue; }
    const esc = text[++i];
    if (!esc) throw new Error(`Trailing escape in ${label}`);
    if (esc === 'u') {
      const hex = text.slice(i + 1, i + 5); if (hex.length !== 4 || !isHex(hex)) throw new Error(`Invalid Unicode escape in ${label}`);
      out += codePoint(hex, label); i += 4;
    } else if (esc === 'U') {
      const hex = text.slice(i + 1, i + 9); if (hex.length !== 8 || !isHex(hex)) throw new Error(`Invalid Unicode escape in ${label}`);
      out += codePoint(hex, label); i += 8;
    } else if (!iriMode && 'tbnrf"\''.includes(esc)) {
      out += { t: '\t', b: '\b', n: '\n', r: '\r', f: '\f', '"': '"', "'": "'" }[esc] ?? esc;
    } else if (!iriMode && esc === '\\') out += '\\';
    else if (iriMode) throw new Error(`Invalid escape \\${esc} in ${label}`);
    else throw new Error(`Invalid escape \\${esc} in ${label}`);
  }
  return out;
}

class Tokenizer {
  constructor(source) { this.source = String(source || ''); this.i = 0; this.tokens = []; }
  eof() { return this.i >= this.source.length; }
  peek(offset = 0) { return this.source[this.i + offset]; }
  startsWith(value) { return this.source.startsWith(value, this.i); }
  push(type, value, extra = {}) { this.tokens.push({ type, value, ...extra }); }
  skipComment() { while (!this.eof() && this.peek() !== '\n' && this.peek() !== '\r') this.i += 1; }
  readIri() {
    this.i += 1;
    let raw = '';
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === '>') { this.i += 1; this.push('iri', validateIriReference(decodeEscapes(raw, 'IRI', true))); return; }
      raw += ch; this.i += 1;
    }
    throw new Error('Unterminated IRIREF');
  }
  readString() {
    const quote = this.peek();
    const long = this.source.startsWith(quote.repeat(3), this.i);
    this.i += long ? 3 : 1;
    let raw = '';
    let escaped = false;
    while (!this.eof()) {
      const ch = this.peek();
      if (!escaped && long && this.source.startsWith(quote.repeat(3), this.i)) { this.i += 3; this.push(long ? 'longString' : 'string', decodeEscapes(raw, 'string'), { long }); return; }
      if (!escaped && !long && ch === quote) { this.i += 1; this.push('string', decodeEscapes(raw, 'string'), { long: false }); return; }
      if (!long && (ch === '\n' || ch === '\r')) throw new Error('Raw line break in short string');
      raw += ch;
      this.i += 1;
      escaped = !escaped && ch === '\\';
      if (ch !== '\\') escaped = false;
    }
    throw new Error('Unterminated string');
  }
  readBare() {
    const start = this.i;
    if (this.startsWith('_:')) {
      this.i += 2;
      while (!this.eof()) {
        const ch = this.peek();
        // BLANK_NODE_LABEL uses PN_CHARS, including broad Unicode ranges that are
        // not all JavaScript \p{L}/\p{N}.  Tokenize generously up to a real
        // Turtle delimiter, then validate the label separately.  Keep ':' as a
        // boundary so compact forms such as _:s:p tokenize as blank-node _:s
        // followed by predicate :p.
        if (isWs(ch) || '<>\"{}|^`\\;,)[]'.includes(ch) || ch === ':' || ch === '#') break;
        if (ch === '.') {
          const next = this.source[this.i + 1];
          if (!next || isWs(next) || '{};,)[]'.includes(next)) break;
        }
        this.i += 1;
      }
      this.push('bare', this.source.slice(start, this.i));
      return;
    }
    while (!this.eof()) {
      const ch = this.peek();
      if (isWs(ch)) break;
      if (ch === '\\' && this.source[this.i + 1]) { this.i += 2; continue; }
      if (ch === '<' || ch === '>' || ch === '"' || ch === "'") break;
      if (ch === '.') {
        const next = this.source[this.i + 1];
        if (!next || isWs(next) || '{};,)[]'.includes(next)) break;
      } else if (isPunct(ch)) break;
      if (ch === '#') break;
      if (ch === '^' && this.peek(1) === '^') break;
      if (ch === '=' && this.peek(1) === '>') break;
      this.i += 1;
    }
    this.push('bare', this.source.slice(start, this.i));
  }
  tokenize() {
    while (!this.eof()) {
      const ch = this.peek();
      if (isWs(ch)) { this.i += 1; continue; }
      if (ch === '#') { this.skipComment(); continue; }
      if (this.startsWith('@prefix') && (isWs(this.source[this.i + 7]) || this.source[this.i + 7] === ':')) { this.push('bare', '@prefix'); this.i += 7; continue; }
      if (this.startsWith('@base') && isWs(this.source[this.i + 5])) { this.push('bare', '@base'); this.i += 5; continue; }
      if (this.startsWith('@version') && isWs(this.source[this.i + 8])) { this.push('bare', '@version'); this.i += 8; continue; }
      if (this.startsWith('=>')) { this.push('=>', '=>'); this.i += 2; continue; }
      if (this.startsWith('^^')) { this.push('^^', '^^'); this.i += 2; continue; }
      if (this.startsWith('<<')) { this.push('<<', '<<'); this.i += 2; continue; }
      if (this.startsWith('>>')) { this.push('>>', '>>'); this.i += 2; continue; }
      if (ch === '<') { this.readIri(); continue; }
      if (ch === '"' || ch === "'") { this.readString(); continue; }
      if (ch === '.' && /[0-9]/.test(this.peek(1) || '')) { this.readBare(); continue; }
      if (ch === '~') { this.readBare(); continue; }
      if (isPunct(ch)) { this.push(ch, ch); this.i += 1; continue; }
      this.readBare();
    }
    return this.tokens;
  }
}

function parseN3(source, options = {}) {
  const tokens = new Tokenizer(source).tokenize();
  let i = 0;
  let base = options.base || '';
  const prefixes = { ...DEFAULT_PREFIXES, ...(options.prefixes || {}) };
  const facts = [];
  const rules = [];
  let bnodeCounter = 0;
  const bnodes = new Map();
  const syntaxProfile = String(options.profile || options.profileId || '').toLowerCase();
  const rdf12Surface = syntaxProfile === 'turtle' || syntaxProfile === 'trig';
  const implicitStatementNodes = new Set();

  function freshBlank() { bnodeCounter += 1; return blank(`b${bnodeCounter}`); }
  function peek(offset = 0) { return tokens[i + offset]; }
  function next() { return tokens[i++]; }
  function eof() { return i >= tokens.length; }
  function accept(value) { if (peek()?.value === value || peek()?.type === value) { i += 1; return true; } return false; }
  function expect(value) { const t = next(); if (!t || (t.value !== value && t.type !== value)) throw new Error(`Expected ${value}, got ${t?.value || 'end of input'}`); return t; }
  function error(msg) { throw new Error(msg); }

  function parseIriValueFromBare(token) {
    if (token === 'a') return RDF_TYPE;
    if (token.startsWith('_:')) error(`Blank node label ${token} cannot be used as IRI`);
    const split = token.indexOf(':');
    if (split >= 0) {
      const prefix = token.slice(0, split);
      let local = token.slice(split + 1);
      if (!(prefix in prefixes)) throw new Error(`Unknown prefix ${prefix}:`);
      // Turtle permits reserved escaped characters in local names.
      local = validatePrefixedLocal(local, decodePrefixedLocal(local));
      return prefixes[prefix] + local;
    }
    throw new Error(`Expected IRI or prefixed name, got ${token}`);
  }

  function parseIriLike() {
    const t = next();
    if (!t) error('Unexpected end of input while reading IRI');
    if (t.type === 'iri') return resolveIriReference(t.value, base);
    if (t.type === 'bare') return parseIriValueFromBare(t.value);
    throw new Error(`Expected IRI or prefixed name, got ${t.value}`);
  }

  function parseBlankLabel(label) {
    const key = validateBlankLabel(label);
    if (!bnodes.has(key)) bnodes.set(key, blank(key));
    return bnodes.get(key);
  }

  function parseNumber(token) {
    if (/^[+-]?\d+$/.test(token)) return literal(token, XSD_INTEGER);
    if (/^[+-]?(?:\d+\.\d*|\.\d+)$/.test(token)) return literal(token, XSD_DECIMAL);
    if (/^[+-]?(?:(?:\d+\.\d*)|(?:\.\d+)|\d+)[eE][+-]?\d+$/.test(token)) return literal(token, XSD_DOUBLE);
    return null;
  }

  function parseTerm(out = facts, graph = null, options2 = {}) {
    const t = peek();
    if (!t) error('Unexpected end of input while reading Turtle term');
    if (t.type === '<<') return parseTripleTerm(out, graph, options2);
    if (t.type === 'iri') { next(); return iri(resolveIriReference(t.value, base)); }
    if (t.type === 'string' || t.type === 'longString') {
      if (options2.noLiteral) throw new Error('Literal is not allowed here');
      return parseLiteral();
    }
    if (t.type === '[') {
      // ANON is a BlankNode and is permitted in rtSubject/ttSubject, even where
      // blankNodePropertyList is not. Keep [ ... ] rejected in those positions.
      if (options2.noCompound) {
        if (peek(1)?.type === ']') { expect('['); expect(']'); return freshBlank(); }
        throw new Error('Compound blank node expression is not allowed here');
      }
      return parseBlankNodePropertyList(out, graph);
    }
    if (t.type === '(') {
      if (options2.noCompound) throw new Error('Collection is not allowed here');
      return parseCollection(out, graph);
    }
    if (t.type === 'bare') {
      next();
      if (t.value.startsWith('?')) {
        if (rdf12Surface) throw new Error(`Variables are not allowed in Turtle/TriG: ${t.value}`);
        return variable(t.value.slice(1));
      }
      if (t.value.startsWith('_:')) return parseBlankLabel(t.value);
      if (t.value === 'a' && options2.noA) throw new Error('a is only allowed as a predicate');
      if (t.value === 'true' || t.value === 'false') {
        if (options2.noLiteral) throw new Error('Literal is not allowed here');
        return literal(t.value, XSD_BOOLEAN);
      }
      const num = parseNumber(t.value);
      if (num) {
        if (options2.noLiteral) throw new Error('Literal is not allowed here');
        return num;
      }
      return iri(parseIriValueFromBare(t.value));
    }
    throw new Error(`Expected IRI or prefixed name, got ${t.value}`);
  }

  function parseLiteral() {
    const t = next(); if (!t || (t.type !== 'string' && t.type !== 'longString')) throw new Error(`Expected string, got ${t?.value || 'end of input'}`);
    if (peek()?.type === 'bare' && peek().value.startsWith('@')) {
      let lang = next().value.slice(1);
      let langDir = null;
      if (lang.endsWith('--ltr') || lang.endsWith('--rtl')) {
        langDir = lang.slice(-3);
        lang = lang.slice(0, -5);
      }
      if (!lang || lang.includes('--') || !/^[A-Za-z]+(?:-[A-Za-z0-9]+)*$/.test(lang)) throw new Error(`Invalid language tag @${lang}`);
      if (peek()?.type === 'bare' && ['--ltr', '--rtl'].includes(peek().value)) langDir = next().value.slice(2);
      return literal(t.value, null, lang, langDir);
    }
    if (accept('^^')) return literal(t.value, parseIriLike());
    if (peek()?.type === 'bare' && ['--ltr', '--rtl'].includes(peek().value)) throw new Error('Base direction requires a language tag');
    return literal(t.value, XSD_STRING);
  }

  function parseReifierToken(out, graph) {
    const t = peek();
    if (!t || t.type !== 'bare' || !t.value.startsWith('~')) return null;
    next();
    const suffix = t.value.slice(1);
    if (suffix) {
      if (suffix.startsWith('_:')) return parseBlankLabel(suffix);
      return iri(parseIriValueFromBare(suffix));
    }
    const n = peek();
    if (n && (n.type === 'iri' || (n.type === 'bare' && (n.value.startsWith('_:') || n.value.includes(':') || n.value === 'a')))) {
      const term = parseTerm(out, graph, { noLiteral: true, noCompound: true, noTripleTerm: true });
      if (term.kind !== 'iri' && term.kind !== 'blank') throw new Error('Reifier must be an IRI or blank node');
      return term;
    }
    return freshBlank();
  }

  function parseTripleTerm(out, graph, options2 = {}) {
    expect('<<');
    const parenthesized = accept('(');
    if (parenthesized) {
      if (options2.noTripleTerm) throw new Error('Triple term is not allowed here');
      const s = parseTerm(out, graph, { noLiteral: true, noCompound: true, noReifiedTriple: true });
      if (s.kind === 'triple') throw new Error('Triple term subject cannot be a triple term');
      const p = iri(parseIriLike());
      const o = parseTerm(out, graph, { noCompound: true, noReifiedTriple: true });
      if (o.kind !== 'iri' && o.kind !== 'blank' && o.kind !== 'literal' && o.kind !== 'triple') throw new Error('Invalid triple term object');
      expect(')');
      expect('>>');
      return tripleTerm(s, p, o);
    }
    if (options2.noReifiedTriple) throw new Error('Reified triple is not allowed here');
    const s = parseTerm(out, graph, { noLiteral: true, noCompound: true, noTripleTerm: true });
    if (s.kind !== 'iri' && s.kind !== 'blank') throw new Error('Invalid reified triple subject');
    const p = iri(parseIriLike());
    const o = parseTerm(out, graph, { noCompound: true });
    if (o.kind !== 'iri' && o.kind !== 'blank' && o.kind !== 'literal' && o.kind !== 'triple') throw new Error('Invalid reified triple object');
    let reifier = null;
    if (peek()?.type === 'bare' && peek().value.startsWith('~')) reifier = parseReifierToken(out, graph);
    expect('>>');
    const node = reifier || freshBlank();
    out.push(triple(node, iri(RDF_REIFIES), tripleTerm(s, p, o), graph));
    if (node.kind === 'blank') implicitStatementNodes.add(node.value);
    return node;
  }

  function parseCollection(out, graph) {
    expect('(');
    if (accept(')')) return iri(RDF_NIL);
    const head = freshBlank();
    let current = head;
    while (true) {
      const item = parseTerm(out, graph);
      out.push(triple(current, iri(RDF_FIRST), item, graph));
      if (accept(')')) {
        out.push(triple(current, iri(RDF_REST), iri(RDF_NIL), graph));
        break;
      }
      const rest = freshBlank();
      out.push(triple(current, iri(RDF_REST), rest, graph));
      current = rest;
    }
    return head;
  }

  function parseBlankNodePropertyList(out, graph) {
    expect('[');
    const node = freshBlank();
    if (accept(']')) return node;
    parsePredicateObjectList(node, out, graph);
    expect(']');
    if (node.kind === 'blank') implicitStatementNodes.add(node.value);
    return node;
  }

  function parseAnnotationBlock(reifier, out, graph = null) {
    expect('{');
    expect('|');
    if (peek()?.type === '|') {
      // Empty annotation blocks are rejected by the RDF 1.2 syntax tests.
      throw new Error('Empty annotation block');
    }
    parsePredicateObjectList(reifier, out, graph);
    expect('|');
    expect('}');
  }

  function ensureReifierForTriple(assertedTriple, out, graph = null) {
    const reifier = freshBlank();
    out.push(triple(reifier, iri(RDF_REIFIES), tripleTerm(assertedTriple.s, assertedTriple.p, assertedTriple.o), graph));
    return reifier;
  }

  function parseObjectList(subject, predicate, out, graph = null) {
    while (true) {
      const object = parseTerm(out, graph, { noA: true });
      const asserted = triple(subject, predicate, object, graph);
      out.push(asserted);
      let pendingReifier = null;
      while (true) {
        if (peek()?.type === 'bare' && peek().value.startsWith('~')) {
          pendingReifier = parseReifierToken(out, graph);
          out.push(triple(pendingReifier, iri(RDF_REIFIES), tripleTerm(asserted.s, asserted.p, asserted.o), graph));
          continue;
        }
        if (peek()?.type === '{' && peek(1)?.type === '|') {
          const blockReifier = pendingReifier || ensureReifierForTriple(asserted, out, graph);
          parseAnnotationBlock(blockReifier, out, graph);
          pendingReifier = null;
          continue;
        }
        break;
      }
      if (!accept(',')) break;
    }
  }

  function parsePredicateObjectList(subject, out, graph = null) {
    while (true) {
      const predicate = iri(parseIriLike());
      parseObjectList(subject, predicate, out, graph);
      if (!accept(';')) break;
      while (accept(';')) {}
      if ([']', '.', '}', '|'].includes(peek()?.type)) break;
    }
  }

  function parseGraphLabel(out, inheritedGraph = null) {
    if (peek()?.type === '[' && peek(1)?.type === ']') { expect('['); expect(']'); return freshBlank(); }
    if (peek()?.type === '(') throw new Error('GRAPH name must be an IRI or blank node');
    const graph = parseTerm(out, inheritedGraph, { noLiteral: true, noCompound: true, noTripleTerm: true, noReifiedTriple: true, noA: true });
    if (graph.kind !== 'iri' && graph.kind !== 'blank') throw new Error('GRAPH name must be an IRI or blank node');
    return graph;
  }

  function parseGraphBlock(out, inheritedGraph = null) {
    expect('GRAPH');
    const graph = parseGraphLabel(out, inheritedGraph);
    parseFormula(graph, out);
  }

  function parseTripleStatement(out, graph = null, options3 = {}) {
    if (String(peek()?.value || '').toUpperCase() === 'GRAPH') {
      if (syntaxProfile === 'turtle') throw new Error('GRAPH blocks are not Turtle');
      if (graph) throw new Error('GRAPH blocks cannot be nested inside a graph block');
      parseGraphBlock(out, graph);
      if (options3.requireDot) expect('.'); else accept('.');
      return;
    }
    if (peek()?.type === '<<' && peek(1)?.type === '(') throw new Error('Triple term cannot be used as a subject');
    const subject = parseTerm(out, graph, { noLiteral: true, noA: true });
    if ((peek()?.type === '.' || peek()?.type === '}' || peek()?.type === undefined) && subject.kind === 'blank' && implicitStatementNodes.has(subject.value)) {
      if (options3.requireDot) expect('.'); else accept('.');
      return;
    }
    parsePredicateObjectList(subject, out, graph);
    if (options3.requireDot) expect('.'); else accept('.');
  }

  function parseFormula(graph = null, target = null) {
    expect('{');
    const triples = target || [];
    while (peek()?.type !== '}') parseTripleStatement(triples, graph);
    expect('}');
    return triples;
  }

  function parseBase() {
    const directive = next();
    const iriToken = next();
    if (iriToken?.type !== 'iri') throw new Error(`Expected base IRI, got ${iriToken?.value}`);
    base = resolveIriReference(iriToken.value, base);
    if (String(directive.value || '').startsWith('@')) expect('.');
  }

  function parsePrefix() {
    const directive = next();
    const label = next();
    if (label?.type !== 'bare' || !label.value.endsWith(':')) throw new Error(`Expected prefix label ending with :, got ${label?.value}`);
    const prefixLabel = label.value.slice(0, -1);
    if (prefixLabel.endsWith('.') || prefixLabel.includes('..')) throw new Error(`Invalid prefix label ${prefixLabel}`);
    const iriToken = next();
    if (iriToken?.type !== 'iri') throw new Error(`Expected prefix IRI, got ${iriToken?.value}`);
    prefixes[prefixLabel] = resolveIriReference(iriToken.value, base);
    if (String(directive.value || '').startsWith('@')) expect('.');
  }

  function isSimpleGraphLabelStart(t) {
    return t && (t.type === 'iri' || (t.type === 'bare' && (t.value.startsWith('_:') || t.value.includes(':'))));
  }

  while (!eof()) {
    const token = peek();
    const lowerValue = String(token.value || '').toLowerCase();
    if (token.value === '@base' || (!String(token.value || '').startsWith('@') && lowerValue === 'base')) parseBase();
    else if (token.value === '@prefix' || (!String(token.value || '').startsWith('@') && lowerValue === 'prefix')) parsePrefix();
    else if ((!String(token.value || '').startsWith('@') && String(token.value || '').toUpperCase() === 'VERSION') || token.value === '@version') {
      const directive = next();
      const v = next();
      if (!v || v.type !== 'string') throw new Error('VERSION requires a short quoted string');
      if (String(directive.value || '').startsWith('@')) expect('.');
    }
    else if (token.type === '{') {
      if (syntaxProfile === 'turtle') throw new Error('Turtle does not allow top-level graph/formula blocks');
      const body = parseFormula();
      if (accept('=>')) {
        const head = parseFormula();
        accept('.');
        rules.push(new Rule({ id: `n3${rules.length + 1}`, body, head, profile: 'n3-rules-subset-v0' }));
      } else {
        facts.push(...body);
        accept('.');
      }
    } else if (String(token.value || '').toUpperCase() === 'GRAPH') {
      parseGraphBlock(facts);
      if (accept('.')) throw new Error('GRAPH block must not be followed by .');
    } else if (token.type === '[' && peek(1)?.type === ']' && peek(2)?.type === '{') {
      if (syntaxProfile === 'turtle') throw new Error('Turtle does not allow graph labels');
      const graph = parseGraphLabel(facts, null);
      parseFormula(graph, facts);
      accept('.');
    } else if (isSimpleGraphLabelStart(token) && peek(1)?.type === '{') {
      if (syntaxProfile === 'turtle') throw new Error('Turtle does not allow graph labels');
      const graph = parseGraphLabel(facts, null);
      parseFormula(graph, facts);
      accept('.');
    } else {
      parseTripleStatement(facts, null, { requireDot: syntaxProfile === 'turtle' });
    }
  }

  return { profile: 'n3-rules-subset-v0', prefixes, base, facts, rules };
}
return { parseN3 };
})();


return {
  parseNQuads,
  termToNQuads,
  tripleToNQuads,
  triplesToNQuads,
  parseN3,
};
})();

Object.assign(module.exports, rdfW3cSyntax);
