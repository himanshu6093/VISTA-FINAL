"""List Gemini models available on this key. Run from repo root: python tools/list-gemini-models.py"""
import json
import urllib.request

key = ''
with open('server/.env', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if line.startswith('GOOGLE_API_KEY='):
            key = line.split('=', 1)[1].strip().strip('"').strip("'")
assert key, 'no key in server/.env'
url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + key
with urllib.request.urlopen(url, timeout=30) as r:
    data = json.load(r)
for m in data.get('models', []):
    methods = m.get('supportedGenerationMethods', [])
    if 'generateContent' in methods:
        print(m['name'].replace('models/', ''), '| inputTokens:', m.get('inputTokenLimit'))
