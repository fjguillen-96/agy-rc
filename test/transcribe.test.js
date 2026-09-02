import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isUploadRequest } from '../server/routes.js';
import { transcribeAudioWithGemini } from '../server/transcribe.js';

describe('transcribe route & helper', () => {
  test('isUploadRequest detecta /transcribe como petición de cuerpo crudo', () => {
    assert.equal(isUploadRequest({ method: 'POST', path: '/transcribe' }), true);
    assert.equal(isUploadRequest({ method: 'GET', path: '/transcribe' }), false);
    assert.equal(isUploadRequest({ method: 'POST', path: '/chats' }), false);
    assert.equal(isUploadRequest({ method: 'PUT', path: '/chats/c_123/uploads' }), true);
  });

  test('transcribeAudioWithGemini lanza error descriptivo si el buffer está vacío', async () => {
    await assert.rejects(
      () => transcribeAudioWithGemini(Buffer.alloc(0)),
      /vacío/
    );
  });
});
