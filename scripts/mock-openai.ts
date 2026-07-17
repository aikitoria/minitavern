// Minimal OpenAI-compatible mock for end-to-end testing: streams a canned
// response (with reasoning_content) token by token. Also mocks the ComfyUI
// API surface the image plugin uses (/prompt, /history, /view, /ws progress).
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 9800);

const LOREM =
  'Streaming works token by token, so latency stays low even through the relay. ' +
  'Branching, swiping and edits can all be exercised against this mock without a real model.';

// 1x1 transparent PNG.
const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let failuresRemaining = 0;
let terminalWithoutNewline = false;
let lastComfyWorkflow: unknown = null;
const comfyJobs = new Map<string, number>(); // prompt_id -> ready-at timestamp

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-large' }, { id: 'mock-small' }] }));
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/control/fail-next')) {
    const count = Number(new URL(req.url, 'http://mock').searchParams.get('count'));
    failuresRemaining = Number.isSafeInteger(count) && count > 0 ? count : 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ failuresRemaining }));
    return;
  }
  if (req.method === 'POST' && req.url === '/control/terminal-without-newline') {
    terminalWithoutNewline = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ terminalWithoutNewline }));
    return;
  }
  if (req.method === 'GET' && req.url === '/control/last-workflow') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ workflow: lastComfyWorkflow }));
    return;
  }
  if (req.method === 'POST' && req.url === '/prompt') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed: { prompt: unknown; client_id?: string };
      try {
        parsed = JSON.parse(body) as { prompt: unknown; client_id?: string };
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      lastComfyWorkflow = parsed.prompt;
      // uuid like real ComfyUI — a shared prefix would collide the server's
      // promptId-derived image filenames.
      const promptId = randomUUID();
      comfyJobs.set(promptId, Date.now() + 400);
      // Step progress over the ws, like ComfyUI's sampler events.
      setTimeout(() => {
        for (const client of wss.clients) {
          client.send(
            JSON.stringify({ type: 'progress', data: { value: 1, max: 2, prompt_id: promptId } }),
          );
          client.send(
            JSON.stringify({ type: 'progress', data: { value: 2, max: 2, prompt_id: promptId } }),
          );
        }
      }, 100);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: promptId }));
    });
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/history/')) {
    const promptId = req.url.slice('/history/'.length);
    const readyAt = comfyJobs.get(promptId);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (readyAt == null || Date.now() < readyAt) {
      res.end('{}');
      return;
    }
    res.end(
      JSON.stringify({
        [promptId]: {
          status: { status_str: 'success', completed: true },
          outputs: {
            '9': { images: [{ filename: 'mock.png', subfolder: '', type: 'output' }] },
          },
        },
      }),
    );
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/view')) {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(MOCK_PNG);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    console.log('[mock] POST /v1/chat/completions');
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      console.log('[mock] body received:', body.length, 'bytes');
      if (failuresRemaining > 0) {
        failuresRemaining--;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'controlled mock failure' }));
        return;
      }
      const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] };
      const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      const system = parsed.messages[0]?.role === 'system' ? parsed.messages[0].content : '';
      const text =
        `You said: **"${lastUser?.content ?? '(nothing)'}"** — reply #${Math.floor(Math.random() * 1000)}.\n\n` +
        (system ? `> system: ${system.replaceAll('\n', ' · ')}\n\n` : '') +
        `${LOREM}\n\n\`\`\`js\nconsole.log('hello from the mock');\n\`\`\``;
      const words = text.split(/(?<=\s)/);
      const reasoning =
        'Thinking about the request… composing a demo answer with markdown and code. '.split(
          /(?<=\s)/,
        );
      let ri = 0;
      let wi = 0;
      const timer = setInterval(() => {
        if (ri < reasoning.length) {
          send({ choices: [{ delta: { reasoning_content: reasoning[ri++] } }] });
        } else if (wi < words.length) {
          send({ choices: [{ delta: { content: words[wi++] } }] });
        } else {
          if (terminalWithoutNewline) {
            terminalWithoutNewline = false;
            res.end(
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'TERMINAL_NO_NEWLINE' } }] })}`,
            );
            clearInterval(timer);
            return;
          }
          send({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 42, completion_tokens: words.length },
          });
          res.write('data: [DONE]\n\n');
          res.end();
          clearInterval(timer);
        }
      }, 15);
      // 'close' on req fires once the body is consumed; the response signals disconnects.
      res.on('close', () => clearInterval(timer));
    });
    return;
  }
  res.writeHead(404).end();
});

// ComfyUI-style progress socket (any path; the real one uses /ws?clientId=…).
const wss = new WebSocketServer({ server });

server.listen(PORT, () => console.log(`mock openai listening on :${PORT}`));
