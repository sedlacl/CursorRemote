import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveRelayProxyPort, resolveRelayProxyTarget } from '../src/shared/relay-proxy-target.js';

describe('relay proxy target', () => {
  it('prefers CURSOR_REMOTE_RELAY_PORT, then SERVER_PORT, then 3001', () => {
    assert.equal(resolveRelayProxyPort({ CURSOR_REMOTE_RELAY_PORT: '4174' }), 4174);
    assert.equal(resolveRelayProxyPort({ SERVER_PORT: '3001' }), 3001);
    assert.equal(resolveRelayProxyPort({}), 3001);
  });

  it('builds a localhost relay target for vite proxy', () => {
    assert.equal(
      resolveRelayProxyTarget({ SERVER_HOST: '127.0.0.1', SERVER_PORT: '3001' }),
      'http://127.0.0.1:3001',
    );
  });
});
