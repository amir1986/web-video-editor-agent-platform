import os, json, anthropic

api_key     = os.environ['ANTHROPIC_API_KEY']
instruction = os.environ['TASK_INSTRUCTION']

# Strip the /ai-run prefix from the comment
task = instruction.replace('/ai-run', '').strip()

client = anthropic.Anthropic(api_key=api_key)
message = client.messages.create(
    model='claude-opus-4-6',
    max_tokens=2048,
    messages=[{
        'role': 'user',
        'content': f'''You are a coding assistant. The user wants to: {task}
        Generate the necessary file content and save it.
        Respond ONLY with a JSON object like:
        {{"filename": "path/to/file.md", "content": "file content here"}}'''
    }]
)

result = json.loads(message.content[0].text)

# Write the file to the repo
os.makedirs(os.path.dirname(result['filename']), exist_ok=True)
with open(result['filename'], 'w') as f:
    f.write(result['content'])

print(f"Created file: {result['filename']}")
