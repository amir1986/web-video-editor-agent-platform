import os, json, urllib.request

# Get environment variables
ollama_url = os.environ.get('OLLAMA_URL', 'http://localhost:11434')
gh_token   = os.environ['GITHUB_TOKEN']
pr_number  = os.environ['PR_NUMBER']
repo       = os.environ['REPO']

# Fetch the PR diff from GitHub
req = urllib.request.Request(
    f'https://api.github.com/repos/{repo}/pulls/{pr_number}',
    headers={'Authorization': f'token {gh_token}', 'Accept': 'application/vnd.github.diff'},
)
with urllib.request.urlopen(req) as resp:
    diff = resp.read().decode()

# Send diff to Qwen for review
payload = json.dumps({
    'model': os.environ.get('OLLAMA_MODEL', 'qwen2.5:7b'),
    'messages': [{
        'role': 'user',
        'content': f'''Review this pull request diff. Check for:
        - Security issues or vulnerabilities
        - Missing error handling
        - Missing tests
        - Code quality issues
        Be concise and constructive.

        DIFF:
        {diff[:8000]}'''
    }],
    'stream': False,
}).encode()

req2 = urllib.request.Request(
    f'{ollama_url}/v1/chat/completions',
    data=payload,
    headers={'Content-Type': 'application/json'},
)
with urllib.request.urlopen(req2) as resp:
    data = json.loads(resp.read())

review_text = data['choices'][0]['message']['content']

# Post the review as a comment on the PR
comment_url = f'https://api.github.com/repos/{repo}/issues/{pr_number}/comments'
comment_req = urllib.request.Request(
    comment_url,
    data=json.dumps({'body': f'## AI Review\n\n{review_text}'}).encode(),
    headers={'Authorization': f'token {gh_token}', 'Content-Type': 'application/json'},
)
urllib.request.urlopen(comment_req)
print('Review posted successfully!')
