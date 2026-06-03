from aiohttp import web
import edge_tts, tempfile, os

async def tts(request):
    text = request.query.get('text', '')
    voice = request.query.get('voice', 'he-IL-HilaNeural')
    if not text:
        raise web.HTTPBadRequest(reason='missing text')
    with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as f:
        path = f.name
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(path)
    with open(path, 'rb') as f:
        data = f.read()
    os.unlink(path)
    return web.Response(body=data, content_type='audio/mpeg')

app = web.Application()
app.router.add_get('/tts', tts)
web.run_app(app, port=5000)
