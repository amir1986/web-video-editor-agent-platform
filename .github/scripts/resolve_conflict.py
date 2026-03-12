import os, json, urllib.request

ollama_url = os.environ.get('OLLAMA_URL', 'http://localhost:11434')
gh_token   = os.environ['GITHUB_TOKEN']
pr_number  = os.environ['PR_NUMBER']
repo       = os.environ['REPO']

# Read the conflict file content
with open('conflict_files.txt', 'r') as f:
    conflict_content = f.read()

# Ask Qwen to suggest a resolution
payload = json.dumps({
    'model': os.environ.get('OLLAMA_MODEL', 'qwen2.5:7b'),
    'messages': [{
        'role': 'user',
        'content': f'''These files have merge conflicts (shown by <<<<<<, =======, >>>>>>>).
        For each conflict, suggest the best way to resolve it and explain why.

        CONFLICTED FILES:
        {conflict_content[:6000]}'''
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

suggestion = data['choices'][0]['message']['content']

# Post suggestion as PR comment
url = f'https://api.github.com/repos/{repo}/issues/{pr_number}/comments'
comment_req = urllib.request.Request(
    url,
    data=json.dumps({'body': f'## Merge Conflict Detected\n\n**AI Suggests:**\n\n{suggestion}'}).encode(),
    headers={'Authorization': f'token {gh_token}', 'Content-Type': 'application/json'},
)
urllib.request.urlopen(comment_req)
print('Conflict resolution posted!')
