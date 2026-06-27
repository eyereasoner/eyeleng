'use strict';

const { parseRdfDocument } = require('./rdfSyntax.js');
const {
  iri,
  blankNode,
  literal,
  tripleTerm,
  RDF_TYPE,
  RDF_FIRST,
  RDF_REST,
  RDF_NIL,
  XSD_INTEGER,
} = require('./term.js');

const RDF_MESSAGE_VERSION_RE = /^\s*(?:@version|VERSION)\s+(["'])(?:1\.1|1\.2|1\.2-basic)-messages\1\s*\.?\s*(?:#.*)?$/im;
const RDF_MESSAGE_VERSION_LINE_RE = /^\s*(?:@version|VERSION)\s+(["'])(?:1\.1|1\.2|1\.2-basic)-messages\1\s*\.?\s*(?:#.*)?$/i;
const RDF_DIRECTIVE_LINE_RE = /^\s*(?:@?(?:prefix|base)\b|PREFIX\b|BASE\b)/i;
const RDF_MESSAGE_DELIMITER_LINE_RE = /^\s*(?:MESSAGE\b|@message\s*\.?)\s*(?:#.*)?$/i;

const EYMSG_NS = 'https://eyereasoner.github.io/eyeling/vocab/message#';
const LOG_NS = 'http://www.w3.org/2000/10/swap/log#';
const EYMSG = Object.freeze({
  RDFMessageStream: `${EYMSG_NS}RDFMessageStream`,
  MessageEnvelope: `${EYMSG_NS}MessageEnvelope`,
  envelope: `${EYMSG_NS}envelope`,
  firstEnvelope: `${EYMSG_NS}firstEnvelope`,
  lastEnvelope: `${EYMSG_NS}lastEnvelope`,
  orderedEnvelopes: `${EYMSG_NS}orderedEnvelopes`,
  messageCount: `${EYMSG_NS}messageCount`,
  offset: `${EYMSG_NS}offset`,
  nextEnvelope: `${EYMSG_NS}nextEnvelope`,
  payloadGraph: `${EYMSG_NS}payloadGraph`,
  payloadKind: `${EYMSG_NS}payloadKind`,
  payloadTriple: `${EYMSG_NS}payloadTriple`,
  tripleCount: `${EYMSG_NS}tripleCount`,
  empty: `${EYMSG_NS}empty`,
  nonEmpty: `${EYMSG_NS}nonEmpty`,
});
const LOG_NAME_OF = `${LOG_NS}nameOf`;

function simpleHashText(value) {
  let h = 0x811c9dc5;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function looksLikeRdfMessageLog(source, options = {}) {
  return !!options.rdfMessages || RDF_MESSAGE_VERSION_RE.test(String(source || ''));
}

function splitPreservingLineEndings(text) {
  return String(text || '').match(/.*(?:\r\n|\n|\r)|.+$/g) || [];
}

function isOnlyWhitespaceAndComments(text) {
  return splitPreservingLineEndings(text).every((line) => {
    const hash = line.indexOf('#');
    const body = hash >= 0 ? line.slice(0, hash) : line;
    return body.trim() === '';
  });
}

function stripMessageVersionLines(text) {
  return splitPreservingLineEndings(text).filter((line) => !RDF_MESSAGE_VERSION_LINE_RE.test(line)).join('');
}

function stripDirectiveLines(text) {
  return splitPreservingLineEndings(text).filter((line) => !RDF_DIRECTIVE_LINE_RE.test(line) && !RDF_MESSAGE_VERSION_LINE_RE.test(line)).join('');
}

function collectDirectiveLines(text) {
  const seen = new Set();
  const out = [];
  for (const line of splitPreservingLineEndings(text)) {
    if (!RDF_DIRECTIVE_LINE_RE.test(line)) continue;
    const key = line.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line.endsWith('\n') || line.endsWith('\r') ? line : `${line}\n`);
  }
  return out;
}

function readStringAt(source, index) {
  const quote = source[index];
  const long = source.startsWith(quote.repeat(3), index);
  let i = index + (long ? 3 : 1);
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (long && source.startsWith(quote.repeat(3), i)) return { end: i + 3 };
    if (!long && source[i] === quote) return { end: i + 1 };
    i += 1;
  }
  return { end: source.length };
}

function readIriAt(source, index) {
  let i = index + 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === '>') return { end: i + 1 };
    i += 1;
  }
  return { end: source.length };
}

function skipWsAndComments(source, index) {
  let i = index;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i += 1; continue; }
    if (source[i] === '#') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i += 1;
      continue;
    }
    break;
  }
  return i;
}

function isWordChar(ch) { return !!ch && /[A-Za-z0-9_\-]/.test(ch); }
function startsWordAt(source, word, index) {
  return source.slice(index, index + word.length).toUpperCase() === word && !isWordChar(source[index - 1]) && !isWordChar(source[index + word.length]);
}

function findMessageDirectiveAt(source, index) {
  if (startsWordAt(source, 'MESSAGE', index)) return { start: index, end: index + 'MESSAGE'.length };
  if (source.slice(index, index + 8).toLowerCase() === '@message' && !isWordChar(source[index + 8])) {
    let end = index + 8;
    end = skipWsAndComments(source, end);
    if (source[end] === '.') end += 1;
    return { start: index, end };
  }
  return null;
}

function splitRdfMessageLog(source) {
  const text = stripMessageVersionLines(source);
  const chunks = [];
  let i = 0;
  let start = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let statementStart = true;
  let sawDelimiter = false;

  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = readStringAt(text, i).end; statementStart = false; continue; }
    if (ch === '<' && !text.startsWith('<<', i)) { i = readIriAt(text, i).end; statementStart = false; continue; }
    if (ch === '#') { while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1; statementStart = true; continue; }

    if (statementStart && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      const termStart = skipWsAndComments(text, i);
      const directive = findMessageDirectiveAt(text, termStart);
      if (directive) {
        chunks.push(text.slice(start, termStart));
        start = directive.end;
        i = directive.end;
        statementStart = true;
        sawDelimiter = true;
        continue;
      }
      if (termStart !== i) { i = termStart; continue; }
    }

    if (ch === '{') braceDepth += 1;
    else if (ch === '}' && braceDepth > 0) braceDepth -= 1;
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']' && bracketDepth > 0) bracketDepth -= 1;
    else if (ch === '(') parenDepth += 1;
    else if (ch === ')' && parenDepth > 0) parenDepth -= 1;

    if (ch === '.' && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) statementStart = true;
    else if (ch === '\n' || ch === '\r') statementStart = true;
    else if (!/\s/.test(ch)) statementStart = false;
    i += 1;
  }

  const tail = text.slice(start);
  if (!sawDelimiter || !isOnlyWhitespaceAndComments(tail)) chunks.push(tail);
  return chunks;
}

function rewriteMessageBlankLabels(source, messageIndex) {
  const prefix = `msg${String(messageIndex).padStart(3, '0')}_`;
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const end = readStringAt(source, i).end;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '<' && !source.startsWith('<<', i)) {
      const end = readIriAt(source, i).end;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '#') {
      while (i < source.length) {
        const c = source[i++]; out += c;
        if (c === '\n' || c === '\r') break;
      }
      continue;
    }
    if (source.startsWith('_:', i)) {
      let j = i + 2;
      while (j < source.length && !/\s/.test(source[j]) && !'{}[](),;.<>'.includes(source[j])) j += 1;
      const label = source.slice(i + 2, j);
      if (label) {
        out += `_:${prefix}${label.replace(/[^A-Za-z0-9_\-]/g, '_')}`;
        i = j;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function messageChunkHasRdf(chunk) {
  return !isOnlyWhitespaceAndComments(stripDirectiveLines(chunk));
}

function listTriples(headTerm, items, data, makeBlank) {
  if (items.length === 0) return iri(RDF_NIL);
  const cells = items.map(() => makeBlank());
  for (let i = 0; i < cells.length; i += 1) {
    data.push({ s: cells[i], p: iri(RDF_FIRST), o: items[i] });
    data.push({ s: cells[i], p: iri(RDF_REST), o: i + 1 < cells.length ? cells[i + 1] : iri(RDF_NIL) });
  }
  return headTerm || cells[0];
}

function parseRdfMessageLog(source, options = {}) {
  const text = String(source || '');
  const directives = collectDirectiveLines(text);
  const chunks = splitRdfMessageLog(text);
  // Keep generated message-log IRIs stable across machines and checkout paths.
  // The previous seed used baseIRI/filename, which made golden outputs depend on
  // absolute local paths such as file:///home/.../examples/rdf-messages.trig.
  // A caller that needs a location-specific identity can still pass
  // options.messageBaseIRI explicitly.
  const hash = simpleHashText(text);
  const base = options.messageBaseIRI || `urn:eyeleng:message-log:${hash}`;
  const stream = iri(`${base}#stream`);
  const envelopes = chunks.map((unused, index) => iri(`${base}#m${String(index + 1).padStart(3, '0')}`));
  const payloads = chunks.map((unused, index) => iri(`${base}#m${String(index + 1).padStart(3, '0')}/payload`));
  const data = [];
  let bnodeCounter = 0;
  const makeBlank = () => blankNode(`msg${++bnodeCounter}`);
  const prefixes = {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    eymsg: EYMSG_NS,
    log: LOG_NS,
  };

  data.push({ s: stream, p: iri(RDF_TYPE), o: iri(EYMSG.RDFMessageStream) });
  data.push({ s: stream, p: iri(EYMSG.messageCount), o: literal(chunks.length, XSD_INTEGER) });
  if (envelopes.length > 0) {
    data.push({ s: stream, p: iri(EYMSG.orderedEnvelopes), o: listTriples(null, envelopes, data, makeBlank) });
    data.push({ s: stream, p: iri(EYMSG.firstEnvelope), o: envelopes[0] });
    data.push({ s: stream, p: iri(EYMSG.lastEnvelope), o: envelopes[envelopes.length - 1] });
  }

  for (let i = 0; i < chunks.length; i += 1) {
    const envelope = envelopes[i];
    const payload = payloads[i];
    const rawChunk = chunks[i];
    const chunk = rewriteMessageBlankLabels(rawChunk, i + 1);
    const hasBody = messageChunkHasRdf(chunk);
    const bodySource = `${directives.join('')}\n${stripDirectiveLines(chunk)}`;
    const parsed = hasBody ? parseRdfDocument(bodySource, { ...options, filename: `${options.filename || '<message>'}#m${i + 1}`, baseIRI: options.baseIRI }) : { triples: [], prefixes: {} };
    Object.assign(prefixes, parsed.prefixes || {});
    const payloadTriples = parsed.triples || [];
    const tripleTerms = payloadTriples.map((t) => tripleTerm(t.s, t.p, t.o));

    data.push({ s: stream, p: iri(EYMSG.envelope), o: envelope });
    data.push({ s: envelope, p: iri(RDF_TYPE), o: iri(EYMSG.MessageEnvelope) });
    data.push({ s: envelope, p: iri(EYMSG.offset), o: literal(i + 1, XSD_INTEGER) });
    data.push({ s: envelope, p: iri(EYMSG.payloadKind), o: iri(hasBody ? EYMSG.nonEmpty : EYMSG.empty) });
    data.push({ s: envelope, p: iri(EYMSG.tripleCount), o: literal(payloadTriples.length, XSD_INTEGER) });
    if (i + 1 < envelopes.length) data.push({ s: envelope, p: iri(EYMSG.nextEnvelope), o: envelopes[i + 1] });
    if (hasBody) {
      data.push({ s: envelope, p: iri(EYMSG.payloadGraph), o: payload });
      data.push({ s: payload, p: iri(LOG_NAME_OF), o: listTriples(null, tripleTerms, data, makeBlank) });
      for (const term of tripleTerms) data.push({ s: payload, p: iri(EYMSG.payloadTriple), o: term });
      if (options.includeMessageFacts) data.push(...payloadTriples);
    }
  }

  return {
    baseIRI: options.baseIRI || null,
    version: '1.2-messages',
    imports: [],
    prefixes,
    data,
    rules: [],
  };
}

module.exports = {
  EYMSG_NS,
  EYMSG,
  LOG_NS,
  LOG_NAME_OF,
  looksLikeRdfMessageLog,
  splitRdfMessageLog,
  parseRdfMessageLog,
};
