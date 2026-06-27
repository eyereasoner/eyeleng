'use strict';

// Small RDF/RDFS entailment support used by the W3C RDF-MT / RDF 1.2
// Semantics manifest runner.  It intentionally operates on the grammar-hardened
// W3C RDF graph representation from rdfSyntax.js ({kind: ...} terms), not on
// the SRL rule-engine term representation.

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const RDF_TYPE = `${RDF}type`;
const RDF_PROPERTY = `${RDF}Property`;
const RDF_XML_LITERAL = `${RDF}XMLLiteral`;
const RDF_HTML = `${RDF}HTML`;
const RDF_LANG_STRING = `${RDF}langString`;
const RDF_DIR_LANG_STRING = `${RDF}dirLangString`;
const RDF_JSON = `${RDF}JSON`;
const RDF_REIFIES = `${RDF}reifies`;
const RDFS_PROPOSITION = `${RDFS}Proposition`;
const RDF_PROPOSITION = `${RDF}Proposition`; // legacy/non-standard alias kept for compatibility with older local regressions
const RDF_TRIPLE_TERM = `${RDF}TripleTerm`; // legacy/internal helper; RDF 1.2 RDFS range uses rdfs:Proposition
const RDFS_RESOURCE = `${RDFS}Resource`;
const RDFS_CLASS = `${RDFS}Class`;
const RDFS_LITERAL = `${RDFS}Literal`;
const RDFS_DATATYPE = `${RDFS}Datatype`;
const RDFS_SUBCLASS_OF = `${RDFS}subClassOf`;
const RDFS_SUBPROPERTY_OF = `${RDFS}subPropertyOf`;
const RDFS_DOMAIN = `${RDFS}domain`;
const RDFS_RANGE = `${RDFS}range`;
const RDFS_CONTAINER_MEMBERSHIP_PROPERTY = `${RDFS}ContainerMembershipProperty`;
const RDFS_MEMBER = `${RDFS}member`;
const XSD_STRING = `${XSD}string`;
const XSD_BOOLEAN = `${XSD}boolean`;
const XSD_INTEGER = `${XSD}integer`;
const XSD_INT = `${XSD}int`;
const XSD_DECIMAL = `${XSD}decimal`;
const XSD_FLOAT = `${XSD}float`;
const XSD_DOUBLE = `${XSD}double`;

function iri(value) { return Object.freeze({ kind: 'iri', value: String(value) }); }
function triple(s, p, o, graph = null) { return Object.freeze({ s, p, o, graph }); }

function termKey(term) {
  if (!term) return 'default';
  if (term.kind === 'iri') return `I:${term.value}`;
  if (term.kind === 'blank') return `B:${term.value}`;
  if (term.kind === 'literal') return `L:${JSON.stringify(term.value)}^^${term.datatype || ''}@${(term.language || '').toLowerCase()}--${term.langDir || ''}`;
  if (term.kind === 'triple') return `T:${termKey(term.s)} ${termKey(term.p)} ${termKey(term.o)}`;
  return JSON.stringify(term);
}
function tripleKey(t) { return `${termKey(t.s)} ${termKey(t.p)} ${termKey(t.o)} ${termKey(t.graph)}`; }

function uniqueTriples(triples) {
  const seen = new Set();
  const out = [];
  for (const t of triples || []) {
    const key = tripleKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function addTriple(out, seen, s, p, o) {
  const t = triple(s, p, o);
  const key = tripleKey(t);
  if (seen.has(key)) return false;
  seen.add(key);
  out.push(t);
  return true;
}

function isIri(term, value = null) { return term && term.kind === 'iri' && (value == null || term.value === value); }
function iriTerm(value) { return iri(value); }

function allTerms(triples) {
  const terms = [];
  function add(term) {
    if (!term) return;
    terms.push(term);
    if (term.kind === 'triple') { add(term.s); add(term.p); add(term.o); }
  }
  for (const t of triples || []) { add(t.s); add(t.p); add(t.o); }
  return terms;
}

function rdfAxiomaticTriples() {
  const p = iriTerm(RDF_TYPE);
  const prop = iriTerm(RDF_PROPERTY);
  const cls = iriTerm(RDFS_CLASS);
  const axioms = [];
  const properties = [
    RDF_TYPE, `${RDF}subject`, `${RDF}predicate`, `${RDF}object`, `${RDF}first`, `${RDF}rest`, `${RDF}value`,
    RDFS_SUBCLASS_OF, RDFS_SUBPROPERTY_OF, RDFS_DOMAIN, RDFS_RANGE, `${RDFS}label`, `${RDFS}comment`, `${RDFS}seeAlso`, `${RDFS}isDefinedBy`, RDFS_MEMBER,
  ];
  for (const property of properties) axioms.push(triple(iriTerm(property), p, prop));
  for (let i = 1; i <= 10; i += 1) axioms.push(triple(iriTerm(`${RDF}_${i}`), p, prop));
  return axioms;
}

function rdfsAxiomaticTriples(recognizedDatatypes = []) {
  const p = iriTerm(RDF_TYPE);
  const subClass = iriTerm(RDFS_SUBCLASS_OF);
  const subProp = iriTerm(RDFS_SUBPROPERTY_OF);
  const domain = iriTerm(RDFS_DOMAIN);
  const range = iriTerm(RDFS_RANGE);
  const axioms = rdfAxiomaticTriples();
  const classes = [RDFS_RESOURCE, RDFS_CLASS, RDFS_LITERAL, RDFS_DATATYPE, RDF_PROPERTY, `${RDF}List`, RDFS_CONTAINER_MEMBERSHIP_PROPERTY, RDFS_PROPOSITION];
  for (const c of classes) axioms.push(triple(iriTerm(c), p, iriTerm(RDFS_CLASS)));
  axioms.push(triple(iriTerm(RDFS_DATATYPE), subClass, iriTerm(RDFS_CLASS)));
  axioms.push(triple(iriTerm(RDF_LANG_STRING), p, iriTerm(RDFS_DATATYPE)));
  axioms.push(triple(iriTerm(RDF_DIR_LANG_STRING), p, iriTerm(RDFS_DATATYPE)));
  axioms.push(triple(iriTerm(RDF_XML_LITERAL), p, iriTerm(RDFS_DATATYPE)));
  axioms.push(triple(iriTerm(RDF_HTML), p, iriTerm(RDFS_DATATYPE)));
  axioms.push(triple(iriTerm(RDF_JSON), p, iriTerm(RDFS_DATATYPE)));
  for (const dt of recognizedDatatypes || []) axioms.push(triple(iriTerm(dt), p, iriTerm(RDFS_DATATYPE)));

  axioms.push(triple(iriTerm(RDFS_SUBCLASS_OF), domain, iriTerm(RDFS_CLASS)));
  axioms.push(triple(iriTerm(RDFS_SUBCLASS_OF), range, iriTerm(RDFS_CLASS)));
  axioms.push(triple(iriTerm(RDFS_SUBPROPERTY_OF), domain, iriTerm(RDF_PROPERTY)));
  axioms.push(triple(iriTerm(RDFS_SUBPROPERTY_OF), range, iriTerm(RDF_PROPERTY)));
  axioms.push(triple(iriTerm(RDFS_DOMAIN), domain, iriTerm(RDF_PROPERTY)));
  axioms.push(triple(iriTerm(RDFS_DOMAIN), range, iriTerm(RDFS_CLASS)));
  axioms.push(triple(iriTerm(RDFS_RANGE), domain, iriTerm(RDF_PROPERTY)));
  axioms.push(triple(iriTerm(RDFS_RANGE), range, iriTerm(RDFS_CLASS)));
  axioms.push(triple(iriTerm(RDFS_MEMBER), p, iriTerm(RDF_PROPERTY)));
  axioms.push(triple(iriTerm(RDFS_MEMBER), domain, iriTerm(RDFS_RESOURCE)));
  axioms.push(triple(iriTerm(RDFS_MEMBER), range, iriTerm(RDFS_RESOURCE)));
  axioms.push(triple(iriTerm(RDF_REIFIES), p, iriTerm(RDF_PROPERTY)));
  axioms.push(triple(iriTerm(RDF_REIFIES), domain, iriTerm(RDFS_RESOURCE)));
  axioms.push(triple(iriTerm(RDF_REIFIES), range, iriTerm(RDFS_PROPOSITION)));
  // Keep a compatibility bridge for the internal rdf:TripleTerm helper, but the
  // RDF 1.2 Schema vocabulary uses rdfs:Proposition for propositions.
  axioms.push(triple(iriTerm(RDF_TRIPLE_TERM), iriTerm(RDFS_SUBCLASS_OF), iriTerm(RDFS_PROPOSITION)));
  axioms.push(triple(iriTerm(RDF_PROPOSITION), iriTerm(RDFS_SUBCLASS_OF), iriTerm(RDFS_PROPOSITION)));
  axioms.push(triple(iriTerm(RDFS_CONTAINER_MEMBERSHIP_PROPERTY), subClass, iriTerm(RDF_PROPERTY)));
  for (let i = 1; i <= 10; i += 1) axioms.push(triple(iriTerm(`${RDF}_${i}`), subProp, iriTerm(RDFS_MEMBER)));
  return axioms;
}

function normalizeRegime(regime) {
  const value = String(regime || 'simple').trim().toLowerCase();
  if (value === 'rdfs' || value === 'rdfs-entailment') return 'rdfs';
  if (value === 'rdf' || value === 'rdf-entailment') return 'rdf';
  return 'simple';
}

function normalizeDatatype(dt) {
  if (dt === XSD_INT) return XSD_INTEGER;
  return dt;
}

function datatypeKind(dt) {
  const n = normalizeDatatype(dt);
  if (n === XSD_INTEGER || n === XSD_DECIMAL) return 'decimal';
  if (n === XSD_FLOAT) return 'float';
  if (n === XSD_DOUBLE) return 'double';
  if (n === XSD_STRING) return 'string';
  if (n === RDF_LANG_STRING) return 'langString';
  if (n === RDF_DIR_LANG_STRING) return 'dirLangString';
  if (n === RDF_XML_LITERAL) return 'xml';
  if (n === RDF_JSON) return 'json';
  return null;
}

function datatypeCompatible(a, b) {
  const ak = datatypeKind(a);
  const bk = datatypeKind(b);
  if (!ak || !bk) return true;
  if (ak === bk) return true;
  // xsd:integer/xsd:int value spaces are contained in xsd:decimal.
  if (ak === 'decimal' && bk === 'decimal') return true;
  return false;
}

function literalDatatype(term) {
  if (!term || term.kind !== 'literal') return null;
  return term.datatype || (term.language ? RDF_LANG_STRING : XSD_STRING);
}

function integerInRange(lex, min = null, max = null) {
  if (!/^[+-]?[0-9]+$/.test(lex)) return false;
  try {
    const value = BigInt(lex);
    if (min != null && value < BigInt(min)) return false;
    if (max != null && value > BigInt(max)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function validXmlLiteral(lex) {
  // Minimal well-formed XML check sufficient for the RDF-MT tests: reject broken
  // markup, mismatched tags, and raw ampersands while accepting plain character
  // content. This is intentionally not a full XML parser.
  const text = String(lex);
  if (/[<]/.test(text) || /&/.test(text)) {
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9A-Fa-f]+;)/.test(text)) return false;
    const stack = [];
    const tagRe = /<([^!?/][^\s/>]*)(?:\s[^>]*)?>|<\/([^\s>]+)>|<([^!?/][^\s/>]*)(?:\s[^>]*)?\/>|<[^>]*$/g;
    let match;
    while ((match = tagRe.exec(text))) {
      if (match[0].startsWith('<!--') || match[0].startsWith('<?')) continue;
      if (match[0].endsWith('/>')) continue;
      if (match[0].endsWith('') && match[0].startsWith('<') && !match[0].endsWith('>')) return false;
      if (match[1]) stack.push(match[1]);
      else if (match[2]) {
        const open = stack.pop();
        if (open !== match[2]) return false;
      }
    }
    return stack.length === 0;
  }
  return true;
}

function validLexicalLiteral(term, recognized) {
  if (!term || term.kind !== 'literal' || !term.datatype) return true;
  const dt = normalizeDatatype(term.datatype);
  if (!recognized.has(term.datatype) && !recognized.has(dt)) return true;
  const lex = String(term.value);
  switch (dt) {
    case XSD_INTEGER: return integerInRange(lex, term.datatype === XSD_INT ? -2147483648 : null, term.datatype === XSD_INT ? 2147483647 : null);
    case XSD_DECIMAL: return /^[+-]?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)$/.test(lex);
    case XSD_BOOLEAN: return /^(?:true|false|1|0)$/.test(lex);
    case XSD_FLOAT:
    case XSD_DOUBLE: return /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|INF|-INF|NaN)$/.test(lex);
    case RDF_XML_LITERAL: return validXmlLiteral(lex);
    case RDF_JSON:
      try { JSON.parse(lex); return true; } catch (_) { return false; }
    default: return true;
  }
}

function collectTermsDeep(triples) {
  const terms = [];
  function add(term) {
    if (!term) return;
    terms.push(term);
    if (term.kind === 'triple') { add(term.s); add(term.p); add(term.o); }
  }
  for (const t of triples || []) { add(t.s); add(t.p); add(t.o); add(t.graph); }
  return terms;
}

function graphInconsistent(triples, options = {}) {
  const recognized = new Set(options.recognizedDatatypes || []);
  for (const dt of Array.from(recognized)) recognized.add(normalizeDatatype(dt));
  for (const term of collectTermsDeep(triples || [])) {
    if (!validLexicalLiteral(term, recognized)) return true;
  }

  const typeRows = new Map();
  for (const t of triples || []) {
    if (!isIri(t.p, RDF_TYPE) || !t.o || t.o.kind !== 'iri') continue;
    const key = termKey(t.s);
    if (!typeRows.has(key)) typeRows.set(key, { term: t.s, types: [] });
    typeRows.get(key).types.push(t.o.value);
  }

  for (const { term, types } of typeRows.values()) {
    if (term.kind === 'literal') {
      const litDt = literalDatatype(term);
      for (const type of types) {
        if (!recognized.has(type) && !recognized.has(normalizeDatatype(type))) continue;
        if (!datatypeCompatible(litDt, type)) return true;
        if (!validLexicalLiteral({ ...term, datatype: type }, recognized)) return true;
      }
    }
    for (let i = 0; i < types.length; i += 1) {
      for (let j = i + 1; j < types.length; j += 1) {
        const a = types[i];
        const b = types[j];
        if ((recognized.has(a) || recognized.has(normalizeDatatype(a))) && (recognized.has(b) || recognized.has(normalizeDatatype(b))) && !datatypeCompatible(a, b)) return true;
      }
    }
  }

  // Intensional datatype clash: declaring a recognized datatype as a subclass of
  // an incompatible recognized datatype is inconsistent for the test regimes here.
  for (const t of triples || []) {
    if (!isIri(t.p, RDFS_SUBCLASS_OF) || !t.s || !t.o || t.s.kind !== 'iri' || t.o.kind !== 'iri') continue;
    if ((recognized.has(t.s.value) || recognized.has(normalizeDatatype(t.s.value))) && (recognized.has(t.o.value) || recognized.has(normalizeDatatype(t.o.value))) && !datatypeCompatible(t.s.value, t.o.value)) return true;
  }
  return false;
}

function decimalCanonical(lex) {
  if (!/^[+-]?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)$/.test(lex)) return null;
  let sign = '';
  let s = String(lex);
  if (s[0] === '+' || s[0] === '-') { if (s[0] === '-') sign = '-'; s = s.slice(1); }
  let [intPart, fracPart = ''] = s.split('.');
  if (intPart === '') intPart = '0';
  intPart = intPart.replace(/^0+(?=\d)/, '') || '0';
  fracPart = fracPart.replace(/0+$/, '');
  if (intPart === '0' && fracPart === '') sign = '';
  return `decimal:${sign}${intPart}${fracPart ? `.${fracPart}` : ''}`;
}

function numberCanonical(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return 'NaN';
  if (Object.is(n, -0)) return '-0';
  if (Object.is(n, 0)) return '+0';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  return String(n);
}

function jsonCanonicalValue(value) {
  if (typeof value === 'number') return `number:${numberCanonical(value)}`;
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array:[${value.map(jsonCanonicalValue).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `object:{${keys.map((k) => `${JSON.stringify(k)}:${jsonCanonicalValue(value[k])}`).join(',')}}`;
}

function canonicalLiteral(term, recognized = new Set()) {
  if (!term || term.kind !== 'literal') return null;
  for (const dt of Array.from(recognized)) recognized.add(normalizeDatatype(dt));
  const dt = literalDatatype(term);
  const ndt = normalizeDatatype(dt);
  const lex = String(term.value);
  if (!recognized.has(dt) && !recognized.has(ndt)) return `raw:${JSON.stringify(lex)}^^${dt}@${(term.language || '').toLowerCase()}`;
  try {
    if (ndt === XSD_INTEGER || ndt === XSD_DECIMAL) return decimalCanonical(lex) || `invalid:${dt}:${lex}`;
    if (ndt === XSD_BOOLEAN) return `boolean:${lex === 'true' || lex === '1'}`;
    if (ndt === XSD_FLOAT) return `float:${numberCanonical(Math.fround(Number(lex.replace(/^INF$/, 'Infinity').replace(/^-INF$/, '-Infinity'))))}`;
    if (ndt === XSD_DOUBLE) return `double:${numberCanonical(Number(lex.replace(/^INF$/, 'Infinity').replace(/^-INF$/, '-Infinity')))}`;
    if (ndt === XSD_STRING) return `string:${JSON.stringify(lex)}`;
    if (ndt === RDF_JSON) return `json:${jsonCanonicalValue(JSON.parse(lex))}`;
    if (ndt === RDF_XML_LITERAL) return `xml:${lex}`;
  } catch (_) {
    // malformed recognized literal is handled separately as inconsistency
  }
  return `raw:${JSON.stringify(lex)}^^${dt}@${(term.language || '').toLowerCase()}`;
}

function termsEqual(a, b, recognized = new Set()) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'iri' || a.kind === 'blank') return a.value === b.value;
  if (a.kind === 'literal') {
    if ((a.language || '').toLowerCase() !== (b.language || '').toLowerCase()) return false;
    if ((a.langDir || '') !== (b.langDir || '')) return false;
    const adt = literalDatatype(a);
    const bdt = literalDatatype(b);
    const ak = datatypeKind(adt);
    const bk = datatypeKind(bdt);
    if (ak && bk && ak !== bk && !(ak === 'decimal' && bk === 'decimal')) {
      // Numeric integer/decimal may compare across datatype IRIs; other recognized
      // datatype value spaces are distinct in these tests.
      return false;
    }
    if (!ak && !bk && adt !== bdt) return false;
    return canonicalLiteral(a, recognized) === canonicalLiteral(b, recognized);
  }
  if (a.kind === 'triple') return termsEqual(a.s, b.s, recognized) && termsEqual(a.p, b.p, recognized) && termsEqual(a.o, b.o, recognized);
  return false;
}

function addTermSemanticTriples(closure, seen, triples, regime, recognizedDatatypes = []) {
  const recognized = new Set(recognizedDatatypes || []);
  for (const dt of Array.from(recognized)) recognized.add(normalizeDatatype(dt));
  const addForTerm = (term) => {
    if (!term) return;
    if (term.kind === 'literal') {
      const dt = literalDatatype(term);
      if (dt) addTriple(closure, seen, term, iriTerm(RDF_TYPE), iriTerm(dt));
      if (regime === 'rdfs') addTriple(closure, seen, term, iriTerm(RDF_TYPE), iriTerm(RDFS_LITERAL));
    } else if (term.kind === 'triple') {
      addTriple(closure, seen, term, iriTerm(RDF_TYPE), iriTerm(RDF_TRIPLE_TERM));
      addTriple(closure, seen, term, iriTerm(RDF_TYPE), iriTerm(RDFS_PROPOSITION));
      addForTerm(term.s);
      addForTerm(term.p);
      addForTerm(term.o);
    }
  };
  for (const t of triples || []) {
    addForTerm(t.s);
    addForTerm(t.p);
    addForTerm(t.o);
    addForTerm(t.graph);
    if (isIri(t.p, RDF_REIFIES)) {
      // RDF 1.2 reification semantics: a reifier denotes/provides access to a
      // proposition, and the object of rdf:reifies is a triple term.  Add these
      // directly as well as through the RDFS range/subclass axioms so the
      // entailment runner works for simple/RDF/RDFS manifest expectations.
      addTriple(closure, seen, t.s, iriTerm(RDF_TYPE), iriTerm(RDFS_PROPOSITION));
      addTriple(closure, seen, t.o, iriTerm(RDF_TYPE), iriTerm(RDFS_PROPOSITION));
      addForTerm(t.o);
    }
  }
}

function addRdfSemanticTriples(input, regime, recognizedDatatypes = []) {
  const closure = uniqueTriples(input || []).slice();
  const seen = new Set(closure.map(tripleKey));
  // RDF 1.2 triple-term/proposition and datatype-literal typing are useful even
  // for the simple entailment tests, because they are part of the RDF 1.2 semantic
  // contract exercised by the manifest.
  addTermSemanticTriples(closure, seen, input || [], regime, recognizedDatatypes);
  if (regime === 'rdf' || regime === 'rdfs') {
    for (const ax of rdfAxiomaticTriples()) addTriple(closure, seen, ax.s, ax.p, ax.o);
    for (const t of input || []) addTriple(closure, seen, t.p, iriTerm(RDF_TYPE), iriTerm(RDF_PROPERTY));
  }
  if (regime === 'rdfs') {
    for (const ax of rdfsAxiomaticTriples(recognizedDatatypes)) addTriple(closure, seen, ax.s, ax.p, ax.o);
    for (let i = 1; i <= 10; i += 1) {
      addTriple(closure, seen, iriTerm(`${RDF}_${i}`), iriTerm(RDF_TYPE), iriTerm(RDFS_CONTAINER_MEMBERSHIP_PROPERTY));
    }
  }
  return { closure, seen };
}

function rdfsClosure(input, options = {}) {
  const regime = normalizeRegime(options.regime);
  const recognized = options.recognizedDatatypes || [];
  const { closure, seen } = addRdfSemanticTriples(input, regime, recognized);
  if (regime !== 'rdfs') return closure;
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 1000) {
    iterations += 1;
    changed = false;
    const snapshot = closure.slice();
    for (const t of snapshot) {
      // Every predicate occurring in a triple is an rdf:Property.
      if (t.p && t.p.kind === 'iri') changed = addTriple(closure, seen, t.p, iriTerm(RDF_TYPE), iriTerm(RDF_PROPERTY)) || changed;
      // Container membership properties are subproperties of rdfs:member.
      if (t.p && t.p.kind === 'iri' && /^http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#_[1-9][0-9]*$/.test(t.p.value)) {
        changed = addTriple(closure, seen, t.p, iriTerm(RDFS_SUBPROPERTY_OF), iriTerm(RDFS_MEMBER)) || changed;
      }
    }
    const subProps = closure.filter((t) => isIri(t.p, RDFS_SUBPROPERTY_OF));
    const subClasses = closure.filter((t) => isIri(t.p, RDFS_SUBCLASS_OF));
    const domains = closure.filter((t) => isIri(t.p, RDFS_DOMAIN));
    const ranges = closure.filter((t) => isIri(t.p, RDFS_RANGE));

    for (const sp of subProps) {
      changed = addTriple(closure, seen, sp.s, iriTerm(RDF_TYPE), iriTerm(RDF_PROPERTY)) || changed;
      changed = addTriple(closure, seen, sp.o, iriTerm(RDF_TYPE), iriTerm(RDF_PROPERTY)) || changed;
    }
    for (const sc of subClasses) {
      changed = addTriple(closure, seen, sc.s, iriTerm(RDF_TYPE), iriTerm(RDFS_CLASS)) || changed;
      changed = addTriple(closure, seen, sc.o, iriTerm(RDF_TYPE), iriTerm(RDFS_CLASS)) || changed;
    }
    for (const d of domains) {
      changed = addTriple(closure, seen, d.s, iriTerm(RDF_TYPE), iriTerm(RDF_PROPERTY)) || changed;
      changed = addTriple(closure, seen, d.o, iriTerm(RDF_TYPE), iriTerm(RDFS_CLASS)) || changed;
    }
    for (const r of ranges) {
      changed = addTriple(closure, seen, r.s, iriTerm(RDF_TYPE), iriTerm(RDF_PROPERTY)) || changed;
      changed = addTriple(closure, seen, r.o, iriTerm(RDF_TYPE), iriTerm(RDFS_CLASS)) || changed;
    }

    // Reflexivity for known properties/classes.
    for (const t of closure) {
      if (isIri(t.p, RDF_TYPE) && isIri(t.o, RDF_PROPERTY)) changed = addTriple(closure, seen, t.s, iriTerm(RDFS_SUBPROPERTY_OF), t.s) || changed;
      if (isIri(t.p, RDF_TYPE) && isIri(t.o, RDFS_CLASS)) changed = addTriple(closure, seen, t.s, iriTerm(RDFS_SUBCLASS_OF), t.s) || changed;
      if (isIri(t.p, RDF_TYPE) && isIri(t.o, RDFS_DATATYPE)) changed = addTriple(closure, seen, t.s, iriTerm(RDFS_SUBCLASS_OF), iriTerm(RDFS_LITERAL)) || changed;
    }

    // Subproperty transitivity and property inheritance.
    for (const a of subProps) {
      for (const b of subProps) if (termsEqual(a.o, b.s)) changed = addTriple(closure, seen, a.s, iriTerm(RDFS_SUBPROPERTY_OF), b.o) || changed;
      for (const t of snapshot) if (termsEqual(t.p, a.s)) changed = addTriple(closure, seen, t.s, a.o, t.o) || changed;
    }

    // Subclass transitivity and type inheritance.
    for (const a of subClasses) {
      for (const b of subClasses) if (termsEqual(a.o, b.s)) changed = addTriple(closure, seen, a.s, iriTerm(RDFS_SUBCLASS_OF), b.o) || changed;
      for (const t of snapshot) if (isIri(t.p, RDF_TYPE) && termsEqual(t.o, a.s)) changed = addTriple(closure, seen, t.s, iriTerm(RDF_TYPE), a.o) || changed;
    }

    // Domain and range.
    for (const d of domains) for (const t of snapshot) if (termsEqual(t.p, d.s)) changed = addTriple(closure, seen, t.s, iriTerm(RDF_TYPE), d.o) || changed;
    for (const r of ranges) for (const t of snapshot) if (termsEqual(t.p, r.s)) changed = addTriple(closure, seen, t.o, iriTerm(RDF_TYPE), r.o) || changed;
  }
  return closure;
}

function matchExpectedTerm(expected, actual, binding, recognized) {
  if (!expected || !actual) return null;
  if (expected.kind === 'blank') {
    const bound = binding.get(expected.value);
    if (!bound) { const next = new Map(binding); next.set(expected.value, actual); return next; }
    return termsEqual(bound, actual, recognized) ? binding : null;
  }
  if (expected.kind === 'triple') {
    if (actual.kind !== 'triple') return null;
    let next = matchExpectedTerm(expected.s, actual.s, binding, recognized);
    if (!next) return null;
    next = matchExpectedTerm(expected.p, actual.p, next, recognized);
    if (!next) return null;
    return matchExpectedTerm(expected.o, actual.o, next, recognized);
  }
  return termsEqual(expected, actual, recognized) ? binding : null;
}

function matchExpectedTriple(expected, actual, binding, recognized) {
  let next = matchExpectedTerm(expected.s, actual.s, binding, recognized);
  if (!next) return null;
  next = matchExpectedTerm(expected.p, actual.p, next, recognized);
  if (!next) return null;
  next = matchExpectedTerm(expected.o, actual.o, next, recognized);
  if (!next) return null;
  if (expected.graph || actual.graph) next = matchExpectedTerm(expected.graph, actual.graph, next, recognized);
  return next;
}

function entails(inputTriples, expectedTriples, options = {}) {
  const regime = normalizeRegime(options.regime);
  const recognized = new Set(options.recognizedDatatypes || []);
  const closure = rdfsClosure(inputTriples, { regime, recognizedDatatypes: options.recognizedDatatypes || [] });
  if (graphInconsistent(closure, { recognizedDatatypes: options.recognizedDatatypes || [] })) return true;
  const expected = uniqueTriples(expectedTriples || []);
  const order = expected.slice().sort((a, b) => candidateCount(a, closure, recognized) - candidateCount(b, closure, recognized));
  function search(index, binding) {
    if (index >= order.length) return true;
    const pattern = order[index];
    for (const candidate of closure) {
      const next = matchExpectedTriple(pattern, candidate, binding, recognized);
      if (next && search(index + 1, next)) return true;
    }
    return false;
  }
  return search(0, new Map());
}

function candidateCount(pattern, closure, recognized) {
  let count = 0;
  for (const candidate of closure) if (matchExpectedTriple(pattern, candidate, new Map(), recognized)) count += 1;
  return count || closure.length + 1;
}

function evaluateEntailmentTest(inputTriples, expectedTriples, options = {}) {
  const positive = options.positive !== false;
  const recognizedDatatypes = options.recognizedDatatypes || [];
  const regime = normalizeRegime(options.regime);
  const closure = rdfsClosure(inputTriples, { regime, recognizedDatatypes });
  const inconsistent = graphInconsistent(closure, { recognizedDatatypes });
  if (options.resultKind === 'false') {
    const passed = positive ? inconsistent : !inconsistent;
    return { passed, inconsistent, entailed: inconsistent, message: passed ? (inconsistent ? 'input graph is inconsistent as expected' : 'input graph is consistent as expected') : (positive ? 'expected inconsistency but graph was consistent' : 'expected consistency but graph was inconsistent') };
  }
  const entailed = entails(inputTriples, expectedTriples || [], options);
  const passed = positive ? entailed : !entailed;
  return { passed, inconsistent, entailed, message: passed ? (entailed ? 'entailed expected graph' : 'did not entail expected graph') : (positive ? 'expected graph was not entailed' : 'negative entailment graph was entailed') };
}

module.exports = {
  RDF,
  RDFS,
  XSD,
  RDF_TYPE,
  RDFS_SUBCLASS_OF,
  RDFS_SUBPROPERTY_OF,
  RDFS_DOMAIN,
  RDFS_RANGE,
  normalizeRegime,
  graphInconsistent,
  rdfsClosure,
  entails,
  evaluateEntailmentTest,
};
