/**
 * Voice Gateway — browser → Groq Whisper STT → Groq LLM (with session history) → browser TTS
 *
 * POST /voice — receives audio + sessionId, returns { text, replyText, sessionId }
 * GET  /      — serves PWA HTML
 */

import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';

const PORT = parseInt(process.env.PORT || '3000');
const ROOT = '/workspace/agent';

const SYSTEM_PROMPT = 'אתה עוזר אישי עברי בשם ננו. עונה בקצרה בעברית. המשתמש הוא דן-אל.';
const MAX_HISTORY = 20; // per-session message cap (10 turns)

const sessions = new Map(); // sessionId → messages[]

function getHistory(sessionId) {
  if (!sessions.has(sessionId)) sessions.set(sessionId, []);
  return sessions.get(sessionId);
}

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
  return (await res.json()).text?.trim() || '';
}

async function synthesizeGoogle(text) {
  const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-goog-api-key': 'onecli-managed',
    },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'he-IL', name: 'he-IL-Chirp3-HD-Aoede' },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });
  if (!res.ok) throw new Error(`Google TTS ${res.status}: ${await res.text()}`);
  return (await res.json()).audioContent; // base64 MP3
}

async function askGroq(sessionId, userText) {
  const history = getHistory(sessionId);
  history.push({ role: 'user', content: userText });
  while (history.length > MAX_HISTORY) history.shift();

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
        ...history,
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq LLM ${res.status}: ${await res.text()}`);
  const reply = (await res.json()).choices?.[0]?.message?.content?.trim() || '';
  history.push({ role: 'assistant', content: reply });
  return reply;
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

        const sessionId = form.get('sessionId') || randomUUID();
        const audioBuffer = await audioFile.arrayBuffer();
        const mimeType = audioFile.type || 'audio/webm';

        const text = await transcribeGroq(audioBuffer, mimeType);
        if (!text) return Response.json({ error: 'Could not transcribe audio' }, { status: 422 });
        console.log(`[STT][${sessionId.slice(0,8)}] "${text}"`);

        const replyText = await askGroq(sessionId, text);
        console.log(`[LLM][${sessionId.slice(0,8)}] "${replyText}"`);

        const audioContent = await synthesizeGoogle(replyText);
        return Response.json({ text, replyText, sessionId, audioContent });
      } catch (e) {
        console.error('[/voice error]', e.message);
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`Voice Gateway on http://localhost:${PORT}`);
