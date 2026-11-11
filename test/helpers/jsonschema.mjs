// A JSON Schema validator for the keywords the diagnose() schema uses (draft 2020-12): type, enum, const,
// pattern, minimum, required, properties, additionalProperties: false, items, anyOf, if / then / else.
// validate(schema, value) returns the list of failures ("<path>: <why>"), empty when the value is valid.
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => { const k = typeOf(v); return k === t || (t === 'number' && k === 'integer'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function validate(schema, value, at = '$', out = []) {
  const fail = (why) => out.push(`${at}: ${why}`);
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => isType(value, t))) fail(`is ${typeOf(value)}, not ${types.join(' or ')}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((x) => same(x, value))) fail('is not one of the allowed values');
  if (schema.const !== undefined && !same(schema.const, value)) fail('is not the constant');
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) fail(`does not match ${schema.pattern}`);
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) fail(`is below ${schema.minimum}`);
  if (schema.anyOf !== undefined && !schema.anyOf.some((s) => validate(s, value, at, []).length === 0)) fail('matches none of anyOf');
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) fail(`${k} is missing`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && schema.properties[k]) validate(schema.properties[k], v, `${at}.${k}`, out);
      else if (schema.additionalProperties === false) fail(`${k} is not allowed`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, out));
  if (schema.if !== undefined) {
    const branch = validate(schema.if, value, at, []).length === 0 ? schema.then : schema.else;
    if (branch) validate(branch, value, at, out);
  }
  return out;
}
