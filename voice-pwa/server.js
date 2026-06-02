/**
 * Voice Gateway — audio pipeline: browser → Groq Whisper → Claude → edge-tts → browser
 *
 * POST /voice    — receives audio blob → returns { text, replyText, audioUrl }
 * GET  /audio/:f — serves generated MP3s
 * GET  /         — PWA HTML
 */

import { readFileSync, mkdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { join } from 'path';

const execAsync = promisify(exec);
const PORT = parseInt(process.env.PORT || '3000');
const AUDIO_DIR = '/tmp/voice-audio';
const ROOT = '/workspace/agent';

mkdirSync(AUDIO_DIR, { recursive: true });

const SYSTEM_PROMPT = `You are Nano, a Hebrew-speaking AI assistant for Danel (דן-אל).
Respond concisely in Hebrew. You are his personal assistant with access to his team.
Keep answers short — this is a voice interface.`;

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
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.text?.trim() || '';
}

async function askClaude(userText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'onecli-managed',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '';
}

async function generateTTS(text) {
  const filename = `${randomUUID()}.mp3`;
  const filepath = join(AUDIO_DIR, filename);
  // Pass text via env to avoid shell injection
  await execAsync(
    `python3 -m edge_tts --voice he-IL-HilaNeural --text "$TTS_TEXT" --write-media "${filepath}"`,
    { env: { ...process.env, TTS_TEXT: text } }
  );
  return filename;
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

    // Serve generated audio files
    if (method === 'GET' && url.pathname.startsWith('/audio/')) {
      const filename = url.pathname.slice(7);
      if (!/^[\w-]+\.mp3$/.test(filename)) return new Response('Forbidden', { status: 403 });
      try {
        return new Response(readFileSync(join(AUDIO_DIR, filename)), {
          headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'max-age=3600' },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }

    // Main pipeline: audio blob → Groq STT → Claude → edge-tts → JSON
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

        const replyText = await askClaude(text);
        console.log(`[Claude] "${replyText}"`);

        const audioFilename = await generateTTS(replyText);
        const audioUrl = `/audio/${audioFilename}`;
        console.log(`[TTS] ${audioUrl}`);

        return Response.json({ text, replyText, audioUrl });
      } catch (e) {
        console.error('[/voice error]', e.message);
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`Voice Gateway on http://localhost:${PORT}`);
