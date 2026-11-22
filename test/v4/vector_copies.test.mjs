// The contract vectors this repository carries (test/vectors40) are byte copies of the contract's (sdk_4.0.0/vectors),
// checked against the contract checkout QL_CONTRACT names when it is set (in CI, the contract commit
// .github/ci-inputs.sh pins). 4.0.2 refreshed errors_40.json (its `causes`) and added no_wait_40.json and
// share_write_40.json from contract adca6f6, and steering_40.json from 9585201.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('../vectors40/', import.meta.url));
const CONTRACT = process.env.QL_CONTRACT;
const skip = !CONTRACT || !existsSync(join(String(CONTRACT), 'vectors')) ? 'QL_CONTRACT is not set (the contract\'s sdk_4.0.0 folder)' : false;

test('every vector copy of test/vectors40 is the contract\'s, byte for byte', { skip }, () => {
  const names = readdirSync(HERE).filter((n) => n.endsWith('.json')).sort();
  for (const n of ['errors_40.json', 'no_wait_40.json', 'share_write_40.json', 'steering_40.json']) assert.ok(names.includes(n), n);
  for (const n of names) {
    const theirs = join(String(CONTRACT), 'vectors', n);
    assert.ok(existsSync(theirs), `${n} is in the contract`);
    assert.ok(Buffer.compare(readFileSync(join(HERE, n)), readFileSync(theirs)) === 0, `${n} is the contract's, byte for byte`);
  }
});
