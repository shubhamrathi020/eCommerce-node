import { HttpError } from './errors';
import { anyArray, anyObject, arrayOf, int, nested, num, oneOf, optional, str, validateBody } from './validate';

const shape = { name: str(5), age: int(0), tags: anyArray(), note: optional(str()), mode: oneOf('a', 'b') };
const ok = { name: 'Asha', age: 3, tags: [], mode: 'a' };

describe('validateBody', () => {
  it('accepts a body that matches the shape, with or without optional properties', () => {
    expect(validateBody(shape, ok)).toBe(ok);
    expect(() => validateBody(shape, { ...ok, note: 'x' })).not.toThrow();
    expect(() => validateBody(shape, { ...ok, note: null })).not.toThrow();
  });

  it('refuses a missing, mistyped or oversized property with one generic 400', () => {
    for (const bad of [{ ...ok, name: undefined }, { ...ok, name: 5 }, { ...ok, name: 'toolong' }, { ...ok, age: 1.5 }, { ...ok, age: -1 }, { ...ok, tags: {} }, { ...ok, mode: 'c' }, { ...ok, note: 3 }]) {
      expect(() => validateBody(shape, bad)).toThrow(HttpError);
    }
    try {
      validateBody(shape, {});
    } catch (error) {
      expect(error).toMatchObject({ status: 400, message: 'The request was not valid.' });
    }
  });

  it('refuses properties that are not declared, at every level (whitelist + forbid non-whitelisted)', () => {
    expect(() => validateBody(shape, { ...ok, extra: 1 })).toThrow(HttpError);
    const deep = { address: nested({ city: str() }), lines: arrayOf({ sku: str(), options: anyObject(), price: num(0) }) };
    expect(() => validateBody(deep, { address: { city: 'x', extra: 1 }, lines: [] })).toThrow(HttpError);
    expect(() => validateBody(deep, { address: { city: 'x' }, lines: [{ sku: 's', options: {}, price: 1, extra: true }] })).toThrow(HttpError);
    expect(() => validateBody(deep, { address: { city: 'x' }, lines: [{ sku: 's', options: {}, price: 1 }] })).not.toThrow();
    expect(() => validateBody(deep, { address: 'x', lines: [] })).toThrow(HttpError);
    expect(() => validateBody(deep, { address: { city: 'x' }, lines: [1] })).toThrow(HttpError);
  });

  it('refuses a body that is not an object', () => {
    for (const bad of [undefined, null, 'x', 3, [], [ok]]) expect(() => validateBody(shape, bad)).toThrow(HttpError);
  });
});
