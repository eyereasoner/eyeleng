'use strict';

const { literal, termKey, comparePrimitives, XSD_INTEGER, XSD_DECIMAL, XSD_DOUBLE } = require('./term.js');
const { bindingKey } = require('./store.js');
const { evalBinary } = require('./builtins.js');

const XSD_FLOAT = 'http://www.w3.org/2001/XMLSchema#float';
const numericTypes = [XSD_INTEGER, XSD_DECIMAL, XSD_FLOAT, XSD_DOUBLE];
const integerType = /^http:\/\/www\.w3\.org\/2001\/XMLSchema#(?:integer|long|int|short|byte|nonNegativeInteger|positiveInteger|nonPositiveInteger|negativeInteger|unsignedLong|unsignedInt|unsignedShort|unsignedByte)$/;

function numericLiteral(value) {
  if (!value || value.type !== 'literal') return null;
  const rank = integerType.test(value.datatype) ? 0 : numericTypes.indexOf(value.datatype);
  if (rank < 0) return null;
  if (rank > 0 && typeof value.value === 'number') return { rank, value: value.value };
  const lexical = String(value.value).trim();
  if (rank === 0) {
    if (!/^[+-]?\d+$/.test(lexical)) throw new Error('Invalid integer literal');
    const number = Number(lexical);
    return { rank, value: Number.isSafeInteger(number) ? number : BigInt(lexical) };
  }
  const pattern = rank === 1 ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/ : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?INF$|^NaN$/;
  if (!pattern.test(lexical)) throw new Error('Invalid numeric literal');
  return { rank, value: lexical === 'INF' || lexical === '+INF' ? Infinity : lexical === '-INF' ? -Infinity : Number(lexical) };
}

// SPARQL-RL §6.4: the input is a multiset, including for COUNT(*).
function evalAggregate(fn, sequence) {
  if (fn.name === 'COUNT' && fn.argument === '*') {
    return literal(fn.distinct ? new Set(sequence.map(bindingKey)).size : sequence.length, XSD_INTEGER);
  }
  let values = sequence.map((binding) => binding[fn.argument]);
  if (fn.distinct) values = [...new Map(values.map((value) => [termKey(value), value])).values()];
  if (fn.name === 'COUNT') return literal(values.filter((value) => value !== undefined).length, XSD_INTEGER);
  if (fn.name === 'SUM') {
    let sum = 0;
    let rank = 0;
    for (const value of values) {
      const numeric = numericLiteral(value);
      if (!numeric) throw new Error('SUM requires numeric literals');
      rank = Math.max(rank, numeric.rank);
      sum = rank === 0 ? evalBinary('+', sum, numeric.value) : Number(sum) + Number(numeric.value);
    }
    return literal(sum, numericTypes[rank]);
  }
  if (values.length === 0 || values.some((value) => value === undefined)) throw new Error(`${fn.name} has no value`);
  return values.reduce((best, value) => {
    const order = compareAggregateTerms(value, best);
    return (fn.name === 'MIN' ? order < 0 : order > 0) ? value : best;
  });
}

// MIN/MAX use the SPARQL ORDER BY ordering, retaining the selected RDF term.
function compareAggregateTerms(a, b) {
  const rank = { blank: 0, iri: 1, literal: 2, triple: 3 };
  if (a.type !== b.type) return rank[a.type] - rank[b.type];
  if (a.type === 'triple') {
    return compareAggregateTerms(a.s, b.s) || compareAggregateTerms(a.p, b.p) || compareAggregateTerms(a.o, b.o);
  }
  if (a.type === 'literal') {
    const an = numericLiteral(a);
    const bn = numericLiteral(b);
    if (an && bn) return an.value < bn.value ? -1 : an.value > bn.value ? 1 : 0;
    // dateTime values with explicit timezones are ordered by their instants.
    if (a.datatype === 'http://www.w3.org/2001/XMLSchema#dateTime' && a.datatype === b.datatype) {
      const av = Date.parse(a.value);
      const bv = Date.parse(b.value);
      if (Number.isFinite(av) && Number.isFinite(bv)) return comparePrimitives(av, bv);
    }
  }
  if (typeof a.value === 'string' && typeof b.value === 'string') {
    // SPARQL string/IRI ordering uses Unicode code points, not UTF-16 units.
    const left = Array.from(a.value, (character) => character.codePointAt(0));
    const right = Array.from(b.value, (character) => character.codePointAt(0));
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.length - right.length;
  }
  return comparePrimitives(a, b);
}

module.exports = { evalAggregate };
