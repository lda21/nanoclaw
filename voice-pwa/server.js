/**
 * Voice Gateway — audio pipeline: browser → Groq Whisper STT → Groq LLM → browser TTS
 *
 * POST /voice — receives audio blob, returns { text, replyText }
 * GET  /      — serves PWA HTML
 */

import { readFileSync } from 'fs';

const PORT = parseInt(process.env.PORT || '3000');
const ROOT = '/workspace/agent';

const SYSTEM_PROMPT = 'אתה עוזר אישי עברי בשם ננו. עונה בקצרה בעברית. המשתמש הוא דן-אל.';

async function transcribeGroq(audioBuffer, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), 'audio.webm');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'he');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer onecli-managed' },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq STT ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.text?.trim() || '';
}

async function askGroq(userText) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer onecli-managed',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq LLM ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

const srv = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/voice')) {
      return new Response(readFileSync(`${ROOT}/index.html`), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
      });
    }
    if (method === 'GET' && url.pathname === '/sw.js') {
      return new Response(readFileSync(`${ROOT}/sw.js`), {
        headers: { 'Content-Type': 'application/javascript' },
      });
    }
    if (method === 'GET' && url.pathname === '/manifest.json') {
      return new Response(readFileSync(`${ROOT}/manifest.json`), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'POST' && url.pathname === '/voice') {
      try {
        const form = await req.formData();
        const audioFile = form.get('audio');
        if (!audioFile) return Response.json({ error: 'No audio field' }, { status: 400 });

        const audioBuffer = await audioFile.arrayBuffer();
        const mimeType = audioFile.type || 'audio/webm';

        const text = await transcribeGroq(audioBuffer, mimeType);
        if (!text) return Response.json({ error: 'Could not transcribe audio' }, { status: 422 });
        console.log(`[STT] "${text}"`);

        const replyText = await askGroq(text);
        console.log(`[LLM] "${replyText}"`);

        return Response.json({ text, replyText });
      } catch (e) {
        console.error('[/voice error]', e.message);
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`Voice Gateway on http://localhost:${PORT}`);
