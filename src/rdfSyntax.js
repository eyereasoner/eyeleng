'use strict';

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
  XSD_STRING,
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

const CONTENT_TYPES = Object.freeze({
  turtle: 'text/turtle',
  trig: 'application/trig',
  ntriples: 'application/n-triples',
  nquads: 'application/n-quads',
  n3: 'text/n3',
  jsonld: 'application/ld+json',
  rdfxml: 'application/rdf+xml',
  shaclc: 'text/shaclc',
});

async function parseRdfDocument(source, options = {}) {
  const { Readable } = require('readable-stream');
  const { rdfParser } = require('rdf-parse');
  const { default: dataFactory } = await import('@rdfjs/data-model');
  const prefixes = { ...(options.prefixes || {}) };
  const parseOptions = rdfParseOptions(options);
  parseOptions.dataFactory = dataFactory;
  const prepared = prepareRdf12TripleTerms(String(source ?? ''));
  const stream = rdfParser.parse(Readable.from([prepared.source]), parseOptions);
  stream.on('prefix', (prefix, value) => {
    prefixes[String(prefix)] = value && value.value ? value.value : String(value);
  });

  let quads = [];
  for await (const quad of stream) quads.push(quad);
  quads = restoreRdf12TripleTerms(quads, prepared.markerPrefix, dataFactory);

  const triples = quads.map((quad) => {
    const triple = {
      s: rdfJsTermToTerm(quad.subject),
      p: rdfJsTermToTerm(quad.predicate),
      o: rdfJsTermToTerm(quad.object),
    };
    if (quad.graph && quad.graph.termType !== 'DefaultGraph') triple.graph = rdfJsTermToTerm(quad.graph);
    return triple;
  });
  const imports = triples
    .filter((triple) => triple.p.type === 'iri' && triple.p.value === OWL_IMPORTS && triple.o.type === 'iri')
    .map((triple) => triple.o.value);

  return {
    baseIRI: options.baseIRI || options.base || null,
    prefixes,
    triples,
    quads,
    imports: Array.from(new Set(imports)),
  };
}

async function parseRdfDataset(source, options = {}) {
  const document = await parseRdfDocument(source, options);
  return {
    profile: options.profileId || options.profile || 'rdfjs-dataset-v0',
    prefixes: document.prefixes,
    base: document.baseIRI || '',
    imports: document.imports,
    facts: document.quads.map((quad) => ({
      s: rdfJsTermToLegacy(quad.subject),
      p: rdfJsTermToLegacy(quad.predicate),
      o: rdfJsTermToLegacy(quad.object),
      graph: quad.graph && quad.graph.termType !== 'DefaultGraph' ? rdfJsTermToLegacy(quad.graph) : null,
    })),
    rules: [],
    queries: [],
    expectations: [],
  };
}

async function parseRdfSyntax(source, options = {}) {
  return rdfDocumentToProgram(await parseRdfDocument(source, options), options);
}

function rdfParseOptions(options = {}) {
  const out = {};
  const contentType = options.contentType || CONTENT_TYPES[options.profile] || CONTENT_TYPES[options.format];
  if (contentType) out.contentType = contentType;
  else if (options.filename && !/^<.*>$/.test(options.filename)) {
    const cleanFilename = String(options.filename).replace(/[?#].*$/, '');
    if (/\.[A-Za-z0-9]+$/.test(cleanFilename)) out.path = cleanFilename;
    else out.contentType = 'text/turtle';
  }
  else out.contentType = 'text/turtle';
  if (options.baseIRI || options.base) out.baseIRI = options.baseIRI || options.base;
  if (options.version) out.version = options.version;
  if (options.parseUnsupportedVersions) out.parseUnsupportedVersions = true;
  return out;
}

// N3.js 2.2 parses RDF 1.2 triple terms in ordinary object position, but not
// as RDF collection items. Give each triple term a private reifier while
// parsing, then replace that reifier with the RDF/JS Quad term afterwards.
function prepareRdf12TripleTerms(source) {
  let markerPrefix = 'urn:eyeleng:rdf12-triple-term:';
  while (source.includes(markerPrefix)) markerPrefix += 'x:';
  const contexts = [];
  let count = 0;
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const long = source.startsWith(quote.repeat(3), i);
      const start = i;
      i += long ? 3 : 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (long ? source.startsWith(quote.repeat(3), i) : source[i] === quote) {
          i += long ? 3 : 1;
          break;
        }
        i += 1;
      }
      out += source.slice(start, i);
      continue;
    }
    if (ch === '<' && !source.startsWith('<<', i)) {
      const start = i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === '>') break;
      }
      out += source.slice(start, i);
      continue;
    }
    if (ch === '#') {
      const start = i++;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i += 1;
      out += source.slice(start, i);
      continue;
    }
    if (source.startsWith('<<(', i)) {
      if (contexts.some((context) => context.type === 'collection')) {
        const marker = `${markerPrefix}${++count}`;
        contexts.push({ type: 'preparedTriple', marker });
        out += '<< ';
      } else {
        contexts.push({ type: 'triple' });
        out += '<<(';
      }
      i += 3;
      continue;
    }
    if (source.startsWith(')>>', i) && contexts.length > 0
      && (contexts.at(-1).type === 'triple' || contexts.at(-1).type === 'preparedTriple')) {
      const context = contexts.pop();
      out += context.type === 'preparedTriple' ? ` ~ <${context.marker}> >>` : ')>>';
      i += 3;
      continue;
    }
    if (ch === '(') contexts.push({ type: 'collection' });
    else if (ch === ')' && contexts.at(-1)?.type === 'collection') contexts.pop();
    out += ch;
    i += 1;
  }
  if (contexts.some((context) => context.type !== 'collection')) return { source, markerPrefix: null };
  return { source: out, markerPrefix: count > 0 ? markerPrefix : null };
}

function restoreRdf12TripleTerms(quads, markerPrefix, dataFactory) {
  if (!markerPrefix) return quads;
  const replacements = new Map();
  for (const quad of quads) {
    if (quad.subject.termType === 'NamedNode' && quad.subject.value.startsWith(markerPrefix)
      && quad.predicate.termType === 'NamedNode' && quad.predicate.value === `${RDF_NS}reifies`
      && quad.object.termType === 'Quad') {
      replacements.set(quad.subject.value, quad.object);
    }
  }
  const replace = (term, seen = new Set()) => {
    if (term.termType === 'NamedNode' && replacements.has(term.value)) {
      if (seen.has(term.value)) throw new Error('Cyclic RDF 1.2 triple term');
      const nextSeen = new Set(seen).add(term.value);
      return replace(replacements.get(term.value), nextSeen);
    }
    if (term.termType !== 'Quad') return term;
    return dataFactory.quad(
      replace(term.subject, seen),
      replace(term.predicate, seen),
      replace(term.object, seen),
      replace(term.graph, seen),
    );
  };
  return quads
    .filter((quad) => !(quad.subject.termType === 'NamedNode' && replacements.has(quad.subject.value)
      && quad.predicate.termType === 'NamedNode' && quad.predicate.value === `${RDF_NS}reifies`))
    .map((quad) => dataFactory.quad(
      replace(quad.subject),
      replace(quad.predicate),
      replace(quad.object),
      replace(quad.graph),
    ));
}

function rdfJsTermToTerm(term) {
  if (!term) return null;
  if (term.termType === 'NamedNode') return iri(term.value);
  if (term.termType === 'BlankNode') return blankNode(term.value);
  if (term.termType === 'Variable') return variable(term.value);
  if (term.termType === 'Literal') {
    const datatype = term.datatype && term.datatype.value ? term.datatype.value : null;
    const lang = term.language || null;
    const direction = term.direction || null;
    const value = coerceLexicalLiteral(term.value, datatype);
    return literal(value, datatype === XSD_STRING ? null : datatype, lang, direction);
  }
  if (term.termType === 'Quad') return tripleTerm(rdfJsTermToTerm(term.subject), rdfJsTermToTerm(term.predicate), rdfJsTermToTerm(term.object));
  if (term.termType === 'DefaultGraph') return null;
  throw new Error(`Unsupported RDF/JS term type ${term.termType || typeof term}`);
}

function rdfJsTermToLegacy(term) {
  if (!term || term.termType === 'DefaultGraph') return null;
  if (term.termType === 'NamedNode') return { kind: 'iri', value: term.value };
  if (term.termType === 'BlankNode') return { kind: 'blank', value: term.value };
  if (term.termType === 'Variable') return { kind: 'var', value: term.value, name: term.value };
  if (term.termType === 'Literal') return {
    kind: 'literal',
    value: term.value,
    datatype: term.datatype && term.datatype.value ? term.datatype.value : null,
    language: term.language || null,
    langDir: term.direction || null,
  };
  if (term.termType === 'Quad') return {
    kind: 'triple',
    s: rdfJsTermToLegacy(term.subject),
    p: rdfJsTermToLegacy(term.predicate),
    o: rdfJsTermToLegacy(term.object),
  };
  throw new Error(`Unsupported RDF/JS term type ${term.termType || typeof term}`);
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


function looksLikeRdfRules(source, options = {}) {
  if (options.syntax === 'rdf') return true;
  if (options.syntax === 'srl') return false;
  if (options.filename && /\.(ttl|turtle|trig|nt|ntriples|nq|nquads|n3|rdf|rdfxml|owl|json|jsonld|html|htm|xhtml|xml|svg|shaclc|shc)$/i.test(options.filename)) return true;
  return /\bsrl:RuleSet\b|\bsrl:rules\b|http:\/\/www\.w3\.org\/ns\/shacl-rules#RuleSet/.test(source);
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
    .replace(/\t/g, '\\t');
}

function termToNQuads(term) {
  if (!term) return '';
  if (term.kind === 'iri') return `<${escapeIri(term.value)}>`;
  if (term.kind === 'blank') return `_:${term.value}`;
  if (term.kind === 'literal') {
    let out = `"${escapeLiteral(term.value)}"`;
    if (term.language) out += `@${term.language}${term.langDir ? `--${term.langDir}` : ''}`;
    else if (term.datatype) out += `^^<${escapeIri(term.datatype)}>`;
    return out;
  }
  if (term.kind === 'triple') return `<<(${termToNQuads(term.s)} ${termToNQuads(term.p)} ${termToNQuads(term.o)})>>`;
  throw new Error(`Cannot serialize RDF term ${JSON.stringify(term)}`);
}

function tripleToNQuads(triple) {
  return `${termToNQuads(triple.s)} ${termToNQuads(triple.p)} ${termToNQuads(triple.o)}${triple.graph ? ` ${termToNQuads(triple.graph)}` : ''} .`;
}

function triplesToNQuads(triples) {
  return (triples || []).map(tripleToNQuads).sort().join('\n');
}

module.exports = {
  parseRdfDocument,
  parseRdfDataset,
  parseRdfSyntax,
  rdfDocumentToProgram,
  looksLikeRdfRules,
  rdfJsTermToTerm,
  rdfJsTermToLegacy,
  termToNQuads,
  tripleToNQuads,
  triplesToNQuads,
  RdfGraph,
  constants: {
    SRL_NS,
    SHNEX_NS,
    SPARQL_NS,
    SRL_RULE_SET,
    SRL_RULE,
  },
};
