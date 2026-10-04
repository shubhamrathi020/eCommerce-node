import { HttpError } from './errors';

/**
 * Request-body validation with the same outcome as the Nest API's `ValidationPipe({ whitelist, forbidNonWhitelisted })`
 * over class-validator DTOs: every declared property must have the declared type and size, a property that is not
 * declared is refused, and any failure becomes one generic 400 that never echoes the input back.
 */
export type Check = (value: unknown) => boolean;

export interface Field {
  check: Check;
  optional?: boolean;
}

export type Shape = Record<string, Field>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `@IsString() @MaxLength(max)`. */
export const str = (max?: number): Field => ({ check: (v) => typeof v === 'string' && (max === undefined || v.length <= max) });
/** `@IsInt() @Min(min)`. */
export const int = (min: number): Field => ({ check: (v) => typeof v === 'number' && Number.isInteger(v) && v >= min });
/** `@IsNumber() @Min(min)` (NaN and infinities are refused, like class-validator's default). */
export const num = (min: number): Field => ({ check: (v) => typeof v === 'number' && Number.isFinite(v) && v >= min });
/** `@IsIn(values)`. */
export const oneOf = (...values: readonly string[]): Field => ({ check: (v) => typeof v === 'string' && values.includes(v) });
/** `@IsObject()`: any object, contents unchecked. */
export const anyObject = (): Field => ({ check: isObject });
/** `@IsArray()`: any array, elements unchecked. */
export const anyArray = (): Field => ({ check: Array.isArray });
/** `@ValidateNested() @Type(...)`: an object that itself matches `shape`. */
export const nested = (shape: Shape): Field => ({ check: (v) => isObject(v) && matches(shape, v) });
/** `@IsArray() @ValidateNested({ each: true })`: an array whose elements all match `shape`. */
export const arrayOf = (shape: Shape): Field => ({ check: (v) => Array.isArray(v) && v.every((el) => isObject(el) && matches(shape, el)) });
/** `@IsOptional()`: absent or null skips every other check. */
export const optional = (field: Field): Field => ({ ...field, optional: true });

function matches(shape: Shape, value: Record<string, unknown>): boolean {
  for (const key of Object.keys(value)) if (!(key in shape)) return false;
  for (const [key, field] of Object.entries(shape)) {
    const v = value[key];
    if (field.optional && (v === undefined || v === null)) continue;
    if (!field.check(v)) return false;
  }
  return true;
}

/** The message every refused body gets (code `validation`, status 400). */
export const NOT_VALID = 'The request was not valid.';

export function validateBody<T>(shape: Shape, body: unknown): T {
  if (!isObject(body) || !matches(shape, body)) throw new HttpError(400, NOT_VALID);
  return body as T;
}
