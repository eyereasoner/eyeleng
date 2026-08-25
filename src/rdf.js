'use strict';

const { iri, variable, blankNode, literal, tripleTerm, XSD_STRING, XSD_BOOLEAN, XSD_INTEGER, XSD_DECIMAL, XSD_DOUBLE } = require('./term.js');

const CONTENT_TYPES = Object.freeze({
  turtle: 'text/turtle',
  trig: 'application/trig',
  ntriples: 'application/n-triples',
  nquads: 'application/n-quads',
  n3: 'text/n3',
  jsonld: 'application/ld+json',
  rdfxml: 'application/rdf+xml',
});

/**
 * Parse an RDF 1.2 document through rdf-parse.js.
 *
 * Eyeleng deliberately does not maintain a second RDF parser. rdf-parse 5.x
 * selects the concrete RDF parser and exposes RDF/JS quads, including RDF 1.2
 * triple terms where the selected syntax supports them.
 */
async function parseRdfDocument(source, options = {}) {
  const { Readable } = require('readable-stream');
  const { rdfParser } = require('rdf-parse');
  const { default: dataFactory } = await import('@rdfjs/data-model');
  const prefixes = { ...(options.prefixes || {}) };
  const parseOptions = rdfParseOptions(options);
  parseOptions.dataFactory = dataFactory;

  const stream = rdfParser.parse(Readable.from([String(source ?? '')]), parseOptions);
  stream.on('prefix', (prefix, value) => {
    prefixes[String(prefix)] = value && value.value ? value.value : String(value);
  });

  const quads = [];
  for await (const quad of stream) quads.push(quad);
  const triples = quads.map((quad) => {
    const triple = {
      s: rdfJsTermToTerm(quad.subject),
      p: rdfJsTermToTerm(quad.predicate),
      o: rdfJsTermToTerm(quad.object),
    };
    if (quad.graph && quad.graph.termType !== 'DefaultGraph') triple.graph = rdfJsTermToTerm(quad.graph);
    return triple;
  });

  return {
    baseIRI: options.baseIRI || options.base || null,
    prefixes,
    triples,
    quads,
  };
}

function rdfParseOptions(options = {}) {
  const out = {};
  const contentType = options.contentType || CONTENT_TYPES[options.profile] || CONTENT_TYPES[options.format];
  if (contentType) out.contentType = contentType;
  else if (options.filename && !/^<.*>$/.test(options.filename)) {
    const cleanFilename = String(options.filename).replace(/[?#].*$/, '');
    if (/\.[A-Za-z0-9]+$/.test(cleanFilename)) out.path = cleanFilename;
    else out.contentType = 'text/turtle';
  } else out.contentType = 'text/turtle';
  if (options.baseIRI || options.base) out.baseIRI = options.baseIRI || options.base;
  // rdf-parse 5.x supports RDF 1.2 parser selection/version announcements.
  out.version = options.version || '1.2';
  if (options.parseUnsupportedVersions) out.parseUnsupportedVersions = true;
  return out;
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
  // RDF/JS represents an RDF 1.2 triple term as a Quad in term position.
  if (term.termType === 'Quad') {
    return tripleTerm(rdfJsTermToTerm(term.subject), rdfJsTermToTerm(term.predicate), rdfJsTermToTerm(term.object));
  }
  if (term.termType === 'DefaultGraph') return null;
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

module.exports = { parseRdfDocument, rdfParseOptions, rdfJsTermToTerm, CONTENT_TYPES };
