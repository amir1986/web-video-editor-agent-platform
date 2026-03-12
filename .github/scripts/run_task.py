import os, json, urllib.request

ollama_url = os.environ.get('OLLAMA_URL', 'http://localhost:11434')
instruction = os.environ['TASK_INSTRUCTION']

# Strip the /ai-run prefix from the comment
task = instruction.replace('/ai-run', '').strip()

payload = json.dumps({
    'model': os.environ.get('OLLAMA_MODEL', 'qwen2.5:7b'),
    'messages': [{
        'role': 'user',
        'content': f'''You are a coding assistant. The user wants to: {task}
        Generate the necessary file content and save it.
        Respond ONLY with a JSON object like:
        {{"filename": "path/to/file.md", "content": "file content here"}}'''
    }],
    'stream': False,
}).encode()

req = urllib.request.Request(
    f'{ollama_url}/v1/chat/completions',
    data=payload,
    headers={'Content-Type': 'application/json'},
)
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read())

text = data['choices'][0]['message']['content']
# Extract JSON from response
import re
match = re.search(r'\{[\s\S]*\}', text)
if not match:
    raise ValueError(f'No JSON found in response: {text[:300]}')
result = json.loads(match.group())

# Write the file to the repo
os.makedirs(os.path.dirname(result['filename']), exist_ok=True)
with open(result['filename'], 'w') as f:
    f.write(result['content'])

print(f"Created file: {result['filename']}")
