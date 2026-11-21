import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { ProtectedTransport, protectProvider } from '../src/transport.mjs';

const codexKey = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.`;
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
for (const provider of builtinProviders().filter(p => ['openai', 'anthropic', 'openai-codex'].includes(p.id))) {
  test(`real ${provider.id} adapter: proxy routing and abort on VPN change`, { timeout: 15000 }, async () => {
    let streaming = false;
    let success = false;
    let received;
    let connects = 0;
    const sockets = new Set();
    const origin = http.createServer((_req, res) => {
      if (streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': keepalive\n\n');
        received?.();
      } else if (success) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const message = { id: 'msg_test', type: 'message', role: 'assistant', content: [], model: 'test', usage: { input_tokens: 1, output_tokens: 0 } };
        const response = { id: 'resp_test', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        const events = provider.id === 'anthropic' ? [
          { type: 'message_start', message },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ] : [
          { type: 'response.created', response: { ...response, status: 'in_progress' } },
          { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress' } },
          { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: message.id, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: 'hello' },
          { type: 'response.output_item.done', output_index: 0, item: { ...message, status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] } },
          { type: 'response.completed', response },
        ];
        res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } else {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'synthetic test rejection', type: 'invalid_request_error' } }));
      }
    });
    const targetPort = await listen(origin);
    const proxy = http.createServer();
    proxy.on('connect', (req, client, head) => {
      connects++;
      assert.equal(req.url, `127.0.0.1:${targetPort}`);
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      for (const socket of [client, upstream]) {
        sockets.add(socket); socket.on('error', () => {});
        socket.once('close', () => sockets.delete(socket));
      }
    });
    const port = await listen(proxy);
    const tunnel = { running: true, port };
    const transport = new ProtectedTransport(tunnel);
    const wrapped = protectProvider(provider, transport);
    const model = { ...provider.getModels()[0], baseUrl: `http://127.0.0.1:${targetPort}` };
    const transcript = { messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }], timestamp: Date.now() }] };
    const options = { apiKey: provider.id === 'openai-codex' ? codexKey : 'synthetic-key', maxRetries: 0, timeoutMs: 3000 };
    try {
      assert.equal((await wrapped.streamSimple(model, transcript, options).result()).stopReason, 'error');
      assert.ok(connects > 0);
      success = true;
      const completed = await wrapped.streamSimple(model, transcript, options).result();
      assert.equal(completed.stopReason, 'stop');
      assert.equal(completed.content.filter(c => c.type === 'text').map(c => c.text).join(''), 'hello');
      streaming = true;
      const requestReceived = new Promise(resolve => { received = resolve; });
      const stream = wrapped.streamSimple(model, transcript, options);
      await requestReceived;
      transport.invalidate();
      const result = await stream.result();
      assert.ok(['aborted', 'error'].includes(result.stopReason));
      tunnel.running = false;
      const count = connects;
      assert.throws(() => wrapped.streamSimple(model, transcript, options), /VPN required/);
      assert.equal(connects, count);
    } finally {
      transport.invalidate();
      for (const socket of sockets) socket.destroy();
      origin.closeAllConnections();
      await Promise.all([new Promise(resolve => origin.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    }
  });
}
