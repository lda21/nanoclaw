import { describe, it, expect } from 'vitest';

import { buildMediaMessage, mediaAcceptsCaption } from './whatsapp.js';

const data = Buffer.from('fake-media-bytes');

describe('buildMediaMessage', () => {
  it('sends .ogg as a push-to-talk voice note (opus + ptt)', () => {
    const msg = buildMediaMessage(data, 'hello.ogg', '.ogg', 'ignored caption');
    expect(msg.audio).toBe(data);
    expect(msg.ptt).toBe(true);
    expect(msg.mimetype).toBe('audio/ogg; codecs=opus');
    // Audio messages never carry a caption.
    expect(msg.caption).toBeUndefined();
    expect(msg.document).toBeUndefined();
  });

  it('sends .opus as a push-to-talk voice note', () => {
    const msg = buildMediaMessage(data, 'note.opus', '.opus');
    expect(msg.audio).toBe(data);
    expect(msg.ptt).toBe(true);
    expect(msg.mimetype).toBe('audio/ogg; codecs=opus');
  });

  it('sends .mp3 as a non-voice audio attachment (no ptt)', () => {
    const msg = buildMediaMessage(data, 'song.mp3', '.mp3');
    expect(msg.audio).toBe(data);
    expect(msg.ptt).toBeUndefined();
    expect(msg.mimetype).toBe('audio/mpeg');
  });

  it('sends an image with a caption', () => {
    const msg = buildMediaMessage(data, 'pic.jpg', '.jpg', 'hi');
    expect(msg.image).toBe(data);
    expect(msg.caption).toBe('hi');
    expect(msg.mimetype).toBe('image/jpeg');
  });

  it('falls back to a document for unknown types', () => {
    const msg = buildMediaMessage(data, 'report.xyz', '.xyz', 'cap');
    expect(msg.document).toBe(data);
    expect(msg.fileName).toBe('report.xyz');
    expect(msg.caption).toBe('cap');
  });
});

describe('mediaAcceptsCaption', () => {
  it('is false for audio/voice (caption would be dropped)', () => {
    expect(mediaAcceptsCaption('.ogg')).toBe(false);
    expect(mediaAcceptsCaption('.opus')).toBe(false);
    expect(mediaAcceptsCaption('.mp3')).toBe(false);
  });

  it('is true for caption-capable media', () => {
    expect(mediaAcceptsCaption('.jpg')).toBe(true);
    expect(mediaAcceptsCaption('.mp4')).toBe(true);
    expect(mediaAcceptsCaption('.pdf')).toBe(true);
  });
});
